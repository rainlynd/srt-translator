const OpenAI = require('openai');
const { encode } = require('gpt-tokenizer');

// Store the initialized model instance to reuse
let deepseekAI;
const modelInstances = { primary: null, retry: null };

/**
 * Initializes the DeepSeek client from the OpenAI SDK.
 * @param {string} apiKey - The DeepSeek API key.
 * @param {string} baseUrl - The base URL for the DeepSeek API.
 */
function initializeDeepSeekModel(apiKey, baseUrl, modelName = 'deepseek-chat', modelAlias = 'primary') {
  if (!apiKey) {
    throw new Error('API key is required to initialize DeepSeek model.');
  }
  try {
    // Always create a new instance if the baseUrl or apiKey might have changed.
    // A more sophisticated check could compare old vs new values.
    deepseekAI = new OpenAI({
      apiKey: apiKey,
      baseURL: baseUrl || 'https://api.deepseek.com',
    });
    modelInstances[modelAlias] = modelName;
    console.log(`DeepSeek model "${modelName}" initialized for alias '${modelAlias}'.`);
  } catch (error) {
    console.error('Failed to initialize DeepSeek client:', error);
    deepseekAI = null;
    throw error;
  }
}

/**
 * Checks if the DeepSeek client has been initialized.
 * @returns {boolean} - True if initialized, false otherwise.
 */
function isInitialized(modelAlias = 'primary') {
  return !!deepseekAI && !!modelInstances[modelAlias];
}

async function translateChunk(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, temperature, topP, numberOfEntriesInChunk, abortSignal = null, previousChunkContext = null, nextChunkContext = null, thinkingBudget = -1, modelAlias = 'primary', sourceLanguageNameForPrompt) {
    const modelName = modelInstances[modelAlias];
    if (!isInitialized(modelAlias)) {
        throw new Error(`DeepSeek client or model for alias '${modelAlias}' not initialized. Call initializeDeepSeekModel first.`);
    }
    if (!Array.isArray(chunkOfOriginalTexts) || chunkOfOriginalTexts.length === 0) {
        return { translatedResponseArray: [], actualInputTokens: 0, outputTokens: 0 };
    }

    let processedSystemPrompt = systemPromptTemplate.replace(/{lang}/g, targetLanguage);
    const srcReplacementValue = (sourceLanguageNameForPrompt && sourceLanguageNameForPrompt.trim() !== "") ? sourceLanguageNameForPrompt : "undefined";
    processedSystemPrompt = processedSystemPrompt.replace(/{src}/g, srcReplacementValue);

    // DeepSeek-specific prompt modification
    processedSystemPrompt = processedSystemPrompt.replace(
        'Your response MUST be a single array of JSON objects, each containing two properties:',
        'Your response MUST be a single JSON object. This object must contain a single key named "translations", which holds an array of JSON objects. Each object in the array must contain two properties:'
    );
    processedSystemPrompt = processedSystemPrompt.replace(
        /\[\s*{\s*"index": 1,[\s\S]*?}]\s*`{3}/,
        `{
  "translations": [
    {
      "index": 1,
      "text": "Translated text for segment 1"
    },
    {
      "index": 2,
      "text": "Translated text for segment 2"
    }
  ]
}\`\`\``
    );
    processedSystemPrompt = processedSystemPrompt.replace(
        'Your response array MUST be the same length with the number of text segments in <input>.',
        'The "translations" array MUST be the same length with the number of text segments in <input>.'
    );


    const messages = [{ role: 'system', content: processedSystemPrompt }];

    let userPrompt = "";
    if (previousChunkContext && previousChunkContext.trim() !== "") {
        userPrompt += `<previous_texts>\n${previousChunkContext.trim()}\n</previous_texts>\n\n`;
    }

    // Debug: show whether nextChunkContext provided before first mention
    console.debug(`[DeepSeek translateChunk] Contexts - previousChunkContext: ${previousChunkContext ? 'yes' : 'no'}, nextChunkContext: ${nextChunkContext ? 'yes' : 'no'}`);

    userPrompt += `Translate all ${numberOfEntriesInChunk} text segments in <input> section from {src} to {lang}.\n\n`;
    userPrompt = userPrompt.replace(/{lang}/g, targetLanguage).replace(/{src}/g, srcReplacementValue);

    let textsForUserPromptContent = "";
    chunkOfOriginalTexts.forEach((text, index) => {
        textsForUserPromptContent += `${index + 1}. ${text}\n`;
    });

    if (textsForUserPromptContent.endsWith('\n')) {
        textsForUserPromptContent = textsForUserPromptContent.slice(0, -1);
    }
    
    userPrompt += `<input>\n${textsForUserPromptContent}\n</input>`;
    
    // Ensure a single upcoming_texts block immediately after input
    if (nextChunkContext && nextChunkContext.trim() !== "") {
        userPrompt += `\n\n<upcoming_texts>\n${nextChunkContext.trim()}\n</upcoming_texts>\n\n`;
    }
    
    messages.push({ role: 'user', content: userPrompt });

    console.debug(`[DeepSeek Request] Model Alias: ${modelAlias}`);
    console.debug(`[DeepSeek Request] System Prompt:\n${processedSystemPrompt}`);
    console.debug(`[DeepSeek Request] User Input:\n${userPrompt}`);

    try {
        const response = await deepseekAI.chat.completions.create({
            model: modelName,
            messages: messages,
            temperature: temperature,
            top_p: topP,
            max_tokens: 65536,
            response_format: { type: 'json_object' },
        }, { signal: abortSignal });

        const parsedResponse = JSON.parse(response.choices[0].message.content);
        const translatedResponseArray = parsedResponse.translations || [];
        const actualInputTokens = response.usage.prompt_tokens;
        const outputTokens = response.usage.completion_tokens;

        return { translatedResponseArray, actualInputTokens, outputTokens };
    } catch (error) {
        console.error('Error calling DeepSeek API or processing its response:', error);
        throw error;
    }
}

async function summarizeAndExtractTermsChunk(textChunk, summarySystemPrompt, geminiSettings, targetLanguageFullName, modelAlias = 'primary', abortSignal = null, previousChunkContext = null, upcomingChunkContext = null) {
    const modelName = modelInstances[modelAlias];
    if (!isInitialized(modelAlias)) {
        throw new Error(`DeepSeek client or model for alias '${modelAlias}' not initialized.`);
    }
    if (typeof textChunk !== 'string' || textChunk.trim() === '') {
        return { summaryResponse: { theme: "", terms: [] }, actualInputTokens: 0, outputTokens: 0 };
    }

    let contextPrompt = "";
    if (previousChunkContext) {
        contextPrompt += `<previous_texts>\n${previousChunkContext}\n</previous_texts>\n\n`;
    }
    const reminderMessageTemplate = "Analyze the subtitles within <summarize_request> section, then extract and translate the theme and up to 50 important names/terminologies in {lang}.\n\n";
    const formattedReminderMessage = reminderMessageTemplate.replace(/{lang}/g, targetLanguageFullName || "the target language");
    const wrappedTextChunk = `<summarize_request>\n${textChunk}\n</summarize_request>`;
    // Place upcoming_texts immediately after summarize_request
    let afterSummarizeBlock = "";
    if (upcomingChunkContext) {
        afterSummarizeBlock = `\n\n<upcoming_texts>\n${upcomingChunkContext}\n</upcoming_texts>\n\n`;
    }
    const finalUserPromptContent = contextPrompt + formattedReminderMessage + wrappedTextChunk + afterSummarizeBlock;

    const messages = [
        { role: 'system', content: summarySystemPrompt },
        { role: 'user', content: finalUserPromptContent }
    ];

    console.debug(`[DeepSeek Summarize Request] Model Alias: ${modelAlias}`);
    console.debug(`[DeepSeek Summarize Request] System Prompt (Unchanged by this function):\n${summarySystemPrompt}`);
    console.debug(`[DeepSeek Summarize Request] Modified User Input:\n${finalUserPromptContent}`);

    try {
        // Coerce/validate parameters to avoid provider 400s
        const safeTemperature = (typeof geminiSettings.temperature === 'number' && geminiSettings.temperature >= 0 && geminiSettings.temperature <= 2)
          ? geminiSettings.temperature
          : 0.2;
        const safeTopP = (typeof geminiSettings.topP === 'number' && geminiSettings.topP > 0 && geminiSettings.topP <= 1)
          ? geminiSettings.topP
          : 0.95;

        console.debug(`[DeepSeek Summarize] Model: ${modelName} (alias: ${modelAlias})`);
        console.debug(`[DeepSeek Summarize] Using response_format: json_object`);
        console.debug(`[DeepSeek Summarize] temperature: ${safeTemperature} (from: ${geminiSettings.temperature}), top_p: ${safeTopP} (from: ${geminiSettings.topP})`);

        const response = await deepseekAI.chat.completions.create({
            model: modelName,
            messages: messages,
            temperature: safeTemperature,
            top_p: safeTopP,
            // Provider does not support json_schema on chat.completions; use json_object for structured output
            response_format: { type: 'json_object' },
        }, { signal: abortSignal });

        // Parse and validate content
        let summaryResponse;
        try {
            summaryResponse = JSON.parse(response.choices?.[0]?.message?.content || '{}');
        } catch (e) {
            const err = new Error(`Failed to parse DeepSeek summarization JSON: ${e.message}`);
            err.isApiError = true;
            err.finishReason = 'BAD_SUMMARY_JSON_RESPONSE';
            throw err;
        }

        // Minimal schema validation mirroring Gemini
        const valid =
            typeof summaryResponse === 'object' && summaryResponse !== null &&
            typeof summaryResponse.theme === 'string' && summaryResponse.theme.trim() !== '' &&
            Array.isArray(summaryResponse.terms) &&
            summaryResponse.terms.every(term =>
                typeof term === 'object' && term !== null &&
                typeof term.src === 'string' && term.src.trim() !== '' &&
                typeof term.tgt === 'string' && term.tgt.trim() !== '' &&
                typeof term.note === 'string' && term.note.trim() !== ''
            );

        if (!valid) {
            const err = new Error('DeepSeek summarization response failed schema validation.');
            err.isApiError = true;
            err.finishReason = 'BAD_SUMMARY_SCHEMA_RESPONSE';
            throw err;
        }

        const actualInputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;

        return { summaryResponse, actualInputTokens, outputTokens };
    } catch (error) {
        console.error('Error calling DeepSeek API for summarization:', error);

        // Map rate limit if detectable via SDK error
        if (error?.status === 429 || error?.code === 429) {
            error.isApiError = true;
            error.finishReason = 'RATE_LIMIT';
            // Try to read Retry-After header if present
            const retryAfter = error?.response?.headers?.['retry-after'];
            if (retryAfter) {
                const seconds = parseInt(retryAfter, 10);
                if (!Number.isNaN(seconds) && seconds > 0) {
                    error.retryDelayMs = seconds * 1000;
                }
            }
        }

        if (!error.isApiError) {
            error.isApiError = true;
            error.finishReason = error.finishReason || 'SUMMARY_UNKNOWN_ERROR';
        }
        throw error;
    }
}

async function estimateInputTokensForTranslation(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, numberOfEntriesInChunk, previousChunkContext = null, nextChunkContext = null, modelAlias = 'primary', sourceLanguageNameForPrompt) {
    if (!isInitialized(modelAlias)) {
        throw new Error(`DeepSeek client or model for alias '${modelAlias}' not initialized.`);
    }

    let processedSystemPrompt = systemPromptTemplate.replace(/{lang}/g, targetLanguage);
    const srcReplacementValue = (sourceLanguageNameForPrompt && sourceLanguageNameForPrompt.trim() !== "") ? sourceLanguageNameForPrompt : "undefined";
    processedSystemPrompt = processedSystemPrompt.replace(/{src}/g, srcReplacementValue);

    let combinedPromptPrefix = "";
    if (previousChunkContext && previousChunkContext.trim() !== "") {
        combinedPromptPrefix += `<previous_texts>\n${previousChunkContext.trim()}\n</previous_texts>\n\n`;
    }

    // Debug: token estimation contexts
    console.debug(`[DeepSeek estimateInputTokensForTranslation] Contexts - previousChunkContext: ${previousChunkContext ? 'yes' : 'no'}, nextChunkContext: ${nextChunkContext ? 'yes' : 'no'}`);
    // Do not put upcoming_texts before input; it will be placed right after input below

    let entryReminderItself = "";
    if (typeof numberOfEntriesInChunk === 'number' && numberOfEntriesInChunk > 0) {
        entryReminderItself = `Translate all ${numberOfEntriesInChunk} text segments in <input> section from {src} to {lang}.\n\n`;
        entryReminderItself = entryReminderItself.replace(/{lang}/g, targetLanguage);
        entryReminderItself = entryReminderItself.replace(/{src}/g, srcReplacementValue);
    }
    combinedPromptPrefix += entryReminderItself;

    let textsForUserPromptForEstimationContent = "";
    chunkOfOriginalTexts.forEach((text, index) => {
        textsForUserPromptForEstimationContent += `${index + 1}. ${text}\n`;
    });

    if (textsForUserPromptForEstimationContent.endsWith('\n')) {
        textsForUserPromptForEstimationContent = textsForUserPromptForEstimationContent.slice(0, -1);
    }

    let wrappedTextsPart = "";
    if (textsForUserPromptForEstimationContent) {
        wrappedTextsPart = `<input>\n${textsForUserPromptForEstimationContent}\n</input>`;
    }
    
    let finalUserPromptForEstimation = combinedPromptPrefix + wrappedTextsPart;
    
    // Add upcoming_texts after the input block for token estimation
    if (nextChunkContext && nextChunkContext.trim() !== "") {
        finalUserPromptForEstimation += `\n\n<upcoming_texts>\n${nextChunkContext.trim()}\n</upcoming_texts>\n\n`;
    }

    const systemTokens = await countTokens(processedSystemPrompt);
    const userTokens = await countTokens(finalUserPromptForEstimation);
    
    return userTokens + systemTokens;
}

async function estimateInputTokensForSummarization(textChunk, summarySystemPrompt, targetLanguageFullName, modelAlias = 'primary', previousChunkContext = null, upcomingChunkContext = null) {
    if (!isInitialized(modelAlias)) {
        throw new Error(`DeepSeek client or model for alias '${modelAlias}' not initialized.`);
    }
    if (typeof textChunk !== 'string' || textChunk.trim() === '') {
        return 0;
    }

    let contextPrompt = "";
    if (previousChunkContext) {
        contextPrompt += `<previous_texts>\n${previousChunkContext}\n</previous_texts>\n\n`;
    }

    const reminderMessageTemplate = "Analyze the subtitles within <summarize_request> section, then extract and translate the theme and up to 50 important names/terminologies in {lang}.\n\n";
    const formattedReminderMessage = reminderMessageTemplate.replace(/{lang}/g, targetLanguageFullName || "the target language");
    const wrappedTextChunk = `<summarize_request>\n${textChunk}\n</summarize_request>`;
    // Place upcoming_texts immediately after summarize_request for estimation too
    let afterSummarizeBlock = "";
    if (upcomingChunkContext) {
        afterSummarizeBlock = `\n\n<upcoming_texts>\n${upcomingChunkContext}\n</upcoming_texts>\n\n`;
    }
    const finalUserPromptContent = contextPrompt + formattedReminderMessage + wrappedTextChunk + afterSummarizeBlock;

    const systemTokens = await countTokens(summarySystemPrompt);
    const userTokens = await countTokens(finalUserPromptContent);
    
    return systemTokens + userTokens;
}

async function countTokens(text, modelAlias = 'primary') {
  if (typeof text !== 'string' || !text.trim()) {
    return 0;
  }
  try {
    const tokens = encode(text);
    return tokens.length;
  } catch (error) {
    console.error('Error counting tokens with gpt-tokenizer:', error);
    // Fallback to rough estimation if tokenizer fails
    return Math.ceil(text.length / 4);
  }
}

module.exports = {
  initializeDeepSeekModel,
  isInitialized,
  translateChunk,
  summarizeAndExtractTermsChunk,
  countTokens,
  estimateInputTokensForTranslation,
  estimateInputTokensForSummarization,
};
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

async function translateChunk(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, temperature, topP, numberOfEntriesInChunk, abortSignal = null, previousChunkContext = null, thinkingBudget = -1, modelAlias = 'primary', sourceLanguageNameForPrompt, upcomingChunkContext = null) {
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

    if (upcomingChunkContext) {
        userPrompt += `<upcoming_texts>\n${upcomingChunkContext.trim()}\n</upcoming_texts>\n\n`;
    }

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
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'translations',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            translations: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        index: {
                                            type: 'integer'
                                        },
                                        text: {
                                            type: 'string'
                                        }
                                    },
                                    required: ['index', 'text']
                                }
                            }
                        },
                        required: ['translations']
                    }
                }
            },
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
    if (upcomingChunkContext) {
        contextPrompt += `<upcoming_texts>\n${upcomingChunkContext}\n</upcoming_texts>\n\n`;
    }

    const reminderMessageTemplate = "Analyze the subtitles within <summarize_request> section, then extract and translate the theme and up to 50 important names/terminologies in {lang}.\n\n";
    const formattedReminderMessage = reminderMessageTemplate.replace(/{lang}/g, targetLanguageFullName || "the target language");
    const wrappedTextChunk = `<summarize_request>\n${textChunk}\n</summarize_request>`;
    const finalUserPromptContent = contextPrompt + formattedReminderMessage + wrappedTextChunk;

    const messages = [
        { role: 'system', content: summarySystemPrompt },
        { role: 'user', content: finalUserPromptContent }
    ];

    console.debug(`[DeepSeek Summarize Request] Model Alias: ${modelAlias}`);
    console.debug(`[DeepSeek Summarize Request] System Prompt (Unchanged by this function):\n${summarySystemPrompt}`);
    console.debug(`[DeepSeek Summarize Request] Modified User Input:\n${finalUserPromptContent}`);

    try {
        const response = await deepseekAI.chat.completions.create({
            model: modelName,
            messages: messages,
            temperature: geminiSettings.temperature,
            top_p: geminiSettings.topP,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'summarization',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            theme: {
                                type: 'string'
                            },
                            terms: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        src: {
                                            type: 'string'
                                        },
                                        tgt: {
                                            type: 'string'
                                        },
                                        note: {
                                            type: 'string'
                                        }
                                    },
                                    required: ['src', 'tgt', 'note']
                                }
                            }
                        },
                        required: ['theme', 'terms']
                    }
                }
            },
        }, { signal: abortSignal });

        const summaryResponse = JSON.parse(response.choices[0].message.content);
        const actualInputTokens = response.usage.prompt_tokens;
        const outputTokens = response.usage.completion_tokens;

        return { summaryResponse, actualInputTokens, outputTokens };
    } catch (error) {
        console.error('Error calling DeepSeek API for summarization:', error);
        throw error;
    }
}

async function estimateInputTokensForTranslation(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, numberOfEntriesInChunk, previousChunkContext = null, modelAlias = 'primary', sourceLanguageNameForPrompt, upcomingChunkContext = null) {
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

    if (upcomingChunkContext) {
        combinedPromptPrefix += `<upcoming_texts>\n${upcomingChunkContext.trim()}\n</upcoming_texts>\n\n`;
    }

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
    
    const finalUserPromptForEstimation = combinedPromptPrefix + wrappedTextsPart;

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
    if (upcomingChunkContext) {
        contextPrompt += `<upcoming_texts>\n${upcomingChunkContext}\n</upcoming_texts>\n\n`;
    }

    const reminderMessageTemplate = "Analyze the subtitles within <summarize_request> section, then extract and translate the theme and up to 50 important names/terminologies in {lang}.\n\n";
    const formattedReminderMessage = reminderMessageTemplate.replace(/{lang}/g, targetLanguageFullName || "the target language");
    const wrappedTextChunk = `<summarize_request>\n${textChunk}\n</summarize_request>`;
    const finalUserPromptContent = contextPrompt + formattedReminderMessage + wrappedTextChunk;

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
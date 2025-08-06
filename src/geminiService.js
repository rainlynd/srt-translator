const { GoogleGenAI } = require('@google/genai');

// Store the initialized model instance to reuse
let genAIInstance;
let modelInstances = { primary: null, retry: null }; // Modified

/**
 * Initializes the GenerativeModel from the SDK.
 * This can be called for different model aliases (e.g., 'primary', 'retry').
 * @param {string} apiKey - The Google AI API key.
 * @param {string} modelName - The name of the Gemini model to use.
 * @param {string} modelAlias - The alias for this model instance ('primary' or 'retry').
 */
function initializeGeminiModel(apiKey, modelName, modelAlias = 'primary') { // Modified
  if (!apiKey) {
    throw new Error('API key is required to initialize Gemini model.');
  }
  if (!modelName) {
    throw new Error(`Model name is required to initialize Gemini model for alias '${modelAlias}'.`); // Modified
  }
  if (!genAIInstance) { // Initialize genAIInstance only if it doesn't exist
    genAIInstance = new GoogleGenAI({ apiKey });
  }
  try {
    modelInstances[modelAlias] = modelName; // Store model name string
    console.log(`Gemini model "${modelName}" initialized for alias '${modelAlias}'.`); // Modified
  } catch (error) {
    console.error(`Failed to initialize Gemini model "${modelName}" for alias '${modelAlias}':`, error); // Modified
    modelInstances[modelAlias] = null; // Ensure it's null if initialization fails
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Checks if the Gemini model instance for a given alias has been initialized.
 * @param {string} modelAlias - The alias to check ('primary' or 'retry').
 * @returns {boolean} - True if initialized, false otherwise.
 */
function isInitialized(modelAlias = 'primary') { // Modified
  return !!genAIInstance && !!modelInstances[modelAlias] && typeof modelInstances[modelAlias] === 'string';
}

/**
 * Estimates the total input tokens for a given translation request.
 * @param {string[]} chunkOfOriginalTexts - An array of original text strings.
 * @param {string} targetLanguage - The target language for translation.
 * @param {string} systemPromptTemplate - The system prompt template.
 * @param {number} [numberOfEntriesInChunk] - Optional: The number of entries in this specific chunk.
 * @param {string} [previousChunkContext=null] - Optional: Concatenated string of the last few lines from the previous chunk.
 * @param {string} [nextChunkContext=null] - Optional: Concatenated string of the first few lines from the next chunk.
 * @param {string} [modelAlias='primary'] - Optional: The model alias to use for estimation.
 * @param {string} [sourceLanguageNameForPrompt] - Optional: The name/code of the source language for the {src} placeholder.
 * @returns {Promise<number>} - A promise that resolves to the estimated total input tokens.
 */
async function estimateInputTokensForTranslation(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, numberOfEntriesInChunk, previousChunkContext = null, nextChunkContext = null, modelAlias = 'primary', sourceLanguageNameForPrompt) {
  const modelName = modelInstances[modelAlias];
  if (!genAIInstance || !modelName) {
    throw new Error(`Gemini client or model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first for token estimation.`);
  }
  if (!Array.isArray(chunkOfOriginalTexts)) {
    // Allow empty chunk for estimation, it might still have a system prompt
    chunkOfOriginalTexts = [];
  }

  let processedSystemPrompt = systemPromptTemplate.replace(/{lang}/g, targetLanguage);
  const srcReplacementValue = (sourceLanguageNameForPrompt && sourceLanguageNameForPrompt.trim() !== "") ? sourceLanguageNameForPrompt : "undefined";
  processedSystemPrompt = processedSystemPrompt.replace(/{src}/g, srcReplacementValue);
  
  let combinedPromptPrefix = "";
  if (previousChunkContext && previousChunkContext.trim() !== "") {
      // previousChunkContext is already "Previous text segments:\nsegment1..."
      combinedPromptPrefix += `<previous_texts>\n${previousChunkContext.trim()}\n</previous_texts>\n\n`;
  }

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

  // Remove trailing newline from the content block before closing the tag
  if (textsForUserPromptForEstimationContent.endsWith('\n')) {
      textsForUserPromptForEstimationContent = textsForUserPromptForEstimationContent.slice(0, -1);
  }

  let wrappedTextsPart = "";
  if (textsForUserPromptForEstimationContent) { // Only add tag if there's content
      wrappedTextsPart = `<input>\n${textsForUserPromptForEstimationContent}\n</input>`;
  }
  
  let finalUserPromptForEstimation = combinedPromptPrefix + wrappedTextsPart;
  
  // Ensure a single upcoming_texts block immediately after input for token estimation
  if (nextChunkContext && nextChunkContext.trim() !== "") {
      finalUserPromptForEstimation += `\n\n<upcoming_texts>\n${nextChunkContext.trim()}\n</upcoming_texts>\n\n`;
  }

  let userTokens = 0;
  if (finalUserPromptForEstimation.trim()) { // Only count if there's actual user text
      const userTokenResult = await genAIInstance.models.countTokens({ model: modelName, contents: [{ role: "user", parts: [{ text: finalUserPromptForEstimation }] }] });
      userTokens = userTokenResult.totalTokens || 0;
  }

  let systemTokens = 0;
  if (processedSystemPrompt.trim()) { // Only count if there's actual system text
      const systemTokenResult = await genAIInstance.models.countTokens({ model: modelName, contents: [{ role: "system", parts: [{text: processedSystemPrompt}]}]});
      systemTokens = systemTokenResult.totalTokens || 0;
  }
  
  return userTokens + systemTokens;
}

/**
 * Counts the tokens for a given text string using a specified model.
 * @param {string} text - The text to count tokens for.
 * @param {string} [modelAlias='primary'] - The model alias (e.g., 'primary', 'retry') to use for token counting.
 * @returns {Promise<number>} - A promise that resolves to the number of tokens.
 * @throws {Error} if the model is not initialized or counting fails.
 */
async function estimateInputTokensForSummarization(textChunk, summarySystemPrompt, targetLanguageFullName, modelAlias = 'primary', previousChunkContext = null, upcomingChunkContext = null) {
  const modelName = modelInstances[modelAlias];
  if (!genAIInstance || !modelName) {
    throw new Error(`Gemini client or model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first for token estimation.`);
  }
  if (typeof textChunk !== 'string' || textChunk.trim() === '') {
    return 0;
  }

  let contextPrompt = "";
  if (previousChunkContext) {
    contextPrompt += `<previous_texts>\n${previousChunkContext}\n</previous_texts>\n\n`;
  }
  // Do not add upcoming_texts here for estimation; will be appended after summarize_request

  const reminderMessageTemplate = "Analyze the subtitles within <summarize_request> section, then extract and translate the theme and up to 50 important names/terminologies in {lang}.\n\n";
  const formattedReminderMessage = reminderMessageTemplate.replace(/{lang}/g, targetLanguageFullName || "the target language");
  const wrappedTextChunk = `<summarize_request>\n${textChunk}\n</summarize_request>`;
  // Place upcoming_texts immediately after summarize_request for estimation too
  let afterSummarizeBlock = "";
  if (upcomingChunkContext) {
    afterSummarizeBlock = `\n\n<upcoming_texts>\n${upcomingChunkContext}\n</upcoming_texts>\n\n`;
  }
  const finalUserPromptContent = contextPrompt + formattedReminderMessage + wrappedTextChunk + afterSummarizeBlock;

  let totalTokens = 0;
  if (summarySystemPrompt.trim()) {
    const systemTokenResult = await genAIInstance.models.countTokens({
      model: modelName,
      contents: [{ role: "system", parts: [{text: summarySystemPrompt}]}]
    });
    totalTokens += systemTokenResult.totalTokens || 0;
  }

  if (finalUserPromptContent.trim()) {
    const userTokenResult = await genAIInstance.models.countTokens({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: finalUserPromptContent }] }]
    });
    totalTokens += userTokenResult.totalTokens || 0;
  }
  
  return totalTokens;
}

async function countTokens(text, modelAlias = 'primary') {
  const modelName = modelInstances[modelAlias];
  if (!genAIInstance || !modelName) {
    throw new Error(`Gemini client or model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first for token counting.`);
  }
  if (typeof text !== 'string') {
    text = ''; // Treat non-string input as empty string for token counting
  }
  if (!text.trim()) { // If text is empty or only whitespace
      return 0;
  }

  try {
    const result = await genAIInstance.models.countTokens({
      model: modelName,
      contents: [{ role: "user", parts: [{ text }] }] // Simple text count as a single user part
    });
    return result.totalTokens || 0;
  } catch (error) {
    console.error(`Failed to count tokens for model alias '${modelAlias}':`, error);
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Translates a chunk of original text strings using the Gemini API, expecting a JSON array of objects, each with an index and text.
 * @param {string[]} chunkOfOriginalTexts - An array of original text strings to be translated.
 * @param {string} targetLanguage - The target language for translation.
 * @param {string} systemPromptTemplate - The system prompt template, instructing the model for JSON output.
 * @param {number} temperature - The temperature for generation.
 * @param {number} topP - The topP for generation.
 * @param {number} [numberOfEntriesInChunk] - Optional: The number of entries in this specific chunk.
 * @param {AbortSignal} [abortSignal] - Optional: An AbortSignal to cancel the API request.
 * @param {string} [previousChunkContext] - Optional: Concatenated string of the last few lines from the previous chunk.
 * @param {string} [nextChunkContext] - Optional: Concatenated string of the first few lines from the next chunk.
 * @param {number} [thinkingBudget=-1] - Optional: The thinking budget for the request.
 * @param {string} [modelAlias='primary'] - Optional: The model alias to use for translation.
 * @param {string} [sourceLanguageNameForPrompt] - Optional: The name/code of the source language for the {src} placeholder.
 * @returns {Promise<{translatedResponseArray: Array<{index: number, text: string}>, actualInputTokens: number, outputTokens: number}>}
 * - A promise that resolves to an object containing the translated array, actual input tokens, and output tokens.
 */
async function translateChunk(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, temperature, topP, numberOfEntriesInChunk, abortSignal = null, previousChunkContext = null, nextChunkContext = null, thinkingBudget = -1, modelAlias = 'primary', sourceLanguageNameForPrompt) {
  const modelName = modelInstances[modelAlias];
  if (!genAIInstance || !modelName) {
    throw new Error(`Gemini client or model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first.`);
  }
  if (!Array.isArray(chunkOfOriginalTexts) || chunkOfOriginalTexts.length === 0) {
    console.warn('translateChunk called with empty or invalid chunk of texts.');
    return { translatedResponseArray: [], actualInputTokens: 0, outputTokens: 0 }; // Return empty array and zero tokens
  }

  let processedSystemPrompt = systemPromptTemplate.replace(/{lang}/g, targetLanguage);
  const srcReplacementValue = (sourceLanguageNameForPrompt && sourceLanguageNameForPrompt.trim() !== "") ? sourceLanguageNameForPrompt : "undefined";
  processedSystemPrompt = processedSystemPrompt.replace(/{src}/g, srcReplacementValue);

  let combinedPromptPrefix = "";
  if (previousChunkContext && previousChunkContext.trim() !== "") {
      // previousChunkContext is already "Previous text segments:\nsegment1..."
      combinedPromptPrefix += `<previous_texts>\n${previousChunkContext.trim()}\n</previous_texts>\n\n`;
  }

  // Do not include upcoming_texts before input; it will be placed right after input

  let entryReminderItself = "";
  if (typeof numberOfEntriesInChunk === 'number' && numberOfEntriesInChunk > 0) {
      entryReminderItself = `Translate all ${numberOfEntriesInChunk} text segments in <input> section from {src} to {lang}.\n\n`;
      entryReminderItself = entryReminderItself.replace(/{lang}/g, targetLanguage);
      entryReminderItself = entryReminderItself.replace(/{src}/g, srcReplacementValue);
  }
  combinedPromptPrefix += entryReminderItself;

  let textsForUserPromptContent = "";
  chunkOfOriginalTexts.forEach((text, index) => {
    textsForUserPromptContent += `${index + 1}. ${text}\n`;
  });

  // Remove trailing newline from the content block before closing the tag
  if (textsForUserPromptContent.endsWith('\n')) {
      textsForUserPromptContent = textsForUserPromptContent.slice(0, -1);
  }
  
  let wrappedTextsPart = "";
  if (textsForUserPromptContent) { // Only add tag if there's content
      wrappedTextsPart = `<input>\n${textsForUserPromptContent}\n</input>`;
  }

  let userPromptContent = combinedPromptPrefix + wrappedTextsPart; // This is the final user prompt
  
  // Ensure a single upcoming_texts block immediately after input
  if (nextChunkContext && nextChunkContext.trim() !== "") {
      userPromptContent += `\n\n<upcoming_texts>\n${nextChunkContext.trim()}\n</upcoming_texts>\n\n`;
  }

  const generationConfig = {
    temperature: temperature,
    topP: topP,
    responseMimeType: "application/json",
    responseSchema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          text: { type: "string" }
        },
        required: ["index", "text"],
        propertyOrdering: ["index", "text"]
      }
    },
    thinkingConfig: {
      thinkingBudget: thinkingBudget, // Use the parameter
    },
    maxOutputTokens: 65536,
  };

  try {
    const requestOptions = {};
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    console.debug(`[Gemini Request] Model Alias: ${modelAlias}`);
    console.debug(`[Gemini Request] System Prompt:\n${processedSystemPrompt}`);
    console.debug(`[Gemini Request] User Input:\n${userPromptContent}`);
 
    const result = await genAIInstance.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: userPromptContent }] }],
      systemInstruction: { role: "system", parts: [{text: processedSystemPrompt}] },
      config: generationConfig, // Pass the existing generationConfig object (lines 165-184) here
    }, requestOptions);
    
    // Assuming result directly contains candidates, not nested under result.response
    if (!result || !result.candidates || result.candidates.length === 0) {
      console.error('Invalid or empty response structure from Gemini API:', result);
      const noResponseError = new Error('No response or candidates from Gemini API.');
      noResponseError.isApiError = true;
      throw noResponseError;
    }

    const candidate = result.candidates[0];

    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
      const jsonResponseString = candidate.content.parts.map(part => part.text).join('');
      try {
        const translatedResponseArray = JSON.parse(jsonResponseString);
        if (!Array.isArray(translatedResponseArray) ||
            !translatedResponseArray.every(item =>
                typeof item === 'object' &&
                item !== null &&
                typeof item.index === 'number' &&
                typeof item.text === 'string' &&
                item.text.trim() !== '' // New check: ensures text is not just whitespace
            )
        ) {
            let errorMessage = 'Parsed JSON is not an array of objects, or objects do not have "index" (number) and "text" (string) properties, or text is empty/whitespace.';
            let errorReason = 'BAD_SCHEMA_RESPONSE';

            // Check specifically for the empty text condition if the general structure is otherwise okay
            if (Array.isArray(translatedResponseArray) &&
                translatedResponseArray.every(item => typeof item === 'object' && item !== null && typeof item.index === 'number' && typeof item.text === 'string') && // Basic structure is fine
                translatedResponseArray.some(item => typeof item === 'object' && item !== null && typeof item.text === 'string' && item.text.trim() === '') // But some text is empty/whitespace
            ) {
                errorMessage = 'Parsed JSON contains an item with an empty or whitespace-only text property.';
                errorReason = 'EMPTY_TEXT_IN_RESPONSE'; // Custom reason for this specific error
            }

            const validationError = new Error(errorMessage);
            validationError.isApiError = true;
            validationError.finishReason = errorReason;
            throw validationError;
        }

        // New validation: Check for duplicate index values
        const indices = translatedResponseArray.map(item => item.index);
        const uniqueIndices = new Set(indices);
        if (uniqueIndices.size !== indices.length) {
          const duplicateIndexError = new Error(
            `Parsed JSON contains duplicate index values.`
          );
          duplicateIndexError.isApiError = true;
          duplicateIndexError.finishReason = 'DUPLICATE_INDEX_IN_RESPONSE';
          throw duplicateIndexError;
        }

        // New validation: Check for correct index order (1-based sequential)
        for (let j = 0; j < translatedResponseArray.length; j++) {
          const item = translatedResponseArray[j];
          // item.index should be a number due to prior checks
          if (item.index !== j + 1) {
            const indexOrderError = new Error(
              `Parsed JSON has incorrect index order or starting point. Expected index ${j + 1} but got ${item.index} at array position ${j}.`
            );
            indexOrderError.isApiError = true;
            indexOrderError.finishReason = 'BAD_INDEX_ORDER_RESPONSE';
            throw indexOrderError;
          }
        }
 
        // Assuming usageMetadata is directly on the result object
        const actualInputTokens = result.usageMetadata?.promptTokenCount || 0;
        const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;
 
        return { translatedResponseArray, actualInputTokens, outputTokens };
      } catch (parseError) {
        console.error('Failed to parse JSON response from Gemini API:', parseError, 'Raw response:', jsonResponseString);
        // If parseError is one of our custom validation errors, rethrow it directly.
        // Otherwise, wrap it as a new jsonParseError.
        if (parseError.isApiError && (parseError.finishReason === 'BAD_SCHEMA_RESPONSE' || parseError.finishReason === 'EMPTY_TEXT_IN_RESPONSE' || parseError.finishReason === 'BAD_INDEX_ORDER_RESPONSE' || parseError.finishReason === 'DUPLICATE_INDEX_IN_RESPONSE')) {
            throw parseError;
        }
        const jsonParseError = new Error(`Failed to parse JSON response from Gemini API: ${parseError.message}`);
        jsonParseError.isApiError = true; // Treat as an API error for retry purposes
        jsonParseError.finishReason = 'BAD_JSON_RESPONSE'; // Custom reason
        throw jsonParseError;
      }
    }
    
    // If no content parts, but there's a finishReason, it might indicate an issue.
    console.warn('No content parts in Gemini response candidate:', candidate);
    const noContentError = new Error(`No content parts in Gemini response. Finish reason: ${candidate.finishReason || 'N/A'}`);
    noContentError.isApiError = true;
    noContentError.finishReason = candidate.finishReason;
    throw noContentError;

  } catch (error) {
    console.error('Error calling Gemini API or processing its response:', error);
    if (!error.isApiError) {
        error.isApiError = true; // Ensure it's flagged for orchestrator's retry logic
    }
    throw error;
  }
}

/**
 * Summarizes a text chunk and extracts key terminologies using the Gemini API.
 * Expects a JSON object with "theme" and "terms" (array of {src, tgt, note}).
 * @param {string} textChunk - The text chunk to be summarized.
 * @param {string} summarySystemPrompt - The system prompt guiding the summarization.
 * @param {object} geminiSettings - Settings for the Gemini API call.
 * @param {number} geminiSettings.temperature - The temperature for generation.
 * @param {number} geminiSettings.topP - The topP for generation.
 * @param {number} [geminiSettings.thinkingBudget=-1] - Optional: The thinking budget for the request.
 * @param {number} [geminiSettings.maxOutputTokens=65536] - Optional: Max output tokens.
 * @param {string} [modelAlias='primary'] - Optional: The model alias to use.
 * @param {AbortSignal} [abortSignal=null] - Optional: An AbortSignal to cancel the API request.
 * @param {string} targetLanguageFullName - The full name of the target language for the reminder message.
 * @returns {Promise<{summaryResponse: {theme: string, terms: Array<{src: string, tgt: string, note?: string}>}, actualInputTokens: number, outputTokens: number}>}
 * - A promise that resolves to an object containing the summary response, input tokens, and output tokens.
 */
async function summarizeAndExtractTermsChunk(
  textChunk,
  summarySystemPrompt,
  geminiSettings,
  targetLanguageFullName, // New parameter
  modelAlias = 'primary',
  abortSignal = null,
  previousChunkContext = null,
  upcomingChunkContext = null
) {
  const modelName = modelInstances[modelAlias];
  if (!genAIInstance || !modelName) {
    throw new Error(`Gemini client or model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first.`);
  }
  if (typeof textChunk !== 'string' || textChunk.trim() === '') {
    console.warn('summarizeAndExtractTermsChunk called with empty or invalid text chunk.');
    return { summaryResponse: { theme: "", terms: [] }, actualInputTokens: 0, outputTokens: 0 };
  }

  let contextPrompt = "";
  if (previousChunkContext) {
    contextPrompt += `<previous_texts>\n${previousChunkContext}\n</previous_texts>\n\n`;
  }
  const generationConfig = {
    temperature: geminiSettings.temperature,
    topP: geminiSettings.topP,
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        theme: { type: "string" },
        terms: {
          type: "array",
          items: {
            type: "object",
            properties: {
              src: { type: "string" },
              tgt: { type: "string" },
              note: { type: "string" }
            },
            propertyOrdering: ["src", "tgt", "note"],
            required: ["src", "tgt", "note"]
          }
        }
      },
      propertyOrdering: ["theme", "terms"],
      required: ["theme", "terms"]
    },
    thinkingConfig: {
      thinkingBudget: -1,
    },
    maxOutputTokens: geminiSettings.maxOutputTokens || 65536,
  };

  try {
    const requestOptions = {};
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    // Debug prints for summary API request
    console.debug(`[Gemini Summarize Request] Model Alias: ${modelAlias}`);
    console.debug(`[Gemini Summarize Request] System Prompt (Unchanged by this function):\n${summarySystemPrompt}`);

    const reminderMessageTemplate = "Analyze the subtitles within <summarize_request> section, then extract and translate the theme and up to 50 important names/terminologies in {lang}.\n\n";
    const formattedReminderMessage = reminderMessageTemplate.replace(/{lang}/g, targetLanguageFullName || "the target language"); // Fallback if targetLanguageFullName is not provided
    const wrappedTextChunk = `<summarize_request>\n${textChunk}\n</summarize_request>`;
    // Place upcoming_texts immediately after summarize_request
    let afterSummarizeBlock = "";
    if (upcomingChunkContext) {
      afterSummarizeBlock = `\n\n<upcoming_texts>\n${upcomingChunkContext}\n</upcoming_texts>\n\n`;
    }
    const finalUserPromptContent = contextPrompt + formattedReminderMessage + wrappedTextChunk + afterSummarizeBlock;

    console.debug(`[Gemini Summarize Request] Modified User Input:\n${finalUserPromptContent}`);
    console.debug(`[Gemini Summarize Request] Generation Config:\n${JSON.stringify(generationConfig, null, 2)}`);


    const result = await genAIInstance.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: finalUserPromptContent }] }],
      systemInstruction: { role: "system", parts: [{ text: summarySystemPrompt }] },
      config: generationConfig,
    }, requestOptions);

    if (!result || !result.candidates || result.candidates.length === 0) {
      console.error('Invalid or empty response structure from Gemini API for summarization:', result);
      const noResponseError = new Error('No response or candidates from Gemini API for summarization.');
      noResponseError.isApiError = true;
      throw noResponseError;
    }

    const candidate = result.candidates[0];

    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
      const jsonResponseString = candidate.content.parts.map(part => part.text).join('');
      try {
        const summaryResponse = JSON.parse(jsonResponseString);

        // Validate the summaryResponse structure
        if (
          typeof summaryResponse !== 'object' || summaryResponse === null ||
          typeof summaryResponse.theme !== 'string' || summaryResponse.theme.trim() === '' ||
          !Array.isArray(summaryResponse.terms) ||
          !summaryResponse.terms.every(term =>
            typeof term === 'object' && term !== null &&
            typeof term.src === 'string' && term.src.trim() !== '' &&
            typeof term.tgt === 'string' && term.tgt.trim() !== '' &&
            typeof term.note === 'string' && term.note.trim() !== ''
          )
        ) {
          const validationError = new Error('Parsed JSON for summarization does not match the required schema or contains empty fields.');
          validationError.isApiError = true;
          validationError.finishReason = 'BAD_SUMMARY_SCHEMA_RESPONSE';
          throw validationError;
        }
        
        const actualInputTokens = result.usageMetadata?.promptTokenCount || 0;
        const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

        return { summaryResponse, actualInputTokens, outputTokens };
      } catch (parseError) {
        console.error('Failed to parse or validate JSON response from Gemini API for summarization:', parseError, 'Raw response:', jsonResponseString);
        if (parseError.isApiError && parseError.finishReason === 'BAD_SUMMARY_SCHEMA_RESPONSE') {
            throw parseError;
        }
        const jsonParseError = new Error(`Failed to parse/validate JSON for summarization: ${parseError.message}`);
        jsonParseError.isApiError = true;
        jsonParseError.finishReason = 'BAD_SUMMARY_JSON_RESPONSE';
        throw jsonParseError;
      }
    }

    console.warn('No content parts in Gemini summarization response candidate:', candidate);
    const noContentError = new Error(`No content parts in Gemini summarization response. Finish reason: ${candidate.finishReason || 'N/A'}`);
    noContentError.isApiError = true;
    noContentError.finishReason = candidate.finishReason;
    throw noContentError;

  } catch (error) {
    console.error('Error calling Gemini API for summarization or processing its response:', error);
    if (!error.isApiError) {
      error.isApiError = true;
      error.finishReason = error.finishReason || 'SUMMARY_UNKNOWN_ERROR';
    }
    throw error;
  }
}

module.exports = {
  initializeGeminiModel,
  isInitialized,
  translateChunk,
  estimateInputTokensForTranslation,
  countTokens, // Added
  summarizeAndExtractTermsChunk, // Added
  estimateInputTokensForSummarization, // Added
};
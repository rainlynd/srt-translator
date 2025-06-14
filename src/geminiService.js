const { GoogleGenerativeAI } = require('@google/generative-ai');

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
    genAIInstance = new GoogleGenerativeAI(apiKey);
  }
  try {
    modelInstances[modelAlias] = genAIInstance.getGenerativeModel({ model: modelName }); // Modified
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
  return !!modelInstances[modelAlias]; // Modified
}

/**
 * Estimates the total input tokens for a given translation request.
 * @param {string[]} chunkOfOriginalTexts - An array of original text strings.
 * @param {string} targetLanguage - The target language for translation.
 * @param {string} systemPromptTemplate - The system prompt template.
 * @param {number} [numberOfEntriesInChunk] - Optional: The number of entries in this specific chunk.
 * @param {string} [previousChunkContext=null] - Optional: Concatenated string of the last few lines from the previous chunk.
 * @param {string} [modelAlias='primary'] - Optional: The model alias to use for estimation.
 * @returns {Promise<number>} - A promise that resolves to the estimated total input tokens.
 */
async function estimateInputTokensForTranslation(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, numberOfEntriesInChunk, previousChunkContext = null, modelAlias = 'primary') { // Modified
  const selectedModel = modelInstances[modelAlias]; // Added
  if (!selectedModel) { // Modified
    throw new Error(`Gemini model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first for token estimation.`); // Modified
  }
  if (!Array.isArray(chunkOfOriginalTexts)) {
    // Allow empty chunk for estimation, it might still have a system prompt
    chunkOfOriginalTexts = [];
  }

  const systemPromptString = systemPromptTemplate.replace(/{lang}/g, targetLanguage);
  
  let combinedPromptPrefix = "";
  if (previousChunkContext && previousChunkContext.trim() !== "") {
      // previousChunkContext is already "Previous text segments:\nsegment1..."
      combinedPromptPrefix += `<previous_texts>\n${previousChunkContext.trim()}\n</previous_texts>\n\n`;
  }

  let entryReminderItself = "";
  if (typeof numberOfEntriesInChunk === 'number' && numberOfEntriesInChunk > 0) {
      entryReminderItself = `Ensure your response contains exactly ${numberOfEntriesInChunk} corresponding translated items.\n\n`;
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
      wrappedTextsPart = `<current_texts>\n${textsForUserPromptForEstimationContent}\n</current_texts>`;
  }
  
  const finalUserPromptForEstimation = combinedPromptPrefix + wrappedTextsPart;

  let userTokens = 0;
  if (finalUserPromptForEstimation.trim()) { // Only count if there's actual user text
      const userTokenResult = await selectedModel.countTokens({ contents: [{ role: "user", parts: [{ text: finalUserPromptForEstimation }] }] }); // Modified
      userTokens = userTokenResult.totalTokens || 0;
  }

  let systemTokens = 0;
  if (systemPromptString.trim()) { // Only count if there's actual system text
      const systemTokenResult = await selectedModel.countTokens({ contents: [{ role: "system", parts: [{text: systemPromptString}]}]}); // Modified
      systemTokens = systemTokenResult.totalTokens || 0;
  }
  
  return userTokens + systemTokens;
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
 * @param {number} [thinkingBudget=24576] - Optional: The thinking budget for the request.
 * @param {string} [modelAlias='primary'] - Optional: The model alias to use for translation.
 * @returns {Promise<{translatedResponseArray: Array<{index: number, text: string}>, actualInputTokens: number, outputTokens: number}>}
 * - A promise that resolves to an object containing the translated array, actual input tokens, and output tokens.
 */
async function translateChunk(chunkOfOriginalTexts, targetLanguage, systemPromptTemplate, temperature, topP, numberOfEntriesInChunk, abortSignal = null, previousChunkContext = null, thinkingBudget = 24576, modelAlias = 'primary') { // Modified
  const selectedModel = modelInstances[modelAlias]; // Added
  if (!selectedModel) { // Modified
    throw new Error(`Gemini model for alias '${modelAlias}' not initialized. Call initializeGeminiModel first.`); // Modified
  }
  if (!Array.isArray(chunkOfOriginalTexts) || chunkOfOriginalTexts.length === 0) {
    console.warn('translateChunk called with empty or invalid chunk of texts.');
    return []; // Return empty array if chunk is empty
  }

  let fullSystemPrompt = systemPromptTemplate.replace(/{lang}/g, targetLanguage);

  let combinedPromptPrefix = "";
  if (previousChunkContext && previousChunkContext.trim() !== "") {
      // previousChunkContext is already "Previous text segments:\nsegment1..."
      combinedPromptPrefix += `<previous_texts>\n${previousChunkContext.trim()}\n</previous_texts>\n\n`;
  }

  let entryReminderItself = "";
  if (typeof numberOfEntriesInChunk === 'number' && numberOfEntriesInChunk > 0) {
      entryReminderItself = `Ensure your response contains exactly ${numberOfEntriesInChunk} corresponding translated items.\n\n`;
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
      wrappedTextsPart = `<current_texts>\n${textsForUserPromptContent}\n</current_texts>`;
  }

  const userPromptContent = combinedPromptPrefix + wrappedTextsPart; // This is the final user prompt

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
    console.debug(`[Gemini Request] System Prompt:\n${fullSystemPrompt}`);
    console.debug(`[Gemini Request] User Input:\n${userPromptContent}`);
 
    const result = await selectedModel.generateContent({ // Modified
      contents: [{ role: "user", parts: [{ text: userPromptContent }] }],
      generationConfig,
      systemInstruction: { role: "system", parts: [{text: fullSystemPrompt}]},
    }, requestOptions); // Pass requestOptions
    
    if (!result.response || !result.response.candidates || result.response.candidates.length === 0) {
      console.error('Invalid or empty response structure from Gemini API:', result.response);
      const noResponseError = new Error('No response or candidates from Gemini API.');
      noResponseError.isApiError = true;
      throw noResponseError;
    }

    const candidate = result.response.candidates[0];

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

        const actualInputTokens = result.response.usageMetadata?.promptTokenCount || 0;
        const outputTokens = result.response.usageMetadata?.candidatesTokenCount || 0;

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

// Removed resegmentSRTChunk function as per plan.

module.exports = {
  initializeGeminiModel,
  isInitialized,
  translateChunk,
  estimateInputTokensForTranslation, // Export new function
  // resegmentSRTChunk, // Removed export
};
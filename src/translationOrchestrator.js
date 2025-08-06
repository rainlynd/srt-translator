const fs = require('fs').promises;
const path = require('path');
const srtParser = require('./srtParser');
const modelProvider = require('./modelProvider');

let cancelCurrentTranslation = false;

/**
 * Logs an error message to a dedicated log file for a given input SRT file.
 * The log file will be located at: settings.outputDirectory / settings.errorLogDirectory / original_filename.log
 * @param {string} errorMessage - The error message to log.
 * @param {string} originalInputFilePath - The full path to the original SRT input file.
 * @param {object} settings - The application settings, including outputDirectory and errorLogDirectory.
 */

/**
 * Allows global cancellation of the current translation batch.
 * Can also be used to signal cancellation for a specific job if the orchestrator
 * internally manages per-job states (currently, it's a global flag).
 * @param {boolean} cancel - Whether to set the cancellation flag.
 * @param {string} [jobId] - Optional job ID for which cancellation is requested. Not fully used internally yet for granular control.
 */
function setTranslationCancellation(cancel, jobId = null) {
  cancelCurrentTranslation = cancel;
  }
  
  // chunkSRTEntries is now imported from srtParser.js
  
  /**
   * Reconstructs an SRT block string from its components.
 * Ensures the block ends with a double newline.
 * @param {string} index - The entry index.
 * @param {string} timestamp - The timestamp string.
 * @param {string} text - The subtitle text.
 * @returns {string} - The formatted SRT block string.
 */
function reconstructSrtBlock(index, timestamp, text) {
    // Ensure text itself doesn't end with excessive newlines before adding the final two.
    // The srtParser.parseSRT ensures blocks end with \n\n, so this should maintain consistency.
    return `${index}\n${timestamp}\n${text.trimEnd()}\n\n`;
}

/**
 * Processes a single chunk with its own retry logic.
 * @param {Array<{index: string, timestamp: string, text: string, originalBlock: string}>} originalChunk - The chunk of original structured SRT entry objects.
 * @param {number} chunkIndex - The 0-based index of this chunk in the file.
 * @param {string} targetLanguage - The target language for translation.
 * @param {string} sourceLanguageNameForPrompt - The name/code of the source language for the {src} placeholder.
 * @param {object} settings - The application settings object, including filePathForLogging and originalInputPath.
 * @param {Function} logCallback - For logging messages.
 * @param {string} [jobId] - Optional job ID for context.
 * @param {object} [gfc] - Optional GlobalFileAdmissionController instance for token management.
 * @param {Array<Array<{index: string, timestamp: string, text: string, originalBlock: string}>>} [chunks] - Optional: All chunks for next context collection.
 * @param {string} [summaryContentForPrompt=""] - Optional: Content from summarization stage.
 * @returns {Promise<string[]>} - A promise that resolves to an array of validated translated SRT block strings (strings).
 * @throws {Error} If the chunk fails all retries or validation, or if cancelled.
 */
async function processSingleChunkWithRetries(originalChunk, chunkIndex, targetLanguage, sourceLanguageNameForPrompt, settings, logCallback, jobId = null, gfc = null, previousChunkOriginalEntries = null, chunks = null, summaryContentForPrompt = "") { // Added chunks parameter and summaryContentForPrompt
  let { systemPrompt, temperature, topP, filePathForLogging, originalInputPath, chunkRetries, thinkingBudget: uiControlledThinkingBudget, strongerRetryModelName, geminiModel } = settings; // Added strongerRetryModelName, geminiModel
    const standardMaxChunkRetries = (typeof chunkRetries === 'number' && chunkRetries > 0) ? chunkRetries : 2; // Use from settings or default to 2
    let chunkAttempt = 0;
    let currentMaxRetries = standardMaxChunkRetries;

    // Inject summary content into the system prompt
    const effectiveSystemPrompt = systemPrompt.replace(/{summary_content}/g, summaryContentForPrompt || "");

    // Estimate tokens once before the retry loop, as the input content doesn't change per attempt.
    const originalTextsForApi = originalChunk.map(entryObj => entryObj.text);
    let estimatedInputTokensForGFC = 0;

    let contextToPassToGemini = null;
    if (previousChunkOriginalEntries && Array.isArray(previousChunkOriginalEntries) && previousChunkOriginalEntries.length > 0) {
        const lastFiveEntries = previousChunkOriginalEntries.slice(-5);
        const contextTexts = lastFiveEntries.map(entry => entry.text);
        if (contextTexts.length > 0) {
            contextToPassToGemini = `${contextTexts.join('\n')}`;
        }
    }

    // Collect next chunk context
    let nextChunkContext = null;
    if (chunks.length > chunkIndex + 1) {
        const nextChunkFirstEntries = chunks[chunkIndex + 1].slice(0, 5);
        const nextContextTexts = nextChunkFirstEntries.map(entry => entry.text);
        if (nextContextTexts.length > 0) {
            nextChunkContext = `${nextContextTexts.join('\n')}`;
        }
    }

    if (gfc) { // Only estimate if GFC is present
      try {
        // modelAliasToUse will be determined inside the retry loop, default to 'primary' for initial estimation
        estimatedInputTokensForGFC = await modelProvider.estimateInputTokensForTranslation(
          originalTextsForApi,
          targetLanguage,
          effectiveSystemPrompt, // Use system prompt with summary
          originalChunk.length, // Pass the number of entries in the chunk
          contextToPassToGemini,
          nextChunkContext,      // pass as next context
          'primary', // Use primary model for initial GFC estimation
          sourceLanguageNameForPrompt // Pass for {src} placeholder
        );
        logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Estimated input tokens for GFC (using primary model alias): ${estimatedInputTokensForGFC}`, 'debug');
      } catch (estimationError) {
        logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Error estimating tokens: ${estimationError.message}. Proceeding without TPM pre-check for this chunk, GFC might still block.`, 'warn');
        // Allow to proceed, GFC's requestApiResources might still work or fail gracefully if estimation is critical.
        // Or, could throw here if estimation is mandatory: throw new Error(`Token estimation failed: ${estimationError.message}`);
      }
    }

    let actualInputTokensFromCall = 0; // To store actual tokens for release
    let outputTokensFromCall = 0;    // To store actual tokens for release

    while (chunkAttempt < currentMaxRetries) {
      if (cancelCurrentTranslation) {
            logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) processing cancelled before attempt ${chunkAttempt + 1}.`, 'warn');
            throw new Error(`Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) cancelled`);
        }
        chunkAttempt++;
        logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Attempt ${chunkAttempt}/${currentMaxRetries}`, 'info');

        try {
            if (gfc) {
                await gfc.requestApiResources(jobId, estimatedInputTokensForGFC);
                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - API resources acquired from GFC.`, 'debug');
            }

            // contextToPassToGemini is now prepared before the loop
 
            let modelAliasToUse = 'primary';
            let effectiveThinkingBudget = uiControlledThinkingBudget; // Default to UI-controlled value
 
            if (settings.modelProvider === 'deepseek') {
               if (chunkAttempt > 3 && settings.deepseekStrongerModel && settings.deepseekStrongerModel.trim() !== '') {
                   modelAliasToUse = 'retry';
                   logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Attempt ${chunkAttempt}: Switching to stronger DeepSeek model ('${settings.deepseekStrongerModel}') for retry.`, 'debug');
               } else {
                   modelAliasToUse = 'primary';
               }
            } else if (chunkAttempt > 3 && strongerRetryModelName && strongerRetryModelName.trim() !== '') {
                modelAliasToUse = 'retry';
                effectiveThinkingBudget = -1; // Override since stronger model cannot disable thinking
                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Attempt ${chunkAttempt}: Switching to Gemini PRO model ('${strongerRetryModelName}') for retry. Setting thinkingBudget to -1.`, 'debug');
            } else if (chunkAttempt > 3) { // Stronger model desired but not configured
                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Attempt ${chunkAttempt}: Would switch to stronger model, but no strongerRetryModelName configured. Using primary model ('${geminiModel}'). Thinking budget from UI: ${effectiveThinkingBudget}.`, 'warn');
            } else {
                // Primary model attempt, use UI controlled thinking budget
                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - Attempt ${chunkAttempt}: Using primary model ('${geminiModel}'). Thinking budget from UI: ${effectiveThinkingBudget}.`, 'debug');
            }

            const geminiResult = await modelProvider.translateChunk(
                originalTextsForApi, // Already prepared
                targetLanguage,
                effectiveSystemPrompt, // Use system prompt with summary
                temperature,
                topP,
                originalChunk.length,
                settings.abortSignal, // Assuming settings might carry an AbortSignal for the job
                contextToPassToGemini, // previous context
                nextChunkContext,      // next context
                effectiveThinkingBudget, // Pass the conditionally set thinkingBudget
                modelAliasToUse, // Pass the determined model alias
                sourceLanguageNameForPrompt // Pass for {src} placeholder
            );
            
            const { translatedResponseArray, actualInputTokens, outputTokens } = geminiResult;
            actualInputTokensFromCall = actualInputTokens; // Store for finally block
            outputTokensFromCall = outputTokens;       // Store for finally block

            logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}) API call successful. Actual Tokens - Input: ${actualInputTokens}, Output: ${outputTokens}. Validating...`, 'info');

            // geminiService.js ensures translatedResponseArray is an array and items have correct structure.
            // We only need to check if the count of translated items matches the original count.
            if (translatedResponseArray.length !== originalChunk.length) {
                throw new Error(`Validation Error (Chunk ${chunkIndex + 1}, File: ${filePathForLogging}): Expected ${originalChunk.length} translated items, got ${translatedResponseArray ? translatedResponseArray.length : 'null/undefined'}.`);
            }

            const validatedChunkBlocks = [];
            for (let j = 0; j < originalChunk.length; j++) {
                const currentOriginalEntry = originalChunk[j];
                const translatedItem = translatedResponseArray[j]; // Assumed to be structurally valid

                const translatedText = translatedItem.text; // Extract text for reconstruction

                // Reconstruct the SRT block using the original index and timestamp, and the new translated text.
                const newTranslatedBlockString = reconstructSrtBlock(
                    currentOriginalEntry.index, // Use the original entry's index
                    currentOriginalEntry.timestamp,
                    translatedText
                );
                validatedChunkBlocks.push(newTranslatedBlockString);
            }
            logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}) successfully processed and reconstructed.`, 'info');
            return validatedChunkBlocks;

        } catch (error) {
            logCallback(Date.now(), `Error processing Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Attempt ${chunkAttempt}/${currentMaxRetries}): ${error.message}`, 'error');

            const finishReason = error.finishReason;
            const httpStatus = error.status;
            let useApiSuggestedDelay = false;
            let specificRetryDelayMs = 0;

            if (httpStatus === 429 && error.errorDetails && Array.isArray(error.errorDetails)) {
                const retryInfo = error.errorDetails.find(detail => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
                if (retryInfo && retryInfo.retryDelay) {
                    const secondsMatch = String(retryInfo.retryDelay).match(/(\d+)s/);
                    if (secondsMatch && secondsMatch[1]) {
                        specificRetryDelayMs = parseInt(secondsMatch[1], 10) * 1000;
                        if (specificRetryDelayMs > 0) {
                            useApiSuggestedDelay = true;
                            if (gfc) {
                                gfc.activateGlobalApiPause(specificRetryDelayMs, jobId);
                                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - API Error 429 with retryDelay. Global API pause activated for ${specificRetryDelayMs / 1000}s.`, 'warn');
                            } else {
                                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - API Error 429 with retryDelay. GFC not available for global pause. Local chunk will wait ${specificRetryDelayMs / 1000}s.`, 'warn');
                            }
                        }
                    }
                }
            }

            if (chunkAttempt >= currentMaxRetries) {
                const finalChunkError = `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}) failed all ${currentMaxRetries} retries: ${error.message}`;
                throw new Error(finalChunkError);
            }

            if (!cancelCurrentTranslation) {
                let delayMs;
                if (useApiSuggestedDelay && specificRetryDelayMs > 0) {
                    delayMs = specificRetryDelayMs;
                    logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}) - Using API suggested retry delay of ${Math.round(delayMs / 1000)}s...`, 'info');
                } else {
                    const base = settings.initialRetryDelay || 1000;
                    const maxDelay = settings.maxRetryDelay || 30000;
                    const exp = Math.min(maxDelay, base * Math.pow(2, chunkAttempt - 1));
                    const jitterFactor = 0.5 + Math.random(); // 0.5 to 1.5
                    delayMs = Math.floor(exp * jitterFactor);
                    logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}) - Using exponential backoff with jitter of ${delayMs}ms...`, 'info');
                }
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        } finally {
            if (gfc) {
                // Pass actualInputTokensFromCall and outputTokensFromCall
                // If an error occurred before these were set (e.g., in requestApiResources), they'll be 0.
                gfc.releaseApiResources(jobId, actualInputTokensFromCall, outputTokensFromCall);
                logCallback(Date.now(), `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}, Job: ${jobId}) - API resources released to GFC. Input: ${actualInputTokensFromCall}, Output: ${outputTokensFromCall}`, 'debug');
            }
        }
    }
    // This line should ideally not be reached if the loop logic is correct and throws on max retries.
    const unexpectedExitError = `Chunk ${chunkIndex + 1} (File: ${filePathForLogging}) unexpectedly exited retry loop after ${chunkAttempt} attempts.`;
    throw new Error(unexpectedExitError);
}


/**
 * Manages the translation process for SRT data (from file or content string), processing chunks concurrently.
 * @param {string} identifier - The path to the original SRT file or a unique identifier if processing content directly (e.g., video file path).
 * @param {string | null} srtContent - The SRT content as a string. If null, filePath (identifier) is read.
 * @param {string} targetLanguage - The target language for translation.
 * @param {object} settings - The application settings object.
 * @param {Function} progressCallback - (identifier, progress, status, chunkInfo)
 * @param {Function} logCallback - (timestamp, message, level)
 * @param {string} [jobId] - Optional unique job ID for this operation.
 * @param {object} [gfc] - Optional GlobalFileAdmissionController instance.
 * @param {string} [summaryContent=""] - Optional: Content from summarization stage.
 * @returns {Promise<{status: string, outputPath?: string, error?: string}>}
 */
async function processSRTFile(identifier, srtContent, targetLanguage, sourceLanguageCodeForSkipLogic, sourceLanguageNameForPrompt, settings, progressCallback, logCallback, jobId = null, gfc = null, summaryContent = "") {
  cancelCurrentTranslation = false;

  let previousSuccessfullyProcessedChunkLastThreeLines = null; // Variable to store context

  const { entriesPerChunk } = settings;
    const maxConcurrentChunks = 9999;
  
    const identifierForLogging = path.basename(identifier); // Use identifier for logging
    logCallback(Date.now(), `Starting processing for: ${identifierForLogging} (Job ID: ${jobId}). Source for prompt: '${sourceLanguageNameForPrompt || 'Unknown/Not Specified'}', Source for skip: '${sourceLanguageCodeForSkipLogic || 'Unknown/Not Specified'}', Target: '${targetLanguage}'. Max concurrent chunks (local orchestrator): ${maxConcurrentChunks}. GFC managed: ${!!gfc}. File-level concurrency: ${settings.enableFileLevelConcurrency ? 'Enabled' : 'Disabled'}`, 'info');

    // --- START LANGUAGE CHECK ---
    // Ensure sourceLanguageCodeForSkipLogic is a non-empty string for the check to be effective.
    // If sourceLanguageCodeForSkipLogic is null, undefined, or "", it means it wasn't specified or detected, so we shouldn't skip.
    if (sourceLanguageCodeForSkipLogic && typeof sourceLanguageCodeForSkipLogic === 'string' && sourceLanguageCodeForSkipLogic.trim() !== "" &&
        settings.targetLanguageCode && typeof settings.targetLanguageCode === 'string' && settings.targetLanguageCode.trim() !== "" &&
        settings.targetLanguageCode !== 'none' && // Ensure we don't skip if target is 'none' and source matches 'none' (though source shouldn't be 'none')
        sourceLanguageCodeForSkipLogic.toLowerCase() === settings.targetLanguageCode.toLowerCase()) {

        logCallback(Date.now(), `Skipping translation for ${identifierForLogging} (Job ID: ${jobId}): Source language code for skip logic (${sourceLanguageCodeForSkipLogic}) is the same as target language code (${settings.targetLanguageCode}).`, 'info');
        progressCallback(identifier, 1, 'Skipped (Same Language)'); // Progress 100%

        const baseName = path.parse(identifierForLogging).name;
        // Use a consistent naming convention, perhaps indicating it's an untranslated copy.
        const outputFileName = `${baseName}.srt`; // Changed to .srt
        const outputDirFullPath = path.dirname(identifier);
        let outputPathForSkipped = identifier; // Default to original path if saving fails

        try {
            await fs.mkdir(outputDirFullPath, { recursive: true });
            const finalOutputPath = path.join(outputDirFullPath, outputFileName);

            if (srtContent && typeof srtContent === 'string') {
                // If srtContent is provided (e.g., from video transcription), write it.
                await fs.writeFile(finalOutputPath, srtContent, 'utf8');
                logCallback(Date.now(), `Saved original (untranslated) SRT content to ${finalOutputPath} as no translation needed.`, 'info');
                outputPathForSkipped = finalOutputPath;
            } else if (identifier && identifier.toLowerCase().endsWith('.srt')) {
                // If identifier is an SRT file path and srtContent wasn't provided (direct SRT processing), copy the file.
                await fs.copyFile(identifier, finalOutputPath);
                logCallback(Date.now(), `Copied original SRT ${identifier} to ${finalOutputPath} as no translation needed.`, 'info');
                outputPathForSkipped = finalOutputPath;
            } else {
                // This case implies identifier was a video path, and srtContent should have been provided.
                // Or, identifier is not an SRT file path for direct SRT processing.
                logCallback(Date.now(), `Warning: srtContent was not provided or identifier is not an SRT file for ${identifierForLogging} during skipped translation. Cannot save output to designated location. Original file path will be reported.`, 'warn');
                // outputPathForSkipped remains the original identifier.
            }
            return { status: 'Success (No Translation Needed)', outputPath: outputPathForSkipped };
        } catch (e) {
            const errorMsg = `Error handling skipped translation file for ${identifierForLogging}: ${e.message}`;
            logCallback(Date.now(), errorMsg, 'error');
            return { status: 'Error', error: errorMsg };
        }
    }
    // --- END LANGUAGE CHECK ---
  
    let originalSrtEntries;
    try {
      if (srtContent && typeof srtContent === 'string') {
          originalSrtEntries = srtParser.parseSRTContent(srtContent); // Assumes srtParser has parseSRTContent
           logCallback(Date.now(), `Parsed SRT content for ${identifierForLogging} (Job ID: ${jobId}).`, 'info');
      } else if (identifier && !srtContent) {
          originalSrtEntries = await srtParser.parseSRT(identifier); // Original behavior: read from file path
          logCallback(Date.now(), `Parsed SRT file ${identifierForLogging} (Job ID: ${jobId}).`, 'info');
      } else {
          throw new Error('Either srtContent (string) or a valid file path (identifier) must be provided.');
      }
  
      if (!originalSrtEntries || originalSrtEntries.length === 0) {
        const emptyParseError = 'Empty or unparsable SRT data';
        logCallback(Date.now(), `SRT data for ${identifierForLogging} (Job ID: ${jobId}) is empty or could not be parsed.`, 'error');
        progressCallback(identifier, 1, `Error: ${emptyParseError}`);
        return { status: 'Error', error: emptyParseError };
      }
    } catch (error) {
      const parseErrorMsg = `Failed to parse SRT data for ${identifierForLogging} (Job ID: ${jobId}): ${error.message}`;
      logCallback(Date.now(), parseErrorMsg, 'error');
      progressCallback(identifier, 1, `Error: ${error.message}`);
      return { status: 'Error', error: parseErrorMsg };
    }

    const chunks = srtParser.chunkSRTEntries(originalSrtEntries, entriesPerChunk); // Use srtParser.chunkSRTEntries
    logCallback(Date.now(), `SRT data for ${identifierForLogging} (Job ID: ${jobId}) split into ${chunks.length} chunks.`, 'info');
    progressCallback(identifier, 0, `Split into ${chunks.length} chunks.`);
  

      if (cancelCurrentTranslation) { // Check global flag (and potentially jobCancellationFlags.get(jobId))
        logCallback(Date.now(), `Translation cancelled for ${identifierForLogging} (Job ID: ${jobId}, File attempt ${fileAttempt + 1}).`, 'warn');
        progressCallback(identifier, 1, 'Cancelled');
        return { status: 'Cancelled' };
      }
  
      logCallback(Date.now(), `Processing ${identifierForLogging} (Job ID: ${jobId}) - Single attempt`, 'info');
      progressCallback(identifier, 0, `Processing file (single attempt)`);
  
      const chunkResultsForAttempt = new Array(chunks.length);
        const allPromisesForAttempt = [];
        let runningTasksCount = 0;
        let nextChunkIndexToLaunch = 0;
        let completedChunksInAttempt = 0;
        let criticalErrorInAttempt = false; // To stop launching new tasks if one fails hard

        // Pass identifierForLogging and originalInputPath (which is 'identifier') to chunk processor
        const enrichedSettings = {
            ...settings,
            filePathForLogging: identifierForLogging,
            originalInputPath: identifier,
            thinkingBudget: settings.thinkingBudget,
            strongerRetryModelName: settings.strongerRetryModelName, // Added
            geminiModel: settings.geminiModel // Added (primary model name for reference)
        };
    
        const launchTaskIfNeeded = () => {
          while (runningTasksCount < maxConcurrentChunks && nextChunkIndexToLaunch < chunks.length && !criticalErrorInAttempt && !cancelCurrentTranslation) { // Check global flag
            const currentChunkIndex = nextChunkIndexToLaunch++;
            runningTasksCount++;
            
            progressCallback(identifier, completedChunksInAttempt / chunks.length, `Starting Chunk ${currentChunkIndex + 1}/${chunks.length}`);
            
            const previousChunkDataForContext = (currentChunkIndex > 0) ? chunks[currentChunkIndex - 1] : null;
            
            // Collect upcoming chunk context (first 5 entries from next chunk)
            let upcomingChunkContext = null;
            if (currentChunkIndex < chunks.length - 1) {
                const nextChunk = chunks[currentChunkIndex + 1];
                const firstFiveEntries = nextChunk.slice(0, 5);
                const contextTexts = firstFiveEntries.map(entry => entry.text);
                if (contextTexts.length > 0) {
                    upcomingChunkContext = contextTexts.join('\n');
                }
            }
    
            const taskPromise = processSingleChunkWithRetries(
                chunks[currentChunkIndex],
                currentChunkIndex,
                targetLanguage,
                sourceLanguageNameForPrompt, // Pass this down
                enrichedSettings,
                logCallback,
                jobId,
                gfc,
                previousChunkDataForContext, // Pass the previous chunk's original entries
                chunks, // Pass all chunks for next context collection
                summaryContent // Pass summaryContent to processSingleChunkWithRetries
            )
                .then(validatedBlocks => {
                  chunkResultsForAttempt[currentChunkIndex] = { blocks: validatedBlocks, error: null };
                })
                    .catch(err => {
                        chunkResultsForAttempt[currentChunkIndex] = { blocks: null, error: err };
                        criticalErrorInAttempt = true; // Stop launching new tasks for this file attempt
                    })
                    .finally(() => {
                      runningTasksCount--;
                      completedChunksInAttempt++;
                      progressCallback(identifier, completedChunksInAttempt / chunks.length, `Chunk ${currentChunkIndex + 1} finished. (${completedChunksInAttempt}/${chunks.length})`);
                      if (!cancelCurrentTranslation && !criticalErrorInAttempt) { // Check global flag
                         launchTaskIfNeeded(); // Try to launch another task
                      }
                    });
                allPromisesForAttempt.push(taskPromise);
            }
        };

        launchTaskIfNeeded(); // Start initial batch

        await Promise.allSettled(allPromisesForAttempt); // Wait for all initiated tasks in this attempt to settle

        await Promise.allSettled(allPromisesForAttempt); // Wait for all initiated tasks in this attempt to settle
    
        if (cancelCurrentTranslation) { // Check global flag
          logCallback(Date.now(), `Translation process for ${identifierForLogging} (Job ID: ${jobId}) was cancelled during attempt ${fileAttempt}.`, 'warn');
          progressCallback(identifier, 1, 'Cancelled');
          return { status: 'Cancelled' };
        }
    
        let allChunksSuccessfulThisAttempt = true;
        const translatedSRTBlocksForFile = [];
        for (let i = 0; i < chunks.length; i++) {
            const result = chunkResultsForAttempt[i];
            if (!result || result.error) { // If result is null (task didn't run due to early critical error) or has error
                allChunksSuccessfulThisAttempt = false;
                // Error already logged by processSingleChunkWithRetries or implied by criticalErrorInAttempt
                break;
            }
            translatedSRTBlocksForFile.push(...result.blocks);
        }

        if (allChunksSuccessfulThisAttempt) {
            try {
              const finalSRTContent = srtParser.composeSRT(translatedSRTBlocksForFile);
              if (chunks.length > 0) {
                  const lastSuccessfullyProcessedChunkData = chunks[chunks.length - 1]; // original entries of the last chunk
                  const lastEntries = lastSuccessfullyProcessedChunkData.slice(-3);
                  previousSuccessfullyProcessedChunkLastThreeLines = lastEntries.map(entry => entry.text).join(" \\n ");
              }


              // Use identifier for base name, ensuring it's safe for file system
              const baseName = path.parse(identifierForLogging).name;
              const outputFileName = `${baseName}-${targetLanguage}.srt`;
              const outputDirFullPath = path.dirname(identifier);
              await fs.mkdir(outputDirFullPath, { recursive: true });
              const outputPath = path.join(outputDirFullPath, outputFileName);
              await fs.writeFile(outputPath, finalSRTContent, 'utf8');
              logCallback(Date.now(), `SRT data for ${identifierForLogging} (Job ID: ${jobId}) translated successfully. Saved to ${outputPath}`, 'info');
              progressCallback(identifier, 1, 'Success');
              return { status: 'Success', outputPath: outputPath };
            } catch (error) {
              const saveErrorMsg = `Failed to save translated file for ${identifierForLogging} (Job ID: ${jobId}): ${error.message}`;
              logCallback(Date.now(), saveErrorMsg, 'error');
              progressCallback(identifier, 1, `Error saving: ${error.message}`);
              return { status: 'Error', error: saveErrorMsg };
            }
          } else { // Some chunk(s) failed in this single attempt
            // Find the first error to report
            let firstErrorMsg = 'File processing failed due to one or more chunk failures.';
            // Ensure chunkResultsForAttempt is defined and an array before iterating
            if (Array.isArray(chunkResultsForAttempt)) {
                for (let i = 0; i < chunkResultsForAttempt.length; i++) {
                    const result = chunkResultsForAttempt[i];
                    if (result && result.error) {
                        const errorMessage = result.error.message ? result.error.message : String(result.error);
                        firstErrorMsg = `File processing failed. Chunk ${i + 1} error: ${errorMessage}`;
                        break;
                    }
                }
            }
            logCallback(Date.now(), `Processing for ${identifierForLogging} (Job ID: ${jobId}) failed: ${firstErrorMsg}`, 'error');
            progressCallback(identifier, 1, 'Error: Chunk processing failed');
            return { status: 'Error', error: firstErrorMsg };
          }
        // File processing is now a single pass, no loop end here.
      
        // This part should no longer be reachable as all success/error paths are handled earlier.
        // The function should have returned in the 'if (allChunksSuccessfulThisAttempt)' block or its 'else' counterpart.
}

module.exports = {
  processSRTFile,
  setTranslationCancellation,
};
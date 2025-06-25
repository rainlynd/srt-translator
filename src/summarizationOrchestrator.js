/**
 * @fileoverview Orchestrates the summarization and terminology extraction process for SRT files.
 */

const { parseSRT, srtEntriesToText, combineSrtText } = require('./srtUtils'); // Assuming srtUtils.js exists or will be created
const summarizationHelper = require('./summarizationHelper');
const geminiService = require('./geminiService'); // To access countTokens and summarizeAndExtractTermsChunk
const { getSettings } = require('./settingsManager'); // To get default settings

const DEFAULT_MAX_TOKENS_PER_SUMMARY_CHUNK = 10000; // As per plan
const DEFAULT_MODEL_ALIAS_FOR_SUMMARIZATION = 'primary'; // Or make configurable

/**
 * Processes an SRT file's content to generate a summary and extract key terminologies.
 *
 * @param {object} jobDetails - Details of the summarization job.
 * @param {string} jobDetails.jobId - Unique identifier for the job.
 * @param {string} jobDetails.srtContent - The raw SRT content string.
 * @param {string} jobDetails.sourceLanguageFullName - Full name of the source language (e.g., "English").
 * @param {string} jobDetails.targetLanguageFullName - Full name of the target language (e.g., "Chinese (Simplified)").
 * @param {object} jobDetails.settings - Application settings, including API keys, model names, etc.
 * @param {object} jobDetails.gfc - Global File Admission Controller instance.
 * @param {function} jobDetails.logCallback - Function to log messages (jobId, message, type).
 * @param {function} jobDetails.progressCallback - Function to report progress (jobId, percentage, statusText).
 * @param {AbortSignal} [jobDetails.abortSignal] - Optional AbortSignal to cancel the operation.
 * @param {string} jobDetails.baseSummaryPrompt - The base prompt string for summarization.
 * @returns {Promise<{ status: "Success" | "Error" | "Cancelled", summaryContent?: string, error?: string }>}
 *          A promise that resolves with the outcome of the summarization process.
 */
async function processSrtForSummarization(jobDetails) {
  const {
    jobId,
    srtContent,
    sourceLanguageFullName,
    targetLanguageFullName,
    settings, // Contains gemini specific settings like temperature, topP, model names
    gfc,
    logCallback,
    progressCallback,
    abortSignal,
    baseSummaryPrompt // This needs to be passed in, e.g., from main.js after reading summary_prompt.py content
  } = jobDetails;

  logCallback(jobId, `Starting summarization for job ${jobId}. Source: ${sourceLanguageFullName}, Target: ${targetLanguageFullName}`, 'info');

  try {
    if (abortSignal?.aborted) {
      logCallback(jobId, 'Summarization cancelled before starting.', 'warn');
      return { status: 'Cancelled', error: 'Operation cancelled' };
    }

    progressCallback(jobId, 0, 'Parsing SRT content...');
    const srtEntries = parseSRT(srtContent);
    if (!srtEntries || srtEntries.length === 0) {
      logCallback(jobId, 'No valid SRT entries found.', 'warn');
      return { status: 'Success', summaryContent: "" }; // Or 'Error' if this is unexpected
    }
    const fullText = combineSrtText(srtEntries); // Using combineSrtText from srtUtils
    if (!fullText.trim()) {
        logCallback(jobId, 'SRT content is empty after parsing.', 'warn');
        return { status: 'Success', summaryContent: "" };
    }

    progressCallback(jobId, 5, 'Chunking text for summarization...');
    // Determine language code for sentence splitting (simple mapping for now)
    // This might need a more robust mapping based on sourceLanguageFullName
    let languageCodeForChunking = 'default';
    if (sourceLanguageFullName.toLowerCase().includes('chinese')) languageCodeForChunking = 'chinese';
    else if (sourceLanguageFullName.toLowerCase().includes('japanese')) languageCodeForChunking = 'japanese';
    else if (sourceLanguageFullName.toLowerCase().includes('korean')) languageCodeForChunking = 'korean';
    else if (sourceLanguageFullName.toLowerCase().includes('english')) languageCodeForChunking = 'english';

    // Calculate maxCharsPerChunk based on settings
    const avgCharsPerToken = settings.avgCharsPerTokenForSummarization || 3.5;
    const maxTokensTarget = settings.maxTokensPerSummaryChunk || DEFAULT_MAX_TOKENS_PER_SUMMARY_CHUNK;
    const maxCharsPerChunk = Math.floor(maxTokensTarget * avgCharsPerToken);
    logCallback(jobId, `Chunking by character count. Target tokens: ${maxTokensTarget}, Avg chars/token: ${avgCharsPerToken}, Max chars/chunk: ${maxCharsPerChunk}`, 'debug');

    // Use the new character-based chunking function
    // Note: chunkTextByCharCount is synchronous as it doesn't call the token estimator API.
    const textChunks = summarizationHelper.chunkTextByCharCount(
      fullText,
      maxCharsPerChunk,
      languageCodeForChunking
    );

    if (!textChunks || textChunks.length === 0) {
      logCallback(jobId, 'No text chunks generated for summarization.', 'warn');
      return { status: 'Success', summaryContent: "" };
    }

    logCallback(jobId, `Text chunked into ${textChunks.length} parts for summarization.`, 'info');

    let accumulatedSummary = { theme: "", terms: [] };
    let existingTermsString = ""; // To pass to formatSummaryPrompt

    const totalChunks = textChunks.length;
    for (let i = 0; i < totalChunks; i++) {
      if (abortSignal?.aborted) {
        logCallback(jobId, `Summarization cancelled during chunk ${i + 1}/${totalChunks}.`, 'warn');
        return { status: 'Cancelled', error: 'Operation cancelled' };
      }

      const chunkProgress = 10 + Math.floor((i / totalChunks) * 80); // Progress from 10% to 90%
      progressCallback(jobId, chunkProgress, `Summarizing chunk ${i + 1} of ${totalChunks}...`);

      const textChunk = textChunks[i];
      const currentSummarySystemPrompt = summarizationHelper.formatSummaryPrompt(
        baseSummaryPrompt,
        sourceLanguageFullName,
        targetLanguageFullName,
        existingTermsString
      );

      // Retry logic for summarization API call
      let attempt = 0;
      const maxAttempts = settings.maxRetries ? settings.maxRetries + 1 : 3; // e.g., 2 retries = 3 attempts
      let lastError = null;
      let currentModelAlias = settings.summarizationModelAlias || DEFAULT_MODEL_ALIAS_FOR_SUMMARIZATION; // Primary model for summarization
      const retryModelAlias = settings.summarizationRetryModelAlias; // Specific retry model for summarization

      while (attempt < maxAttempts) {
        if (abortSignal?.aborted) throw new Error('Operation cancelled during retry loop');
        attempt++;
        logCallback(jobId, `Attempt ${attempt}/${maxAttempts} for summarizing chunk ${i + 1} with model ${currentModelAlias}.`, 'info');

        try {
          const inputTokensForChunk = await geminiService.countTokens(textChunk + currentSummarySystemPrompt, currentModelAlias);
          await gfc.requestApiResources(jobId, inputTokensForChunk); // 'summarize' type for GFC

          const geminiApiSettings = {
            temperature: settings.temperature, // Use general settings or summarization-specific
            topP: settings.topP,
            thinkingBudget: settings.thinkingBudget, // from global settings
            maxOutputTokens: settings.maxOutputTokensForSummarization || 8192, // summarization specific
          };

          const { summaryResponse, actualInputTokens, outputTokens } = await geminiService.summarizeAndExtractTermsChunk(
            textChunk,
            currentSummarySystemPrompt,
            geminiApiSettings,
            targetLanguageFullName, // Pass targetLanguageFullName
            currentModelAlias,
            abortSignal
          );
          gfc.releaseApiResources(jobId, actualInputTokens, outputTokens);

          // Aggregate results
          if (summaryResponse.theme && summaryResponse.theme.trim()) {
            accumulatedSummary.theme += (accumulatedSummary.theme ? "\n\n" : "") + summaryResponse.theme.trim();
          }

          if (summaryResponse.terms && summaryResponse.terms.length > 0) {
            const newTermsToAdd = [];
            const existingSrcTermsLowerCase = accumulatedSummary.terms.map(term => term.src.toLowerCase());

            for (const newTerm of summaryResponse.terms) {
              const newTermSrcLowerCase = newTerm.src.toLowerCase();
              // Check 1: Not already in the terms *being added from this current API response*
              const alreadyInCurrentResponseBatch = newTermsToAdd.some(t => t.src.toLowerCase() === newTermSrcLowerCase);
              // Check 2: Not already in the `accumulatedSummary.terms` from *previous chunks*
              const alreadyInAccumulated = existingSrcTermsLowerCase.includes(newTermSrcLowerCase);

              if (!alreadyInCurrentResponseBatch && !alreadyInAccumulated) {
                newTermsToAdd.push(newTerm);
              } else {
                logCallback(jobId, `Duplicate term found and skipped: '${newTerm.src}'. In current batch: ${alreadyInCurrentResponseBatch}, In accumulated: ${alreadyInAccumulated}.`, 'debug');
              }
            }

            if (newTermsToAdd.length > 0) {
              accumulatedSummary.terms.push(...newTermsToAdd);
              // Rebuild existingTermsString for the next iteration's prompt
              existingTermsString = "Previously extracted terms:\n" +
                accumulatedSummary.terms.map(t => `- ${t.src} (translated: ${t.tgt})${t.note ? ': ' + t.note : ''}`).join("\n");
            }
          }
          lastError = null; // Success
          break; // Exit retry loop
        } catch (error) {
          gfc.releaseApiResources(jobId, 0, 0); // Release with 0 if request failed before getting token counts
          lastError = error;
          logCallback(jobId, `Error summarizing chunk ${i + 1} (attempt ${attempt}/${maxAttempts}) with model ${currentModelAlias}: ${error.message}`, 'error');

          if (abortSignal?.aborted) {
            logCallback(jobId, 'Summarization cancelled due to abort signal during API call.', 'warn');
            return { status: 'Cancelled', error: 'Operation cancelled' };
          }

          if (attempt < maxAttempts) {
            if (retryModelAlias && currentModelAlias !== retryModelAlias) {
              logCallback(jobId, `Switching to retry model ${retryModelAlias} for next attempt.`, 'warn');
              currentModelAlias = retryModelAlias;
            }
            const delay = Math.pow(2, attempt -1) * (settings.initialRetryDelay || 1000); // Exponential backoff
            logCallback(jobId, `Waiting ${delay}ms before next attempt...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      } // End retry loop

      if (lastError) {
        // All attempts failed for this chunk
        logCallback(jobId, `All ${maxAttempts} attempts failed for chunk ${i + 1}. Proceeding without summary for this chunk. Error: ${lastError.message}`, 'error');
        // Optionally, decide if the whole process should fail or continue
        // For now, let's continue and the final summary will be partial.
      }
    } // End chunk loop

    progressCallback(jobId, 95, 'Formatting final summary...');
    const finalSummaryContent = summarizationHelper.formatSummaryOutputForTranslationPrompt(accumulatedSummary);

    if (!finalSummaryContent.trim()) {
        logCallback(jobId, 'Summarization complete, but no content was generated for the summary.', 'warn');
    } else {
        logCallback(jobId, 'Summarization process completed successfully.', 'info');
    }
    progressCallback(jobId, 100, 'Summarization complete.');
    return { status: 'Success', summaryContent: finalSummaryContent };

  } catch (error) {
    logCallback(jobId, `Critical error during summarization process: ${error.message}`, 'error');
    console.error(`[Job ${jobId}] Summarization Orchestrator Error:`, error);
    progressCallback(jobId, 100, 'Summarization failed.');
    return {
      status: 'Error',
      error: error.message,
      summaryContent: "" // Ensure empty string on error
    };
  }
}

module.exports = {
  processSrtForSummarization,
};
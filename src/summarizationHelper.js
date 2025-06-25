/**
 * @fileoverview Helper functions for the summarization and terminology extraction stage.
 */

/**
 * Defines sentence-ending punctuation for various languages.
 * Used for splitting text into sentences before chunking by token count.
 */
const SENTENCE_ENDINGS = {
  // Chinese, Japanese, Korean (CJK) often use full-width punctuation.
  // English uses standard punctuation.
  chinese: /[。\uff01\uff1f]/g, // Full-width period, exclamation mark, question mark
  japanese: /[。\uff01\uff1f]/g, // Full-width period, exclamation mark, question mark
  korean: /[.\uff01\uff1f]/g, // Period (can be half-width), full-width exclamation/question mark
  english: /[.!?]/g,
  default: /[.!?。\uff01\uff1f]/g, // A general set for mixed or unspecified languages
};

/**
 * Splits text into sentences based on language-specific or default punctuation.
 * @param {string} text The text to split.
 * @param {string} languageCode A simple language code (e.g., 'chinese', 'japanese', 'korean', 'english')
 *                              to determine which sentence endings to use.
 * @returns {string[]} An array of sentences.
 */
function splitIntoSentences(text, languageCode = 'default') {
  const regex = SENTENCE_ENDINGS[languageCode.toLowerCase()] || SENTENCE_ENDINGS.default;
  // Split by the punctuation, but keep the punctuation at the end of the sentence.
  // This can be complex. A simpler approach is to add a delimiter, split, then re-add.
  // Or, split and then map to re-add.
  // For now, a simpler split and join approach for chunking:
  // Find all matches, then slice the text based on match indices.

  if (!text) return [];

  const sentences = [];
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    sentences.push(text.substring(lastIndex, match.index + match[0].length).trim());
    lastIndex = match.index + match[0].length;
  }
  // Add any remaining text after the last punctuation
  if (lastIndex < text.length) {
    sentences.push(text.substring(lastIndex).trim());
  }
  // Filter out any empty strings that might result from consecutive delimiters or trailing spaces.
  return sentences.filter(s => s.length > 0);
}


/**
 * Chunks text for summarization based on token limits and sentence endings.
 *
 * @param {string} fullText The complete text to be chunked.
 * @param {number} maxTokensPerChunk The maximum number of tokens allowed per chunk for the text content.
 * @param {string} modelAlias The model alias (e.g., "gemini-1.5-flash-latest") to be used for token counting.
 * @param {object} geminiServiceInstance An instance of the GeminiService, expected to have a countTokens method.
 * @param {string} languageCode Language code for sentence splitting (e.g., 'chinese', 'english').
 * @returns {Promise<string[]>} A promise that resolves to an array of text chunks.
 * @throws {Error} if token counting fails or geminiServiceInstance is invalid.
 */
async function chunkTextForSummarization_OLD_TOKEN_BASED( // Renamed
  fullText,
  maxTokensPerChunk,
  modelAlias,
  geminiServiceInstance,
  languageCode = 'default'
) {
  if (!geminiServiceInstance || typeof geminiServiceInstance.countTokens !== 'function') {
    throw new Error('Invalid geminiServiceInstance or countTokens method is missing for token-based chunking.');
  }

  const sentences = splitIntoSentences(fullText, languageCode);
  if (sentences.length === 0) {
    return [];
  }

  const chunks = [];
  let currentChunkSentences = [];
  let currentChunkTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = await geminiServiceInstance.countTokens(sentence, modelAlias);

    if (currentChunkTokens + sentenceTokens <= maxTokensPerChunk) {
      currentChunkSentences.push(sentence);
      currentChunkTokens += sentenceTokens;
    } else {
      if (currentChunkSentences.length > 0) {
        chunks.push(currentChunkSentences.join(' '));
      }
      currentChunkSentences = [sentence];
      currentChunkTokens = sentenceTokens;
      // If a single sentence itself exceeds maxTokensPerChunk, it becomes its own chunk.
      // This behavior is maintained.
      if (currentChunkTokens > maxTokensPerChunk && currentChunkSentences.length === 1) {
        // console.warn(`Single sentence exceeds maxTokensPerChunk (${currentChunkTokens} > ${maxTokensPerChunk}). It will form its own chunk.`);
        // No special handling needed here as it will be pushed in the next iteration or at the end.
      }
    }
  }

  if (currentChunkSentences.length > 0) {
    chunks.push(currentChunkSentences.join(' '));
  }

  return chunks;
}


/**
 * Chunks text for summarization based on character limits and sentence endings.
 *
 * @param {string} fullText The complete text to be chunked.
 * @param {number} maxCharsPerChunk The maximum number of characters allowed per chunk.
 * @param {string} languageCode Language code for sentence splitting (e.g., 'chinese', 'english').
 * @returns {string[]} An array of text chunks.
 */
function chunkTextByCharCount(fullText, maxCharsPerChunk, languageCode = 'default') {
  const sentences = splitIntoSentences(fullText, languageCode);
  if (sentences.length === 0) {
    return [];
  }

  const chunks = [];
  let currentChunkSentences = [];
  let currentCharCount = 0;

  for (const sentence of sentences) {
    const sentenceCharCount = sentence.length; // Using simple length for char count

    if (currentCharCount + sentenceCharCount <= maxCharsPerChunk) {
      currentChunkSentences.push(sentence);
      currentCharCount += sentenceCharCount;
    } else {
      // Current sentence would exceed max characters for the current chunk
      if (currentChunkSentences.length > 0) {
        chunks.push(currentChunkSentences.join(' '));
      }
      // Start a new chunk with the current sentence
      currentChunkSentences = [sentence];
      currentCharCount = sentenceCharCount;

      // If a single sentence itself exceeds maxCharsPerChunk, it becomes its own chunk.
      // This ensures even very long sentences are processed.
      if (currentCharCount > maxCharsPerChunk && currentChunkSentences.length === 1) {
        // console.warn(`Single sentence exceeds maxCharsPerChunk (${currentCharCount} > ${maxCharsPerChunk}). It will form its own chunk.`);
        // The current logic will push this oversized sentence as its own chunk
        // either in the next iteration's 'else' block (if another sentence follows)
        // or in the final push after the loop.
        // To be absolutely sure it's pushed if it's the *only* thing and too long:
        // No, the current logic handles it: if it's too long, the next sentence will trigger the 'else',
        // pushing this current oversized one. If it's the last sentence and too long, the final push handles it.
      }
    }
  }

  // Add the last remaining chunk
  if (currentChunkSentences.length > 0) {
    chunks.push(currentChunkSentences.join(' '));
  }

  return chunks;
}


/**
 * Formats the summary prompt by replacing placeholders.
 *
 * @param {string} baseSummaryPrompt The base prompt string (e.g., from a file or settings).
 * @param {string} srcLangFullName Full name of the source language (e.g., "Chinese (Simplified)").
 * @param {string} tgtLangFullName Full name of the target language (e.g., "English").
 * @param {string} existingTermsString A string of already extracted terms, formatted for inclusion in the prompt.
 *                                     Example: "Previously extracted terms:\n- Term1: Explanation1\n- Term2: Explanation2"
 * @returns {string} The fully formatted system prompt for the summarization API call.
 */
function formatSummaryPrompt(baseSummaryPrompt, srcLangFullName, tgtLangFullName, existingTermsString) {
  // Implementation to be added based on the actual placeholders in baseSummaryPrompt
  // Assuming placeholders like {src_lang}, {tgt_lang}, {terms_note}
  let prompt = baseSummaryPrompt;
  prompt = prompt.replace(/{src_lang}/g, srcLangFullName);
  prompt = prompt.replace(/{tgt_lang}/g, tgtLangFullName);

  // The plan mentions "{terms_note} equivalent".
  // If existingTermsString is empty, the note might be different or omitted.
  const termsNotePlaceholder = /{terms_note}/g;
  if (existingTermsString && existingTermsString.trim().length > 0) {
    prompt = prompt.replace(termsNotePlaceholder, existingTermsString);
  } else {
    // Replace with an empty string or a neutral message if no terms yet
    prompt = prompt.replace(termsNotePlaceholder, "");
  }
  return prompt;
}

/**
 * Formats the final aggregated summary and terms into a string for the translation prompt.
 *
 * @param {object} accumulatedSummary An object containing the aggregated theme and terms.
 * @param {string} accumulatedSummary.theme The overall theme/summary string.
 * @param {Array<object>} accumulatedSummary.terms An array of term objects, where each object
 *                                                has `src`, `tgt`, and `note` properties.
 * @returns {string} A formatted string to be injected into the translation prompt's
 *                   {summary_content} placeholder, or an empty string if no summary/terms.
 */
function formatSummaryOutputForTranslationPrompt(accumulatedSummary) {
  if (!accumulatedSummary || (!accumulatedSummary.theme && (!accumulatedSummary.terms || accumulatedSummary.terms.length === 0))) {
    return ""; // Return empty if no theme and no terms
  }

  let output = "## Theme & Glossary\n";

  if (accumulatedSummary.theme && accumulatedSummary.theme.trim().length > 0) {
    output += `${accumulatedSummary.theme.trim()}`;
  }

  if (accumulatedSummary.terms && accumulatedSummary.terms.length > 0) {
    accumulatedSummary.terms.forEach(term => {
      output += `- ${term.src}`;
      if (term.tgt) {
        output += ` (translated: ${term.tgt})`;
      }
      if (term.note) {
        output += `: ${term.note}`;
      }
      output += "\n";
    });
  }
  // Remove trailing newline if any
  return output.trim();
}

module.exports = {
  chunkTextForSummarization_OLD_TOKEN_BASED, // Keep old one for now, renamed
  chunkTextByCharCount, // Export new function
  formatSummaryPrompt,
  formatSummaryOutputForTranslationPrompt,
  // Expose for potential testing or direct use if needed
  splitIntoSentences,
  SENTENCE_ENDINGS
};
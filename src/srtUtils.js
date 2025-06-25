/**
 * @fileoverview Utilities for parsing and handling SRT (SubRip Text) subtitle files.
 */

/**
 * Represents a single SRT entry.
 * @typedef {object} SRTEntry
 * @property {number} index - The sequential index of the subtitle.
 * @property {string} startTime - The start timestamp (e.g., "00:00:20,000").
 * @property {string} endTime - The end timestamp (e.g., "00:00:24,400").
 * @property {string} text - The subtitle text content (can be multi-line).
 */

/**
 * Parses raw SRT content into an array of SRTEntry objects.
 * Handles variations in line endings (CRLF, LF).
 *
 * @param {string} srtContent The raw SRT content as a string.
 * @returns {SRTEntry[]} An array of parsed SRT entries. Returns an empty array if content is invalid or empty.
 */
function parseSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string' || srtContent.trim() === '') {
    return [];
  }

  const entries = [];
  // Normalize line endings to LF for consistent splitting
  const normalizedContent = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalizedContent.split(/\n\n+/); // Split by one or more blank lines

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) { // Minimum: index, timestamp, text line
      // console.warn('Skipping invalid SRT block:', block);
      continue;
    }

    const index = parseInt(lines[0], 10);
    if (isNaN(index)) {
      // console.warn('Skipping SRT block with invalid index:', lines[0], 'Full block:', block);
      continue;
    }

    const timeLine = lines[1];
    const timeMatch = timeLine.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!timeMatch) {
      // console.warn('Skipping SRT block with invalid time format:', timeLine, 'Full block:', block);
      continue;
    }
    const startTime = timeMatch[1];
    const endTime = timeMatch[2];

    const text = lines.slice(2).join('\n').trim();
    if (!text) {
        // console.warn('Skipping SRT block with empty text:', block);
        continue; // Skip if text is empty after parsing
    }

    entries.push({ index, startTime, endTime, text });
  }

  return entries;
}

/**
 * Combines the text content from an array of SRT entries into a single string.
 * Texts are typically joined by a space or newline for different processing needs.
 * For summarization, joining with a space is often preferred to maintain flow.
 *
 * @param {SRTEntry[]} srtEntries An array of SRTEntry objects.
 * @returns {string} A single string containing all concatenated text from the SRT entries,
 *                   separated by a single space. Returns an empty string if input is empty.
 */
function combineSrtText(srtEntries) {
  if (!srtEntries || srtEntries.length === 0) {
    return "";
  }
  return srtEntries.map(entry => entry.text).join(' ').trim();
}

/**
 * Reconstructs an SRT formatted string from an array of SRTEntry objects.
 * @param {SRTEntry[]} srtEntries - An array of SRTEntry objects.
 * @returns {string} A string formatted in SRT format.
 */
function reconstructSRT(srtEntries) {
    if (!srtEntries || srtEntries.length === 0) {
        return "";
    }
    return srtEntries.map(entry => {
        return `${entry.index}\n${entry.startTime} --> ${entry.endTime}\n${entry.text}`;
    }).join('\n\n') + '\n\n'; // Ensure trailing newlines for valid SRT
}


module.exports = {
  parseSRT,
  combineSrtText,
  reconstructSRT, // Added for general utility, might be used by translation orchestrator
};
const fs = require('fs').promises;

/**
 * Reads an SRT file and parses its content into an array of structured SRT entry objects.
 * Each object contains the index, timestamp, text, and the original raw block string.
 * @param {string} filePath - The path to the SRT file.
 * @returns {Promise<Array<{index: string, timestamp: string, text: string, originalBlock: string}>>}
 *          A promise that resolves to an array of structured SRT entry objects.
 * @throws {Error} If the file cannot be read or if any block within the file is malformed.
 */
async function parseSRT(filePath) {
  let fileData;
  try {
    fileData = await fs.readFile(filePath, 'utf8');
  } catch (readError) {
    console.error(`Error reading SRT file at ${filePath}:`, readError);
    throw new Error(`Failed to read SRT file "${filePath}": ${readError.message}`);
  }
  return parseSRTContentLogic(fileData, filePath); // Delegate to common logic
}

/**
 * Parses SRT content from a string into an array of structured SRT entry objects.
 * Each object contains the index, timestamp, text, and the original raw block string.
 * @param {string} srtContent - The SRT content as a string.
 * @param {string} [identifier='SRT Content'] - An identifier for logging errors (e.g., file path or "SRT Content").
 * @returns {Array<{index: string, timestamp: string, text: string, originalBlock: string}>}
 *          An array of structured SRT entry objects.
 * @throws {Error} If any block within the content is malformed.
 */
function parseSRTContent(srtContent, identifier = 'SRT Content') {
  if (typeof srtContent !== 'string') {
    throw new Error('Invalid input: srtContent must be a string.');
  }
  return parseSRTContentLogic(srtContent, identifier);
}

/**
 * Common logic for parsing SRT data from a string.
 * @param {string} data - The SRT data as a string.
 * @param {string} identifier - Identifier for logging (e.g., file path or "SRT Content").
 * @returns {Array<{index: string, timestamp: string, text: string, originalBlock: string}>}
 */
function parseSRTContentLogic(data, identifier) {
  // Normalize line endings (replace \r\n with \n, then handle \r if any left)
  const normalizedData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split by one or more newlines that are typically used to separate blocks.
  // Then filter out any resulting empty strings from multiple blank lines.
  const rawBlocks = normalizedData.split(/\n\n+/).filter(block => block.trim() !== '');

  const structuredEntries = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const rawBlockString = rawBlocks[i].trim(); // Use trimmed version for component extraction
    const originalBlockForStorage = rawBlockString + '\n\n'; // Store with consistent double newline

    try {
      const components = extractSRTBlockComponents(rawBlockString);
      const timeParts = components.timestamp.split(' --> ');
      if (timeParts.length !== 2) {
        // This case should ideally be caught by extractSRTBlockComponents's timestamp regex,
        // but as a safeguard or if the regex changes:
        throw new Error(`Invalid timestamp format in block: "${components.timestamp}" in ${identifier}`);
      }
      const startTimeSeconds = srtTimeToSeconds(timeParts[0]);
      const endTimeSeconds = srtTimeToSeconds(timeParts[1]);

      structuredEntries.push({
        index: components.index,
        timestamp: components.timestamp, // Keep original string
        text: components.text,
        originalBlock: originalBlockForStorage,
        startTimeSeconds: startTimeSeconds,
        endTimeSeconds: endTimeSeconds
      });
    } catch (blockParseError) {
      console.error(`Error parsing block ${i + 1} in ${identifier}: ${blockParseError.message} - Block content: "${rawBlockString.substring(0, 70)}..."`);
      // Augment error with identifier and block context
      throw new Error(`Error in ${identifier}, block ${i + 1} (starting with "${rawBlockString.substring(0, 30)}..."): ${blockParseError.message}`);
    }
  }
  return structuredEntries;
}

/**
 * Takes an array of fully translated and validated SRT entry block strings
 * and concatenates them to form the final translated SRT file content.
 * @param {string[]} translatedSrtBlocks - An array of translated SRT entry block strings.
 * @returns {string} - The concatenated SRT file content.
 */
function composeSRT(translatedSrtBlocks) {
  // Join blocks. Since each block should already end with \n\n,
  // direct concatenation should be fine.
  // If there's a concern about too many newlines, we can trim each block first
  // and then join with \n\n, but the parseSRT ensures they end correctly.
  return translatedSrtBlocks.join('');
}

/**
 * Extracts the index, timestamp, and text from a single SRT block string.
 * Assumes a generally well-formed block structure.
 * @param {string} srtBlockString - A single SRT block string (e.g., "1\n00:00:00,050 --> 00:00:00,775\nText"). The input string is trimmed internally.
 * @returns {{index: string, timestamp: string, text: string}} - An object with components.
 * @throws {Error} If the block structure is invalid (e.g., missing index, timestamp, or invalid format).
 */
function extractSRTBlockComponents(srtBlockString) {
  if (!srtBlockString || typeof srtBlockString !== 'string') {
    throw new Error('Invalid input: srtBlockString must be a non-empty string.');
  }

  const trimmedBlock = srtBlockString.trim();
  const lines = trimmedBlock.split('\n');

  if (lines.length < 2) {
    // Minimum: index and timestamp. Text can be empty but its line(s) should effectively exist.
    // If text is empty, lines.length might be 2 (index, timestamp) after trimming.
    // If text is one line, lines.length is 3.
    throw new Error(`Invalid SRT block structure: Not enough lines. Found ${lines.length}, expected at least 2 (index, timestamp). Block: "${trimmedBlock.substring(0, 50)}..."`);
  }

  const index = lines[0].trim();
  if (!/^\d+$/.test(index)) {
    throw new Error(`Invalid SRT block: Index is not a number. Found: "${index}". Block: "${trimmedBlock.substring(0, 50)}..."`);
  }

  const timestamp = lines[1].trim();
  if (!/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(timestamp)) {
    throw new Error(`Invalid SRT block: Timestamp format incorrect. Found: "${timestamp}". Block: "${trimmedBlock.substring(0, 50)}..."`);
  }

  // Text is everything from the third line onwards. If only 2 lines, text is empty.
  const text = lines.slice(2).join('\n').trim();
  // Note: We are not validating if text is empty here, as empty text is valid in SRT.
  // The calling context (e.g., translation validation) might check for empty translated text.

  return { index, timestamp, text };
}

/**
 * Converts an SRT time string (HH:MM:SS,ms) to total seconds.
 * @param {string} timeString - The SRT time string.
 * @returns {number} - The time in total seconds (float).
 * @throws {Error} If the timeString format is invalid.
 */
function srtTimeToSeconds(timeString) {
  if (typeof timeString !== 'string') {
    throw new Error('Invalid input: timeString must be a string.');
  }
  const parts = timeString.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!parts) {
    throw new Error(`Invalid SRT time format: "${timeString}". Expected HH:MM:SS,ms.`);
  }
  const hours = parseInt(parts[1], 10);
  const minutes = parseInt(parts[2], 10);
  const seconds = parseInt(parts[3], 10);
  const milliseconds = parseInt(parts[4], 10);

  if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(milliseconds)) {
    // This should ideally not be reached if the regex matches.
    throw new Error(`Invalid time components in SRT time string: "${timeString}"`);
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/**
 * Formats total seconds into HH:MM:SS,ms SRT timestamp string.
 * @param {number} totalSeconds - The total seconds (can be float).
 * @returns {string} - The formatted SRT timestamp.
 */
function formatSrtTime(totalSeconds) {
  if (typeof totalSeconds !== 'number' || !isFinite(totalSeconds) || totalSeconds < 0) {
    throw new Error(`Invalid time value for SRT formatting: "${totalSeconds}". Must be a finite non-negative number.`);
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

/**
 * Composes a complete SRT content string from an array of re-segmented entries.
 * Each entry is an object: { index (optional, will be overridden), start, end, text }.
 * @param {Array<{start: number, end: number, text: string}>} resegmentedEntries - Array of re-segmented objects.
 * @returns {string} - The final SRT content string.
 */
function composeResegmentedSRT(resegmentedEntries) {
  if (!Array.isArray(resegmentedEntries)) {
    throw new Error('Invalid input: resegmentedEntries must be an array.');
  }

  return resegmentedEntries.map((entry, i) => {
    const index = i + 1; // Sequential 1-based index
    const startTime = formatSrtTime(entry.start);
    const endTime = formatSrtTime(entry.end);
    // Ensure text doesn't have leading/trailing newlines from API that would break SRT structure
    const text = entry.text.trim();
    return `${index}\n${startTime} --> ${endTime}\n${text}\n\n`;
  }).join('');
}


module.exports = {
  parseSRT,
  parseSRTContent,
  composeSRT,
  extractSRTBlockComponents,
  formatSrtTime,
  srtTimeToSeconds, // Added export
  composeResegmentedSRT,
  chunkSRTEntries,
};

/**
 * Splits an array of SRT entry objects (or strings) into smaller arrays (chunks).
 * @param {Array<object|string>} srtEntries - The array of SRT entries (can be structured objects or strings).
 * @param {number} chunkSize - The maximum number of entries per chunk.
 * @returns {Array<Array<object|string>>} - An array of chunks.
 */
function chunkSRTEntries(srtEntries, chunkSize) {
  if (!Array.isArray(srtEntries)) {
    throw new Error('Input srtEntries must be an array.');
  }
  if (typeof chunkSize !== 'number' || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive number.');
  }
  const chunks = [];
  for (let i = 0; i < srtEntries.length; i += chunkSize) {
    chunks.push(srtEntries.slice(i, i + chunkSize));
  }
  return chunks;
}
/**
 * @fileoverview Utility for redirecting console output to a log file.
 */
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { app } = require('electron');
const util = require('node:util');

let logStream = null;
let logFilePath = '';

/**
 * Formats a message for logging.
 * @param {string} level - Log level (e.g., INFO, WARN, ERROR, DEBUG).
 * @param {Array<any>} args - Arguments passed to the console method.
 * @returns {string} Formatted log message.
 */
function formatLogMessage(level, args) {
  const timestamp = new Date().toISOString();
  // util.format handles string interpolation and object formatting similar to console.log
  const message = args.map(arg => {
    if (typeof arg === 'object' && arg !== null) {
      try {
        return util.inspect(arg, { depth: null, colors: false }); // Convert objects to string
      } catch (e) {
        return '[Uninspectable Object]';
      }
    }
    return String(arg); // Ensure everything else is a string
  }).join(' ');
  return `${timestamp} [${level}] ${message}\n`;
}

/**
 * Initializes the file logger.
 * Overrides console methods to write to a log file.
 */
async function setupFileLogger() {
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    await fsp.mkdir(logsDir, { recursive: true });
    logFilePath = path.join(logsDir, 'app.log');

    // Create a writable stream. 'a' flag for appending.
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    logStream.on('error', (err) => {
      // Fallback to original console if stream fails
      console.error_original('Log stream error:', err);
      logStream = null; // Stop trying to write to a broken stream
    });

    console.log_original = console.log;
    console.warn_original = console.warn;
    console.error_original = console.error;
    console.debug_original = console.debug; // Store original debug

    console.log = (...args) => {
      console.log_original.apply(console, args);
      if (logStream) {
        logStream.write(formatLogMessage('INFO', args));
      }
    };

    console.warn = (...args) => {
      console.warn_original.apply(console, args);
      if (logStream) {
        logStream.write(formatLogMessage('WARN', args));
      }
    };

    console.error = (...args) => {
      console.error_original.apply(console, args);
      if (logStream) {
        logStream.write(formatLogMessage('ERROR', args));
      }
    };

    console.debug = (...args) => {
      console.debug_original.apply(console, args);
      if (logStream) {
        logStream.write(formatLogMessage('DEBUG', args));
      }
    };

    console.log_original(`File logging initialized. Log file: ${logFilePath}`);
    return true;
  } catch (error) {
    if (console.error_original) {
        console.error_original('Failed to initialize file logger:', error);
    } else {
        // This case should ideally not happen if console.error_original is set first
        console.error('Failed to initialize file logger (original console.error not available):', error);
    }
    return false;
  }
}

/**
 * Closes the log stream. Should be called on app quit.
 */
function closeLogStream() {
  if (logStream) {
    logStream.end(() => {
      if (console.log_original) {
        console.log_original('Log stream closed.');
      }
    });
    logStream = null;
  }
}

module.exports = {
  setupFileLogger,
  closeLogStream,
  getLogFilePath: () => logFilePath, // For potential access if needed
};
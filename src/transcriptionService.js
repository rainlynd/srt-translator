const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises; // Use promises for async operations
const fsSync = require('fs'); // For synchronous operations like existsSync
const { app } = require('electron'); // Import app

// Placeholder for Python executable. This will need to be determined
// by the Python bundling/installation process.
// For development, ensure 'python' or 'python3' is in PATH or provide full path.
let PYTHON_EXECUTABLE;
let SCRIPT_PATH;
if (app.isPackaged) {
  // In packaged app, resources are at the root of process.resourcesPath
  SCRIPT_PATH = path.join(process.resourcesPath, 'python', 'video_to_srt.py');
  
  // Point to the bundled Python executable within the .venv directory
  PYTHON_EXECUTABLE = process.platform === 'win32'
    ? path.join(process.resourcesPath, '.venv', 'Scripts', 'python.exe')
    : path.join(process.resourcesPath, '.venv', 'bin', 'python');
} else {
  // In development, construct path relative to the project root
  SCRIPT_PATH = path.join(app.getAppPath(), 'src', 'python', 'video_to_srt.py');
  // Use Python from the virtual environment in development
  const venvPythonPath = process.platform === 'win32'
    ? path.join(app.getAppPath(), '.venv', 'Scripts', 'python.exe')
    : path.join(app.getAppPath(), '.venv', 'bin', 'python');
  
  if (fsSync.existsSync(venvPythonPath)) {
    PYTHON_EXECUTABLE = venvPythonPath;
  } else {
    // Fallback to system Python if .venv interpreter isn't found, with a warning.
    console.warn(`Virtual environment Python not found at ${venvPythonPath}. Falling back to system Python. Ensure your .venv is set up correctly.`);
    PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python.exe' : 'python3';
  }
}

// Store active processes to allow cancellation
const activeProcesses = new Map();

async function startVideoToSrtTranscription(jobId, videoPath, outputSrtPath, settings, progressCallback, logCallback) {
    try {
        if (!fsSync.existsSync(SCRIPT_PATH)) {
            const errorMsg = `Python script not found at ${SCRIPT_PATH}`;
            logCallback('error', errorMsg);
            throw new Error(errorMsg);
        }

        // Ensure the output directory exists if outputSrtPath is provided
        if (outputSrtPath) {
            try {
                await fs.mkdir(path.dirname(outputSrtPath), { recursive: true });
            } catch (dirError) {
                const errorMsg = `Failed to create output directory ${path.dirname(outputSrtPath)}: ${dirError.message}`;
                logCallback('error', errorMsg);
                throw new Error(errorMsg);
            }
        }

        const pythonArgs = [
            SCRIPT_PATH,
            videoPath,
        ];

        if (outputSrtPath) {
            pythonArgs.push('--output_srt_path', outputSrtPath);
        }

        // Determine model cache path
        const userDataPath = app.getPath('userData');
        const modelCachePath = path.join(userDataPath, 'whisperx_models');
        try {
            if (!fsSync.existsSync(modelCachePath)) {
                fsSync.mkdirSync(modelCachePath, { recursive: true });
            }
            pythonArgs.push('--model_cache_path', modelCachePath);
            logCallback('info', `WhisperX model cache path set to: ${modelCachePath}`);
        } catch (cacheError) {
            logCallback('error', `Failed to create or access model cache directory ${modelCachePath}: ${cacheError.message}. WhisperX will use its default cache.`);
            // Python script will use default if --model_cache_path is not provided or if it fails to use the provided one.
        }
        
        // Add arguments from settings object based on the new plan
        if (settings) {
            // settings.language is from globalSettings.transcriptionSourceLanguage (via transcriptionSettings in main.js)
            // If null/empty, WhisperX auto-detects.
            if (settings.language) {
                pythonArgs.push('--language', settings.language);
            }
            
            // settings.compute_type is from allSettings (via transcriptionSettings in main.js)
            if (settings.compute_type) {
                pythonArgs.push('--compute_type', settings.compute_type);
            }

            // Diarization settings
            // settings.enable_diarization is from globalSettings.enableDiarization (via transcriptionSettings in main.js)
            // settings.huggingFaceToken is from allSettings (via transcriptionSettings in main.js)
            if (settings.enable_diarization) {
                pythonArgs.push('--enable_diarization');
                if (settings.huggingFaceToken) {
                    pythonArgs.push('--hf_token', settings.huggingFaceToken);
                }
            }
            
            // These arguments are from allSettings (via transcriptionSettings in main.js)
            if (settings.condition_on_previous_text) {
                pythonArgs.push('--condition_on_previous_text');
            }
            if (settings.threads && typeof settings.threads === 'number' && settings.threads > 0) {
                pythonArgs.push('--threads', settings.threads.toString());
            }
            // Temperature is hardcoded in the Python script, so no argument for it here.
            // Removed VAD, (old)cpu_threads, num_workers
        }

        // Debug print for the Python script command and arguments
        console.log(`[TranscriptionService] Spawning Python script. Executable: "${PYTHON_EXECUTABLE}"`);
        console.log(`[TranscriptionService] Arguments: ${JSON.stringify(pythonArgs, null, 2)}`);
        // End debug print

        logCallback('info', `Spawning Python script: ${PYTHON_EXECUTABLE} ${pythonArgs.join(' ')}`);

        const pythonProcess = spawn(PYTHON_EXECUTABLE, pythonArgs, {
        });

        activeProcesses.set(jobId, pythonProcess);

        // Return a new Promise here to wrap the event-driven process
        return new Promise((resolve, reject) => {
            let srtData = '';
        let lastProgressJsonLine = ''; // Buffer for incomplete JSON lines from stdout
        let lastStderrJsonLine = ''; // Buffer for incomplete JSON lines from stderr
        let structuredErrorFromStderr = null; // To store parsed error from stderr
        let detectedLanguageInfo = null; // Declare detectedLanguageInfo here

        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            logCallback('debug', `Python stdout: ${output}`);

            // Process potentially multiple lines or partial lines
            const lines = (lastProgressJsonLine + output).split(/\r?\n/);
            lastProgressJsonLine = lines.pop(); // Store potential partial line

            lines.forEach(line => {
                if (line.startsWith('PROGRESS_JSON:')) {
                    try {
                        const jsonString = line.substring('PROGRESS_JSON:'.length);
                        const progress = JSON.parse(jsonString);
                        if (progress.type === 'info' && progress.detected_language) {
                            detectedLanguageInfo = progress; // Store the whole info object
                        }
                        progressCallback(progress); // Forward all progress, including 'info' type
                        if (progress.type === 'error') {
                            logCallback('error', `Python script reported error: ${progress.message}`);
                        }
                    } catch (e) {
                        logCallback('error', `Error parsing progress JSON from Python: ${e.message}. Line: "${line}"`);
                    }
                } else if (!outputSrtPath && line.trim().length > 0) {
                    // If no outputSrtPath, assume remaining stdout is SRT data
                    // This needs careful handling if PROGRESS_JSON is mixed with direct SRT output
                    // The Python script is designed to print SRT to stdout ONLY if no output_srt_path is given
                    // and AFTER all PROGRESS_JSON messages or as one block at the end.
                    // Current python script prints SRT at the very end if no output_srt_path.
                    srtData += line + '\n';
                }
            });
        });
        
        // Handle the last buffered line if it's a complete JSON object
        if (lastProgressJsonLine.startsWith('PROGRESS_JSON:')) {
            try {
                const jsonString = lastProgressJsonLine.substring('PROGRESS_JSON:'.length);
                const progress = JSON.parse(jsonString);
                if (progress.type === 'info' && progress.detected_language) {
                    detectedLanguageInfo = progress;
                }
                progressCallback(progress);
                 if (progress.type === 'error') {
                    logCallback('error', `Python script reported error (buffered): ${progress.message}`);
                }
            } catch (e) {
                 logCallback('error', `Error parsing buffered progress JSON from Python: ${e.message}. Line: "${lastProgressJsonLine}"`);
            }
        } else if (!outputSrtPath && lastProgressJsonLine.trim().length > 0) {
            srtData += lastProgressJsonLine + '\n'; // Add any remaining part as SRT
        }


        pythonProcess.stderr.on('data', (data) => {
            const rawStderr = data.toString();
            logCallback('debug', `Python stderr raw: ${rawStderr}`);

            const lines = (lastStderrJsonLine + rawStderr).split(/\r?\n/);
            lastStderrJsonLine = lines.pop() || ''; // Store potential partial line, ensure it's a string

            lines.forEach(line => {
                if (line.trim()) { // Process non-empty lines
                    try {
                        const errorJson = JSON.parse(line);
                        if (errorJson.error_code && errorJson.message) {
                            structuredErrorFromStderr = errorJson; // Store the first valid structured error
                            logCallback('error', `Python script reported structured error (stderr): ${errorJson.message} (Code: ${errorJson.error_code})`);
                            // Optionally, inform progressCallback immediately
                            progressCallback({ type: 'error', message: errorJson.message, error_code: errorJson.error_code, details: errorJson.details });
                        } else {
                            logCallback('warn', `Python stderr (non-structured JSON): ${line}`);
                        }
                    } catch (e) {
                        // Not a JSON line, or malformed JSON. Treat as regular stderr.
                        logCallback('error', `Python stderr (non-JSON): ${line}`);
                    }
                }
            });
        });

        pythonProcess.on('error', (err) => {
            logCallback('error', `Failed to start Python process: ${err.message}`);
            activeProcesses.delete(jobId);
            reject(err);
        });

        pythonProcess.on('close', (code) => {
            logCallback('info', `Python process exited with code ${code}`);
            activeProcesses.delete(jobId);

            // Handle any remaining buffered stderr line
            if (lastStderrJsonLine.trim() && !structuredErrorFromStderr) {
                 try {
                    const errorJson = JSON.parse(lastStderrJsonLine);
                    if (errorJson.error_code && errorJson.message) {
                        structuredErrorFromStderr = errorJson;
                        logCallback('error', `Python script reported structured error (buffered stderr): ${errorJson.message} (Code: ${errorJson.error_code})`);
                        progressCallback({ type: 'error', message: errorJson.message, error_code: errorJson.error_code, details: errorJson.details });
                    } else {
                         logCallback('warn', `Python stderr (non-structured JSON, buffered): ${lastStderrJsonLine}`);
                    }
                } catch (e) {
                    logCallback('error', `Python stderr (non-JSON, buffered): ${lastStderrJsonLine}`);
                }
            }

            if (code === 0) {
                // outputSrtPath will always be provided by the modified video pipeline.
                // The Python script writes the file. Resolve with its path.
                resolve({
                    srtFilePath: outputSrtPath, // This is the cachedSrtFilePath passed in
                    srtContent: null, // Content is in the file
                    detectedLanguage: detectedLanguageInfo ? detectedLanguageInfo.detected_language : null,
                    languageProbability: detectedLanguageInfo ? detectedLanguageInfo.language_probability : null
                });
            } else {
                if (structuredErrorFromStderr) {
                    reject(new Error(`Python script failed: ${structuredErrorFromStderr.message} (Code: ${structuredErrorFromStderr.error_code}, exit code ${code})`));
                } else {
                    // Fallback to stdout PROGRESS_JSON error if stderr didn't provide a structured one
                    let lastProgressStdout;
                    try {
                        if(lastProgressJsonLine.startsWith('PROGRESS_JSON:')) {
                            lastProgressStdout = JSON.parse(lastProgressJsonLine.substring('PROGRESS_JSON:'.length));
                        }
                    } catch(e) { /* ignore parsing error here */ }

                    if (lastProgressStdout && lastProgressStdout.type === 'error') {
                         reject(new Error(`Python script failed: ${lastProgressStdout.message} (exit code ${code})`));
                    } else {
                        reject(new Error(`Python script exited with error code ${code}. Check stderr/logs for details.`));
                    }
                }
            }
        }); // End of Promise
    }); // End of activeProcesses.set
    } catch (initialError) {
        // Catch errors from initial checks (file exists, mkdir)
        return Promise.reject(initialError);
    }
}

function cancelTranscription(jobId) {
    const process = activeProcesses.get(jobId);
    if (process) {
        try {
            // Attempt to kill the process.
            // On Windows, taskkill is more reliable for killing subprocess trees if Python spawns its own.
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', process.pid, '/f', '/t']);
            } else {
                process.kill('SIGTERM'); // Send SIGTERM first
                // Set a timeout to send SIGKILL if it doesn't terminate
                setTimeout(() => {
                    if (!process.killed) {
                        process.kill('SIGKILL');
                    }
                }, 5000); // 5 seconds grace period
            }
            activeProcesses.delete(jobId);
            return true;
        } catch (error) {
            console.error(`Error cancelling process ${jobId}:`, error);
            // Fallback or log
            if (!process.killed) {
                 try { process.kill('SIGKILL'); } catch (e) { console.error('Failed to SIGKILL:', e); }
            }
            activeProcesses.delete(jobId); // ensure it's removed
            return false;
        }
    }
    return false; // Process not found
}

module.exports = {
    startVideoToSrtTranscription,
    cancelTranscription,
};
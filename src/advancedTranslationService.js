const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises; // Use promises for async operations
const fsSync = require('fs'); // For synchronous operations like existsSync
const { app } = require('electron'); // Import app

let PYTHON_EXECUTABLE;
let SCRIPT_PATH;

if (app.isPackaged) {
  // In packaged app, 'python' directory is at the root of resourcesPath.
  // The advanced_translator_pipeline package is expected to be inside this 'python' directory.
  SCRIPT_PATH = path.join(process.resourcesPath, 'python', 'advanced_translator_pipeline', 'pipeline_orchestrator.py');
  PYTHON_EXECUTABLE = process.platform === 'win32' 
    ? path.join(process.resourcesPath, 'python_dist', 'python.exe') // Example if Python is bundled
    : path.join(process.resourcesPath, 'python_dist', 'bin', 'python'); // Adjust as per bundling strategy
  // Fallback if not bundled, assuming system Python (less ideal for packaged app)
  if (!fsSync.existsSync(PYTHON_EXECUTABLE)) {
    console.warn(`Packaged Python executable not found at expected location: ${PYTHON_EXECUTABLE}. Falling back to system Python.`);
    PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python.exe' : 'python3';
  }
} else {
  // In development, script is relative to project root.
  SCRIPT_PATH = path.join(app.getAppPath(), 'advanced_translator_pipeline', 'pipeline_orchestrator.py');
  // Use Python from the virtual environment in development
  const venvPythonPath = process.platform === 'win32'
    ? path.join(app.getAppPath(), '.venv', 'Scripts', 'python.exe')
    : path.join(app.getAppPath(), '.venv', 'bin', 'python');
  
  if (fsSync.existsSync(venvPythonPath)) {
    PYTHON_EXECUTABLE = venvPythonPath;
  } else {
    console.warn(`Virtual environment Python not found at ${venvPythonPath}. Falling back to system Python. Ensure your .venv is set up correctly.`);
    PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python.exe' : 'python3';
  }
}

// Store active processes to allow cancellation
const activeProcesses = new Map();

// Generic function to run the Python pipeline
async function runAdvancedPipeline(jobId, pipelineMode, inputFilePath, sourceLang, targetLang, pythonPipelineConfig, progressCallback, logCallback) {
    try {
        if (!fsSync.existsSync(SCRIPT_PATH)) {
            const errorMsg = `Advanced pipeline script not found at ${SCRIPT_PATH}`;
            logCallback('error', errorMsg);
            throw new Error(errorMsg);
        }
        if (!fsSync.existsSync(PYTHON_EXECUTABLE)) {
            const errorMsg = `Python executable not found at ${PYTHON_EXECUTABLE}. Please ensure Python is installed and configured correctly.`;
            logCallback('error', errorMsg);
            throw new Error(errorMsg);
        }

        const userDataPath = app.getPath('userData');
        const baseCachePath = path.join(userDataPath, 'advanced_pipeline_cache', jobId); // Job-specific cache path
        const outputSrtFileName = `output_${Date.now()}.srt`;
        const outputSrtPath = path.join(baseCachePath, outputSrtFileName);

        try {
            await fs.mkdir(baseCachePath, { recursive: true });
            logCallback('info', `Job cache path created: ${baseCachePath}`);
        } catch (dirError) {
            const errorMsg = `Failed to create job cache directory ${baseCachePath}: ${dirError.message}`;
            logCallback('error', errorMsg);
            throw new Error(errorMsg);
        }

        const pythonArgs = [
            SCRIPT_PATH,
            '--input_file', inputFilePath,
            '--pipeline_mode', pipelineMode,
            '--target_lang', targetLang,
            '--config_json', JSON.stringify(pythonPipelineConfig || {}),
            '--cache_path', baseCachePath, // Python script will manage subdirs within this
            '--output_srt_path', outputSrtPath,
        ];

        if (sourceLang) {
            pythonArgs.push('--source_lang', sourceLang);
        }
        
        console.log(`[AdvancedTranslationService] Spawning Python script. Executable: "${PYTHON_EXECUTABLE}"`);
        console.log(`[AdvancedTranslationService] Arguments: ${JSON.stringify(pythonArgs, null, 2)}`);
        logCallback('info', `Spawning Python script: ${PYTHON_EXECUTABLE} ${pythonArgs.join(' ')}`);

        const pythonProcess = spawn(PYTHON_EXECUTABLE, pythonArgs, {});
        activeProcesses.set(jobId, pythonProcess);

        return new Promise((resolve, reject) => {
            let lastProgressJsonLine = '';
            let lastStderrJsonLine = '';
            let structuredErrorFromStderr = null;
            let detectedSourceLanguageInfo = null; // For potential language detection feedback

            pythonProcess.stdout.on('data', (data) => {
                const output = data.toString();
                logCallback('debug', `Python stdout: ${output}`);

                const lines = (lastProgressJsonLine + output).split(/\r?\n/);
                lastProgressJsonLine = lines.pop() || '';

                lines.forEach(line => {
                    if (line.startsWith('PROGRESS_JSON:')) {
                        try {
                            const jsonString = line.substring('PROGRESS_JSON:'.length);
                            const progress = JSON.parse(jsonString);
                            if (progress.type === 'info' && progress.detected_source_language) {
                                detectedSourceLanguageInfo = progress;
                            }
                            progressCallback(progress);
                            if (progress.type === 'error') {
                                logCallback('error', `Python script reported error: ${progress.message}`);
                            }
                        } catch (e) {
                            logCallback('error', `Error parsing progress JSON from Python: ${e.message}. Line: "${line}"`);
                        }
                    } else if (line.trim().length > 0) {
                        // Any other non-empty stdout line is logged, but not treated as primary result.
                        // The primary result is the SRT file written to outputSrtPath.
                        logCallback('info', `Python stdout (other): ${line}`);
                    }
                });
            });
            
            // Handle final buffered stdout line
            if (lastProgressJsonLine.startsWith('PROGRESS_JSON:')) {
                try {
                    const jsonString = lastProgressJsonLine.substring('PROGRESS_JSON:'.length);
                    const progress = JSON.parse(jsonString);
                     if (progress.type === 'info' && progress.detected_source_language) {
                        detectedSourceLanguageInfo = progress;
                    }
                    progressCallback(progress);
                    if (progress.type === 'error') {
                        logCallback('error', `Python script reported error (buffered): ${progress.message}`);
                    }
                } catch (e) {
                    logCallback('error', `Error parsing buffered progress JSON from Python: ${e.message}. Line: "${lastProgressJsonLine}"`);
                }
            } else if (lastProgressJsonLine.trim().length > 0) {
                 logCallback('info', `Python stdout (other, buffered): ${lastProgressJsonLine}`);
            }


            pythonProcess.stderr.on('data', (data) => {
                const rawStderr = data.toString();
                logCallback('debug', `Python stderr raw: ${rawStderr}`);

                const lines = (lastStderrJsonLine + rawStderr).split(/\r?\n/);
                lastStderrJsonLine = lines.pop() || '';

                lines.forEach(line => {
                    if (line.trim()) {
                        try {
                            const errorJson = JSON.parse(line);
                            if (errorJson.error_code && errorJson.message) {
                                structuredErrorFromStderr = errorJson;
                                logCallback('error', `Python script reported structured error (stderr): ${errorJson.message} (Code: ${errorJson.error_code})`);
                                progressCallback({ type: 'error', message: errorJson.message, error_code: errorJson.error_code, details: errorJson.details });
                            } else {
                                logCallback('warn', `Python stderr (non-structured JSON): ${line}`);
                            }
                        } catch (e) {
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
                    // Verify the output SRT file was created by Python
                    if (fsSync.existsSync(outputSrtPath)) {
                        resolve({
                            srtFilePath: outputSrtPath,
                            detectedSourceLanguage: detectedSourceLanguageInfo ? detectedSourceLanguageInfo.detected_source_language : null,
                            // Add other relevant info from detectedSourceLanguageInfo if needed
                        });
                    } else {
                        const errMsg = `Python script finished successfully (code 0) but output SRT file not found at ${outputSrtPath}`;
                        logCallback('error', errMsg);
                        reject(new Error(errMsg));
                    }
                } else {
                    if (structuredErrorFromStderr) {
                        reject(new Error(`Python script failed: ${structuredErrorFromStderr.message} (Code: ${structuredErrorFromStderr.error_code}, exit code ${code})`));
                    } else {
                        let lastProgressStdoutError;
                        try {
                            if(lastProgressJsonLine.startsWith('PROGRESS_JSON:')) {
                                const parsed = JSON.parse(lastProgressJsonLine.substring('PROGRESS_JSON:'.length));
                                if (parsed.type === 'error') lastProgressStdoutError = parsed;
                            }
                        } catch(e) { /* ignore */ }

                        if (lastProgressStdoutError) {
                             reject(new Error(`Python script failed: ${lastProgressStdoutError.message} (exit code ${code})`));
                        } else {
                            reject(new Error(`Python script exited with error code ${code}. Check stderr/logs for details.`));
                        }
                    }
                }
            });
        });
    } catch (initialError) {
        return Promise.reject(initialError);
    }
}

async function startFullPipeline(jobId, inputFilePath, targetLang, pythonPipelineConfig, progressCallback, logCallback) {
    // For full pipeline (video/audio), source language is typically detected by ASR, so not passed initially.
    // The Python orchestrator will handle ASR language detection.
    return runAdvancedPipeline(jobId, 'full', inputFilePath, null, targetLang, pythonPipelineConfig, progressCallback, logCallback);
}

async function startSrtTranslationPipeline(jobId, srtInputPath, sourceLang, targetLang, pythonPipelineConfig, progressCallback, logCallback) {
    if (!sourceLang) {
        const errorMsg = "Source language must be provided for SRT translation pipeline.";
        logCallback('error', errorMsg);
        return Promise.reject(new Error(errorMsg));
    }
    return runAdvancedPipeline(jobId, 'srt_translate', srtInputPath, sourceLang, targetLang, pythonPipelineConfig, progressCallback, logCallback);
}

function cancelAdvancedTranslation(jobId) {
    const processToKill = activeProcesses.get(jobId);
    if (processToKill) {
        try {
            logCallback('info', `Attempting to cancel advanced translation job: ${jobId}, PID: ${processToKill.pid}`);
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', processToKill.pid, '/f', '/t']);
            } else {
                processToKill.kill('SIGTERM'); // Send SIGTERM first
                setTimeout(() => {
                    if (!processToKill.killed) {
                        logCallback('warn', `Process ${jobId} (PID: ${processToKill.pid}) did not terminate with SIGTERM, sending SIGKILL.`);
                        processToKill.kill('SIGKILL');
                    }
                }, 3000); // 3 seconds grace period
            }
            activeProcesses.delete(jobId);
            logCallback('info', `Cancellation signal sent for job ${jobId}.`);
            return true;
        } catch (error) {
            console.error(`Error cancelling process ${jobId} (PID: ${processToKill.pid}):`, error);
            logCallback('error', `Error cancelling process ${jobId}: ${error.message}`);
            // Fallback or log
            if (processToKill && !processToKill.killed) {
                 try { processToKill.kill('SIGKILL'); } catch (e) { console.error('Failed to SIGKILL after error:', e); }
            }
            activeProcesses.delete(jobId); // ensure it's removed
            return false;
        }
    }
    logCallback('warn', `No active process found for job ID: ${jobId} to cancel.`);
    return false; // Process not found
}

module.exports = {
    startFullPipeline,
    startSrtTranslationPipeline,
    cancelAdvancedTranslation,
};
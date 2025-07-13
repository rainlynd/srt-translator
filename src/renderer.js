/**
 * This file will automatically be loaded by webpack and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.js` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

import './index.css';
// For preload script approach, window.api will be used.

// --- DOM Elements ---
// --- DOM Elements ---
// Global Controls Area
const globalTargetLanguageInput = document.getElementById('global-target-language');
const globalSourceLanguageSelect = document.getElementById('global-source-language');
const globalDiarizationCheckbox = document.getElementById('global-diarization-enable');
const globalThinkingEnableCheckbox = document.getElementById('global-thinking-enable'); // Added

// Tab Buttons
const tabButtons = document.querySelectorAll('.tab-button'); // This selector should still work

// Tab Content Areas
const translateVideosTab = document.getElementById('translate-videos-tab');
const translateSrtTab = document.getElementById('translate-srt-tab');
const logTab = document.getElementById('log-tab');
const settingsTab = document.getElementById('settings-tab');
const allTabContents = document.querySelectorAll('.tab-content'); // This selector should still work

// "Translate Videos" Tab Elements
const selectVideoFilesButton = document.getElementById('select-video-files-button');
const startVideoProcessingButton = document.getElementById('start-video-processing-button');
const cancelVideoProcessingButton = document.getElementById('cancel-video-processing-button');
const videoFileListArea = document.getElementById('video-file-list-area');

// "Translate SRT" Tab Elements
const selectSrtFilesButton = document.getElementById('select-srt-files-button');
const startSrtProcessingButton = document.getElementById('start-srt-processing-button');
const cancelSrtProcessingButton = document.getElementById('cancel-srt-processing-button');
const srtFileListArea = document.getElementById('srt-file-list-area');
const globalRecursiveSelectionCheckbox = document.getElementById('global-recursive-selection'); // Added

// Log Tab
const logArea = document.getElementById('log-area');

// Settings Tab
const apiKeyInput = document.getElementById('api-key');
const geminiModelSelect = document.getElementById('gemini-model-select');
const geminiModelCustomInput = document.getElementById('gemini-model-custom');
const strongerGeminiModelSelect = document.getElementById('stronger-gemini-model-select'); // Added
const strongerGeminiModelCustomInput = document.getElementById('stronger-gemini-model-custom'); // Added
const systemPromptInput = document.getElementById('system-prompt');
const temperatureInput = document.getElementById('temperature');
const topPInput = document.getElementById('top-p');
const entriesPerChunkInput = document.getElementById('entries-per-chunk');
const chunkRetriesInput = document.getElementById('chunk-retries'); // Added
const rpmInput = document.getElementById('rpm');
const loadDefaultsButton = document.getElementById('load-defaults-button');

// Simplified Transcription Settings Elements
const transcriptionComputeTypeSelect = document.getElementById('transcription-compute-type'); // Kept
const huggingFaceTokenInput = document.getElementById('huggingface-token'); // Added
const transcriptionConditionOnPreviousTextCheckbox = document.getElementById('transcription-condition-on-previous-text'); // Added
const transcriptionThreadsInput = document.getElementById('transcription-threads'); // Added
const saveSettingsButton = document.getElementById('save-settings-button'); // Added

// Removed references to detailed transcription settings elements

const settingsErrorDisplayDiv = document.createElement('div'); // For displaying settings-related errors
settingsErrorDisplayDiv.id = 'settings-error-display';
settingsErrorDisplayDiv.style.color = 'red';
settingsErrorDisplayDiv.style.marginTop = '10px';
// Will append this div to the settings tab later in DOMContentLoaded or where appropriate.


// --- Application State (Renderer Side) ---
let selectedVideoFiles = []; // Array of { path: string, name: string, status: 'Pending'|'Processing'|'Success'|'Error'|'Cancelled', progress: 0, stage?: 'transcribing'|'translating', element?: HTMLElement, jobId?: string }
let selectedSrtFiles = [];   // Array of { path: string, name: string, status: 'Pending'|'Processing'|'Success'|'Error'|'Cancelled', progress: 0, element?: HTMLElement, jobId?: string }

let currentSettings = {}; // To be loaded from main process
let activeVideoJobDetails = { isProcessing: false }; // Tracks if a video batch is active
let activeSrtJobDetails = { jobIds: new Set(), isProcessing: false }; // Tracks if an SRT batch is active
// --- SRT Button Hold State ---
let srtHoldTimeoutId = null;
let srtCountdownIntervalId = null;
let srtCountdownValue = 0;
const SRT_HOLD_DURATION = 3000; // 3 seconds in milliseconds
let originalSrtButtonText = 'Start Translations'; // Default, will be updated in DOMContentLoaded
let isSrtButtonHeld = false;
// --- End SRT Button Hold State ---

let advancedTranscriptionSettingsVisible = false; // State for advanced settings toggle

// --- ISO Language List ---
// A more comprehensive list might be needed, or fetched dynamically. This is a sample.
const isoLanguages = [
    { name: "Auto-detect", code: "" }, // For source language list
    { name: "English", code: "en" },
    { name: "Chinese", code: "zh" },
    { name: "Korean", code: "ko" },
    { name: "Japanese", code: "ja" },
];

// Add "None - Disable Translation" option
const baseTargetLanguages = isoLanguages.filter(lang => lang.code !== "");
const targetLanguagesWithNone = [
    { name: "None - Disable Translation", code: "none" },
    ...baseTargetLanguages
];

// --- Helper Functions ---
function populateLanguageDropdown(selectElement, languages, defaultSelectedCode = null) {
    if (!selectElement) return;
    selectElement.innerHTML = ''; // Clear existing options
    languages.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang.code;
        option.textContent = lang.name;
        if (defaultSelectedCode && lang.code === defaultSelectedCode) {
            option.selected = true;
        }
        selectElement.appendChild(option);
    });
}

function displaySettingsError(message) {
    if (settingsErrorDisplayDiv) {
        settingsErrorDisplayDiv.textContent = message;
    }
    if (message) {
        appendToLog(`Settings Error: ${message}`, 'error', true);
    }
}

function updateHfTokenRelevance() {
    if (!globalDiarizationCheckbox || !globalSourceLanguageSelect || !huggingFaceTokenInput) {
        return;
    }
    const isDiarizationEnabled = globalDiarizationCheckbox.checked;
    const isChineseLanguage = globalSourceLanguageSelect.value.toLowerCase().startsWith('zh');
    const hfTokenNeeded = isDiarizationEnabled && !isChineseLanguage;

    const hfTokenGroup = huggingFaceTokenInput.closest('.form-group');

    if (hfTokenGroup) {
        hfTokenGroup.style.display = ''; // Always show the group
    }
    // Assuming hfTokenGroup is reliably found based on the HTML structure.
    // If not, an error or different handling might be needed, but hiding the input directly is not the goal here.

    const hfTokenNote = huggingFaceTokenInput.parentElement.querySelector('p.settings-note');
    if (hfTokenNote) {
        if (isDiarizationEnabled && isChineseLanguage) {
            hfTokenNote.textContent = 'Not needed for Chinese diarization (FunASR is used).';
        } else if (isDiarizationEnabled && !isChineseLanguage) { // This condition is when hfTokenNeeded would be true
            hfTokenNote.textContent = 'REQUIRED for diarization with non-Chinese languages.';
        } else { // Diarization not enabled
            hfTokenNote.textContent = 'Optional. Enter if you plan to use diarization for non-Chinese languages.';
        }
    }
}

// --- Helper function to update start button states based on language selection and file presence ---
function updateStartButtonStates() {
    const targetLang = globalTargetLanguageInput.value;
    const sourceLang = globalSourceLanguageSelect.value;
    let disableDueToLanguageConflict = false;

    if (targetLang && sourceLang && targetLang === sourceLang && sourceLang !== "") {
        disableDueToLanguageConflict = targetLang !== "none"; // Conflict only if targetLang is not "none"
        // Optionally, display a persistent warning message
        // For now, disabling buttons is the primary feedback.
        // Consider adding a dedicated warning element in HTML if more prominent feedback is needed.
    } else {
    }

    // Video Tab
    if (startVideoProcessingButton) {
        const videoFilesPresent = selectedVideoFiles.length > 0;
        // A file is processable if it's not already successful, actively processing, cancelling, or retrying.
        // 'Pending' or 'Error' or 'Cancelled' (final state) are processable/retryable.
        const videoFilesProcessable = selectedVideoFiles.some(f =>
            f.status === 'Pending' ||
            f.status.startsWith('Failed') || // Covers FailedTranscription, FailedTranslation
            f.status === 'Error' ||
            f.status === 'Cancelled' // Allow re-queueing of cancelled items
        );
        // Allow processing if targetLang is "none" (meaning skip translation)
        const targetLangSelected = targetLang !== "" || targetLang === "none";
        const canStartVideo = videoFilesPresent && videoFilesProcessable && targetLangSelected && !disableDueToLanguageConflict && !activeVideoJobDetails.isProcessing;
        startVideoProcessingButton.disabled = !canStartVideo;
    }

    // SRT Tab
    if (startSrtProcessingButton) {
        const srtFilesPresent = selectedSrtFiles.length > 0;
        const srtFilesProcessable = selectedSrtFiles.some(f =>
            f.status === 'Pending' ||
            f.status.startsWith('Failed') ||
            f.status === 'Error' ||
            f.status === 'Cancelled'
        );
        // Allow processing if targetLang is "none"
        const targetLangSelectedForSrt = targetLang !== "" || targetLang === "none";
        const canStartSrt = srtFilesPresent && srtFilesProcessable && targetLangSelectedForSrt && !disableDueToLanguageConflict && !activeSrtJobDetails.isProcessing && activeSrtJobDetails.jobIds.size === 0;
        
        if (startSrtProcessingButton) {
            startSrtProcessingButton.disabled = !canStartSrt;
            if (canStartSrt && !isSrtButtonHeld) { // If button is enabled and not being held
                // Ensure originalSrtButtonText is the default when it becomes enabled
                originalSrtButtonText = "Start Translations"; // Assuming this is the default text
                startSrtProcessingButton.textContent = originalSrtButtonText;
            } else if (!canStartSrt && !isSrtButtonHeld && startSrtProcessingButton.textContent.startsWith("Starting in")) {
                // If it becomes disabled while a countdown was showing (e.g. language conflict introduced)
                startSrtProcessingButton.textContent = originalSrtButtonText; // Revert to original
            }
        }
    }
}

function executeSrtProcessing() {
    if (selectedSrtFiles.length === 0) {
        alert('No SRT files selected for translation.');
        resetSrtButtonState(); // Reset button if action doesn't proceed
        return;
    }
    // Allow "none" as a valid selection
    if (!globalTargetLanguageInput.value || (globalTargetLanguageInput.value.trim() === "" && globalTargetLanguageInput.value !== "none")) {
        alert('Please select a target language in the Global Controls.');
        resetSrtButtonState(); // Reset button
        return;
    }

    const srtFilePaths = selectedSrtFiles.filter(f => f.status !== 'Success' && f.status !== 'Processing').map(f => f.path);
    if (srtFilePaths.length === 0) {
        alert('All selected SRT files are already processed or currently processing.');
        resetSrtButtonState(); // Reset button
        return;
    }

    activeSrtJobDetails.isProcessing = true;

    selectedSrtFiles.forEach(file => {
        if (srtFilePaths.includes(file.path)) {
            file.status = 'Processing';
            file.progress = 0;
            updateSrtFileListItem(file);
        }
    });

    const globalSettings = {
        targetLanguageCode: globalTargetLanguageInput.value,
        targetLanguageFullName: targetLanguagesWithNone.find(lang => lang.code === globalTargetLanguageInput.value)?.name || globalTargetLanguageInput.value,
        sourceLanguageOfSrt: globalSourceLanguageSelect.value, // Added this line
        thinkingBudget: globalThinkingEnableCheckbox.checked ? -1 : 0,
    };
    
    if (window.electronAPI && window.electronAPI.sendStartSrtBatchProcessingRequest) {
        window.electronAPI.sendStartSrtBatchProcessingRequest({
            srtFilePaths,
            globalSettings,
            allSettings: currentSettings
        });

        startSrtProcessingButton.disabled = true;
        selectSrtFilesButton.disabled = true;
        cancelSrtProcessingButton.disabled = false;

        appendToLog(`SRT batch translation started for ${srtFilePaths.length} file(s) to ${globalSettings.targetLanguageFullName} (Code: ${globalSettings.targetLanguageCode}).`, 'info', true);
        // Button text will be managed by completion/cancellation logic or if it's re-enabled
    } else {
        appendToLog('Error: IPC for starting SRT batch processing not available.', 'error', true);
        activeSrtJobDetails.isProcessing = false;
        // Reset file statuses
        selectedSrtFiles.forEach(file => {
            if (srtFilePaths.includes(file.path)) {
                if (file.status === 'Processing') {
                    file.status = 'Pending'; // Revert to pending
                    updateSrtFileListItem(file);
                }
            }
        });
        resetSrtButtonState(); // Reset button as action failed
        updateStartButtonStates(); // Re-evaluate button states
    }
}

function resetSrtButtonState() {
    clearTimeout(srtHoldTimeoutId);
    clearInterval(srtCountdownIntervalId);
    if (startSrtProcessingButton && !startSrtProcessingButton.disabled && !activeSrtJobDetails.isProcessing) {
        startSrtProcessingButton.textContent = originalSrtButtonText;
    }
    if(startSrtProcessingButton) startSrtProcessingButton.classList.remove('button-hold-active');
    isSrtButtonHeld = false;
    srtCountdownValue = 0;
}


// --- Tab Switching Logic ---
tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        // Deactivate all tabs and buttons
        tabButtons.forEach(btn => btn.classList.remove('active'));
        allTabContents.forEach(content => content.classList.remove('active'));

        // Activate clicked tab and button
        button.classList.add('active');
        const tabId = button.getAttribute('data-tab');
        document.getElementById(tabId).classList.add('active');

        // Special actions when a tab is opened
        if (tabId === 'settings-tab') {
            loadSettingsIntoForm();
        }
    });
});

// --- Control Button Event Listeners (New Structure) ---

// "Translate Videos" Tab Buttons
if (selectVideoFilesButton) {
    selectVideoFilesButton.addEventListener('click', () => {
        if (window.electronAPI) {
            if (globalRecursiveSelectionCheckbox && globalRecursiveSelectionCheckbox.checked) {
                if (window.electronAPI.sendSelectVideoDirectoryRequest) {
                    window.electronAPI.sendSelectVideoDirectoryRequest();
                } else {
                    appendToLog('Error: IPC for selecting video directory not available.', 'error', true);
                    alert('Error: Video directory selection functionality is currently unavailable.');
                }
            } else {
                if (window.electronAPI.sendSelectVideoFilesRequest) {
                    window.electronAPI.sendSelectVideoFilesRequest();
                } else {
                    appendToLog('Error: IPC for selecting video files not available.', 'error', true);
                    alert('Error: Video file selection functionality is currently unavailable.');
                }
            }
        } else {
            appendToLog('Error: IPC for selecting video files/directory not available.', 'error', true);
            alert('Error: Video file/directory selection functionality is currently unavailable.');
        }
    });
}

if (startVideoProcessingButton) {
    startVideoProcessingButton.addEventListener('click', () => {
        if (selectedVideoFiles.length === 0) {
            alert('No video files selected for processing.');
            return;
        }
        // Allow "none" as a valid selection
        if (!globalTargetLanguageInput.value || (globalTargetLanguageInput.value.trim() === "" && globalTargetLanguageInput.value !== "none")) {
            alert('Please select a target language in the Global Controls.');
            return;
        }
         // Removed localModelPath check as WhisperX handles its own model management.

        // Prepare the queue with files that are not already successfully processed or currently processing.
        const videoQueue = selectedVideoFiles.filter(f => f.status !== 'Success' && f.status !== 'Processing');
        if (videoQueue.length === 0) {
            alert('All selected video files are already processed or currently processing.');
            return;
        }
        
        activeVideoJobDetails.isProcessing = true;
        // The coordinator now manages the queue; renderer just tracks that a batch is active.
        // Update UI for all files in the batch to 'Queued'
        videoQueue.forEach(file => {
            const fileInState = selectedVideoFiles.find(f => f.path === file.path);
            if (fileInState) {
                fileInState.status = 'Queued for Transcription'; // Initial state for new pipeline
                fileInState.progress = 0;
                fileInState.stage = 'transcribing'; // Initial stage
                updateVideoFileListItem(fileInState);
            }
        });

        const globalSettingsForVideo = {
            targetLanguageCode: globalTargetLanguageInput.value,
            targetLanguageFullName: targetLanguagesWithNone.find(lang => lang.code === globalTargetLanguageInput.value)?.name || globalTargetLanguageInput.value,
            transcriptionSourceLanguage: globalSourceLanguageSelect.value === "" ? null : globalSourceLanguageSelect.value,
            enableDiarization: globalDiarizationCheckbox.checked,
            thinkingBudget: globalThinkingEnableCheckbox.checked ? -1 : 0, // Added
        };
 
        if (window.electronAPI && window.electronAPI.sendStartVideoQueueProcessingRequest) {
            window.electronAPI.sendStartVideoQueueProcessingRequest({
                videoQueue: videoQueue.map(f => f.path), // Send array of paths
                globalSettings: globalSettingsForVideo,
                allSettings: currentSettings
            });

            startVideoProcessingButton.disabled = true;
            selectVideoFilesButton.disabled = true;
            cancelVideoProcessingButton.disabled = false;
            // Disable SRT tab controls - REMOVED FOR CONCURRENCY

            appendToLog(`Video processing batch started for ${videoQueue.length} video(s).`, 'info', true);
        } else {
            appendToLog('Error: IPC for starting video queue processing not available.', 'error', true);
            activeVideoJobDetails.isProcessing = false; // Reset state
        }
    });
}

if (cancelVideoProcessingButton) {
    cancelVideoProcessingButton.addEventListener('click', () => {
        if (!activeVideoJobDetails.isProcessing) { // Simplified check
            alert('No video processing batch is currently active.');
            return;
        }
        if (window.electronAPI && window.electronAPI.sendCancelVideoQueueProcessingRequest) {
            // No specific jobId needed for batch cancel, coordinator handles it
            window.electronAPI.sendCancelVideoQueueProcessingRequest({});
            appendToLog('Video processing batch cancellation request sent.', 'warn', true);
            
            // Proactively mark files that are not yet completed/failed as 'Cancelling...'
            selectedVideoFiles.forEach(file => {
                if (file.status !== 'Success' && file.status !== 'Error' && file.status !== 'Cancelled' &&
                    !file.status.startsWith('Failed') && !file.status.startsWith('Cancelling')) {
                    file.status = 'Cancelling...';
                    updateVideoFileListItem(file);
                }
            });
            // Main process will send final 'Cancelled' TRANSLATION_FILE_COMPLETED events.
        } else {
            appendToLog('Error: IPC for cancelling video queue processing not available.', 'error', true);
        }
    });
}


// "Translate SRT" Tab Buttons
if (selectSrtFilesButton) {
    selectSrtFilesButton.addEventListener('click', () => {
        if (window.electronAPI) {
            if (globalRecursiveSelectionCheckbox && globalRecursiveSelectionCheckbox.checked) {
                if (window.electronAPI.sendSelectSrtDirectoryRequest) {
                    window.electronAPI.sendSelectSrtDirectoryRequest();
                } else {
                    appendToLog('Error: IPC for selecting SRT directory not available.', 'error', true);
                    alert('Error: SRT directory selection functionality is currently unavailable.');
                }
            } else {
                if (window.electronAPI.sendSelectSrtFilesRequest) {
                    window.electronAPI.sendSelectSrtFilesRequest();
                } else {
                    appendToLog('Error: IPC for selecting SRT files not available.', 'error', true);
                    alert('Error: File selection functionality is currently unavailable.');
                }
            }
        } else {
            appendToLog('Error: IPC for selecting SRT files/directory not available.', 'error', true);
            alert('Error: SRT file/directory selection functionality is currently unavailable.');
        }
    });
}

if (startSrtProcessingButton) {
    // originalSrtButtonText is initialized globally and updated in DOMContentLoaded

    startSrtProcessingButton.addEventListener('mousedown', () => {
        if (startSrtProcessingButton.disabled || isSrtButtonHeld) {
            return;
        }
        // Ensure originalSrtButtonText is current if it could have been changed by other UI updates
        // This check helps if the button text was changed by something other than this hold mechanism
        // and then the user tries to hold it.
        if (!activeSrtJobDetails.isProcessing && !startSrtProcessingButton.disabled) {
             originalSrtButtonText = startSrtProcessingButton.textContent;
        }

        isSrtButtonHeld = true;
        startSrtProcessingButton.classList.add('button-hold-active');
        srtCountdownValue = 3;
        startSrtProcessingButton.textContent = `Starting in ${srtCountdownValue}...`;

        // Clear any existing timers (safety measure)
        clearTimeout(srtHoldTimeoutId);
        clearInterval(srtCountdownIntervalId);

        srtCountdownIntervalId = setInterval(() => {
            srtCountdownValue--;
            if (srtCountdownValue > 0) {
                startSrtProcessingButton.textContent = `Starting in ${srtCountdownValue}...`;
            } else {
                startSrtProcessingButton.textContent = `Starting...`; // Final text before action
                clearInterval(srtCountdownIntervalId); // Stop countdown once it hits 0
            }
        }, 1000);

        srtHoldTimeoutId = setTimeout(() => {
            if (isSrtButtonHeld) { // Check if mouse is still held down (i.e., mouseleave/mouseup didn't cancel)
                executeSrtProcessing();
                // After calling executeSrtProcessing, the button's state (text, disabled)
                // should be managed by executeSrtProcessing itself or subsequent event handlers
                // (like onTranslationFileCompleted, checkAllSrtFilesProcessed).
                // We don't reset text to originalSrtButtonText here if action is triggered.
            } else {
                 // This case should ideally not be hit if mouseup/mouseleave correctly set isSrtButtonHeld = false
                 // and cleared timers. But as a fallback:
                resetSrtButtonState();
            }
            // Regardless of execution, the hold period is over.
            // isSrtButtonHeld will be false if mouseup/mouseleave occurred.
            // If executeSrtProcessing was called, activeSrtJobDetails.isProcessing might be true.
            startSrtProcessingButton.classList.remove('button-hold-active'); // Always remove class after timeout attempt
            clearInterval(srtCountdownIntervalId); // Ensure countdown is stopped
            // isSrtButtonHeld should be false now unless executeSrtProcessing failed very early and resetSrtButtonState wasn't called by it
            // For safety, if no processing started, ensure isSrtButtonHeld is false.
            if (!activeSrtJobDetails.isProcessing) {
                isSrtButtonHeld = false;
            }

        }, SRT_HOLD_DURATION);
    });

    startSrtProcessingButton.addEventListener('mouseup', () => {
        if (!isSrtButtonHeld) return; // Only act if a mousedown initiated the hold
        // If mouseup occurs before SRT_HOLD_DURATION, srtHoldTimeoutId needs to be cleared.
        // resetSrtButtonState handles this.
        resetSrtButtonState();
    });

    startSrtProcessingButton.addEventListener('mouseleave', () => {
        if (!isSrtButtonHeld) return; // Only act if a mousedown initiated the hold
        // If mouseleave occurs, cancel the hold.
        // resetSrtButtonState handles this.
        resetSrtButtonState();
    });
}

if (cancelSrtProcessingButton) {
    cancelSrtProcessingButton.addEventListener('click', () => {
        if (!activeSrtJobDetails.isProcessing && activeSrtJobDetails.jobIds.size === 0) {
            alert('No SRT translation process is currently active.');
            return;
        }
        if (window.electronAPI && window.electronAPI.sendCancelSrtBatchProcessingRequest) {
            window.electronAPI.sendCancelSrtBatchProcessingRequest({}); // Send empty payload for now
            appendToLog('SRT batch translation cancellation request sent.', 'warn', true);
            // UI will be updated via onTranslationFileCompleted events with 'Cancelled' status
            // Buttons will be re-enabled by checkAllSrtFilesProcessed
        } else {
            appendToLog('Error: IPC for cancelling SRT batch processing not available.', 'error', true);
        }
    });
}

// --- IPC Event Handlers (from Main Process via preload.js) ---

// --- IPC Event Handlers (from Main Process via preload.js) ---

// Handle "Select SRT Files" response
if (window.electronAPI && window.electronAPI.onSelectSrtFilesResponse) {
    window.electronAPI.onSelectSrtFilesResponse((event, response) => {
        if (response.error) {
            appendToLog(`Error selecting SRT files: ${response.error}`, 'error', true);
            alert(`Error selecting SRT files: ${response.error}`);
        } else if (response.filePaths && response.filePaths.length > 0) {
            // Add to existing list, or replace if that's the desired behavior
            // For now, let's replace:
            selectedSrtFiles = response.filePaths.map(fp => ({
                path: fp,
                name: fp.split(/[\\/]/).pop(),
                status: 'Pending',
                progress: 0,
                type: 'srt' // Explicitly mark type
            }));
            renderSrtFileList();
            startSrtProcessingButton.disabled = false;
            appendToLog(`Selected ${selectedSrtFiles.length} SRT file(s).`, 'info', true);
        } else {
            // If no files selected, or dialog cancelled
            if (selectedSrtFiles.length === 0) { // Only log if list was already empty
                 appendToLog('No SRT files were selected or selection was cancelled.', 'info', true);
            }
        }
    });
}

// Handle "Select Video Files" response (Placeholder for Phase 3)
if (window.electronAPI && window.electronAPI.onSelectVideoFilesResponse) {
    window.electronAPI.onSelectVideoFilesResponse((event, response) => {
        if (response.error) {
            appendToLog(`Error selecting video files: ${response.error}`, 'error', true);
            alert(`Error selecting video files: ${response.error}`);
        } else if (response.filePaths && response.filePaths.length > 0) {
            selectedVideoFiles = response.filePaths.map(fp => ({
                path: fp,
                name: fp.split(/[\\/]/).pop(),
                status: 'Pending',
                progress: 0,
                type: 'video',
                stage: undefined, // Initialize stage
                jobId: undefined  // Initialize jobId
            }));
            renderVideoFileList();
            if (startVideoProcessingButton) startVideoProcessingButton.disabled = false;
            appendToLog(`Selected ${selectedVideoFiles.length} video file(s).`, 'info', true);
        } else {
            if (selectedVideoFiles.length === 0) {
                 appendToLog('No video files were selected or selection was cancelled.', 'info', true);
            }
        }
    });
}

// Handle "Select Video Directory" response
if (window.electronAPI && window.electronAPI.onSelectVideoDirectoryResponse) {
    window.electronAPI.onSelectVideoDirectoryResponse((event, response) => {
        if (response.error) {
            appendToLog(`Error selecting video directory or scanning files: ${response.error}`, 'error', true);
            alert(`Error selecting video directory or scanning files: ${response.error}`);
        } else if (response.filePaths && response.filePaths.length > 0) {
            selectedVideoFiles = response.filePaths.map(fp => ({
                path: fp,
                name: fp.split(/[\\/]/).pop(),
                status: 'Pending',
                progress: 0,
                type: 'video',
                stage: undefined,
                jobId: undefined
            }));
            renderVideoFileList();
            if (startVideoProcessingButton) startVideoProcessingButton.disabled = false;
            appendToLog(`Selected ${selectedVideoFiles.length} video file(s) recursively.`, 'info', true);
        } else {
            if (selectedVideoFiles.length === 0) {
                 appendToLog('No video files found in the selected directory or selection was cancelled.', 'info', true);
            }
        }
    });
}

// Handle "Select SRT Directory" response
if (window.electronAPI && window.electronAPI.onSelectSrtDirectoryResponse) {
    window.electronAPI.onSelectSrtDirectoryResponse((event, response) => {
         if (response.error) {
            appendToLog(`Error selecting SRT directory or scanning files: ${response.error}`, 'error', true);
            alert(`Error selecting SRT directory or scanning files: ${response.error}`);
        } else if (response.filePaths && response.filePaths.length > 0) {
            selectedSrtFiles = response.filePaths.map(fp => ({
                path: fp,
                name: fp.split(/[\\/]/).pop(),
                status: 'Pending',
                progress: 0,
                type: 'srt'
            }));
            renderSrtFileList();
            if (startSrtProcessingButton) startSrtProcessingButton.disabled = false;
            appendToLog(`Selected ${selectedSrtFiles.length} SRT file(s) recursively.`, 'info', true);
        } else {
            if (selectedSrtFiles.length === 0) {
                 appendToLog('No SRT files found in the selected directory or selection was cancelled.', 'info', true);
            }
        }
    });
}


// Updated handlers for progress and completion
if (window.electronAPI && window.electronAPI.onTranslationProgressUpdate) {
    window.electronAPI.onTranslationProgressUpdate((event, data) => {
        // data: { filePath, jobId, progress, status, stage?, chunkInfo?, type? }
        let fileToUpdate;
        if (data.type === 'srt' || (data.jobId && data.jobId.startsWith('srt-'))) { // SRT file update
            // Robust find logic for SRT files
            if (data.jobId) {
                fileToUpdate = selectedSrtFiles.find(f => f.jobId === data.jobId);
            }
            if (!fileToUpdate && data.filePath) { // If not found by jobId, or if data.jobId was missing, try by path for files that don't have a jobId yet
                fileToUpdate = selectedSrtFiles.find(f => f.path === data.filePath && !f.jobId);
            }

            if (fileToUpdate) {
                if (data.jobId && !fileToUpdate.jobId) { // Assign jobId if found by path and data has jobId
                    fileToUpdate.jobId = data.jobId;
                    activeSrtJobDetails.jobIds.add(data.jobId); // Track active job
                }
                fileToUpdate.progress = data.progress / 100; // Assuming 0-100
                fileToUpdate.status = data.status;
                if (data.chunkInfo) {
                     if (!fileToUpdate.status.includes(data.chunkInfo)) {
                        fileToUpdate.status += ` (${data.chunkInfo})`;
                    }
                }
                updateSrtFileListItem(fileToUpdate);
            }
        } else if (data.type === 'video' || (data.jobId && data.jobId.startsWith('video-'))) { // Video file update
            // Robust find logic for video files
            if (data.jobId) {
                fileToUpdate = selectedVideoFiles.find(f => f.jobId === data.jobId);
            }
            if (!fileToUpdate) { // If not found by jobId, or if data.jobId was missing, try by path for files that don't have a jobId yet
                fileToUpdate = selectedVideoFiles.find(f => f.path === data.filePath && !f.jobId);
            }

            if (fileToUpdate) {
                if (data.jobId && !fileToUpdate.jobId) { // Assign jobId if found by path and data has jobId
                    fileToUpdate.jobId = data.jobId;
                }
                fileToUpdate.progress = data.progress / 100; // Progress is 0-100 from main
                
                // Status from main.js will now be more descriptive, e.g., "Transcribing: Segment processing..."
                // or "Queued for Translation"
                fileToUpdate.status = data.status;
                
                if (data.stage) { // Stage helps categorize the status (transcribing, translating)
                    fileToUpdate.stage = data.stage;
                } else if (fileToUpdate.status.toLowerCase().includes('resegment')) { // Added before transcribing/translating
                    fileToUpdate.stage = 'resegmenting';
                } else if (fileToUpdate.status.toLowerCase().includes('transcrib')) {
                    fileToUpdate.stage = 'transcribing';
                } else if (fileToUpdate.status.toLowerCase().includes('translat')) {
                    fileToUpdate.stage = 'translating';
                }
 
                // No need to append chunkInfo to status if status is already detailed
                updateVideoFileListItem(fileToUpdate);
            }
        }

        if (data.type === 'error' && data.error_code) { // Handle structured errors
            const errorMsg = `Transcription/Translation system error: ${data.message} (Code: ${data.error_code}${data.details ? ', Details: ' + data.details : ''})`;
            appendToLog(errorMsg, 'error', true);
            if (settingsTab.classList.contains('active')) {
                displaySettingsError(errorMsg);
            } else {
                alert(errorMsg);
            }
        }
    });
}

if (window.electronAPI && window.electronAPI.onTranslationFileCompleted) {
    window.electronAPI.onTranslationFileCompleted((event, data) => {
        // data: { filePath, jobId, status, outputPath?, error?, type? }
        let fileToUpdate;
        let isSrtJob = false;
        let isVideoJob = false;

        if (data.type === 'srt' || (data.jobId && data.jobId.startsWith('srt-'))) { // SRT file completion
            if (data.jobId) {
                fileToUpdate = selectedSrtFiles.find(f => f.jobId === data.jobId);
            }
            if (!fileToUpdate && data.filePath) {
                fileToUpdate = selectedSrtFiles.find(f => f.path === data.filePath && !f.jobId);
            }
             if (!fileToUpdate && data.filePath) {
                fileToUpdate = selectedSrtFiles.find(f => f.path === data.filePath);
            }

            if (fileToUpdate && data.jobId && !fileToUpdate.jobId) {
                fileToUpdate.jobId = data.jobId;
                 if(!activeSrtJobDetails.jobIds.has(data.jobId)) activeSrtJobDetails.jobIds.add(data.jobId);
            }
            isSrtJob = true;
        } else if (data.type === 'video' || (data.jobId && (data.jobId.startsWith('video-') || data.jobId.startsWith('video-retry-')) )) { // Video file completion
            if (data.jobId) {
                fileToUpdate = selectedVideoFiles.find(f => f.jobId === data.jobId);
            }
            if (!fileToUpdate && data.filePath) {
                 // Try to find by path if jobId match failed (e.g. initial item before jobId assigned)
                fileToUpdate = selectedVideoFiles.find(f => f.path === data.filePath && (f.status !== 'Success' && f.status !== 'Error' && f.status !== 'Cancelled' && !f.status.startsWith('Failed')));
            }
            if (fileToUpdate && data.jobId && !fileToUpdate.jobId) {
                fileToUpdate.jobId = data.jobId;
            }
            isVideoJob = true;
        }

        if (fileToUpdate) {
            const logMessagePrefix = isVideoJob ? `Video processing for ${fileToUpdate.name} (Job: ${data.jobId})` : `SRT Translation for ${fileToUpdate.name} (Job: ${data.jobId})`;

            // For video and SRT, only set final "Success" if phaseCompleted is 'full_pipeline'
            if ((isVideoJob || isSrtJob) && data.status === 'Success' && data.phaseCompleted !== 'full_pipeline') {
                // This is an intermediate success (e.g., summarization complete)
                // Update status to reflect waiting for the next phase, but don't mark as final success.
                // The progress update from main.js should provide the next status.
                // For now, we can log it and ensure the UI doesn't show "Success" prematurely.
                fileToUpdate.status = `Phase '${data.phaseCompleted}' OK, awaiting next...`; // Or a more generic "Processing..."
                // Keep progress as is, or main.js progress update will set it.
                // Do not set fileToUpdate.progress = 1 here for intermediate phases.
                appendToLog(`${logMessagePrefix} - intermediate phase '${data.phaseCompleted}' completed. Output: ${data.outputPath || 'N/A'}`, 'info', true);
            } else {
                // This is a final state (Success with full_pipeline, Error, Cancelled, or SRT success)
                fileToUpdate.status = data.status;
                fileToUpdate.progress = 1; // Mark as 100% for final states
                if (data.status === 'Success') {
                    appendToLog(`${logMessagePrefix} completed successfully. Output: ${data.outputPath}`, 'info', true);
                } else if (data.status === 'Error' || data.status.startsWith('Failed')) {
                    appendToLog(`Error in ${logMessagePrefix}: ${data.error}`, 'error', true);
                } else if (data.status === 'Cancelled') {
                    appendToLog(`${logMessagePrefix} was cancelled.`, 'warn', true);
                }
            }
            
            if (isVideoJob) fileToUpdate.stage = undefined; // Clear stage for video on any completion/failure message

            if (isSrtJob) {
                updateSrtFileListItem(fileToUpdate);
                activeSrtJobDetails.jobIds.delete(data.jobId);
                checkAllSrtFilesProcessed();
            } else if (isVideoJob) {
                updateVideoFileListItem(fileToUpdate);
                checkAllVideoFilesProcessed();
            }
        } else {
            appendToLog(`Received completion for unknown job/file: ${data.filePath}, JobID: ${data.jobId}, Type: ${data.type}, Phase: ${data.phaseCompleted}`, 'warn', true);
        }
    });
}


// Handle log messages from main (This can remain as is)
if (window.electronAPI && window.electronAPI.onTranslationLogMessage) {
    window.electronAPI.onTranslationLogMessage((event, logEntry) => {
        // logEntry: { timestamp: number, message: string, level: 'info'|'warn'|'error' }
        appendToLog(logEntry.message, logEntry.level, false, logEntry.timestamp);
    });
}


// --- File List Rendering (To be split and updated in later phases) ---
function renderVideoFileList() {
    if (!videoFileListArea) return;
    videoFileListArea.innerHTML = ''; // Clear existing list

    if (selectedVideoFiles.length === 0) {
        videoFileListArea.innerHTML = '<p>No video files selected.</p>';
        if (startVideoProcessingButton) startVideoProcessingButton.disabled = true;
        return;
    }

    selectedVideoFiles.forEach((file, index) => {
        const fileItemDiv = document.createElement('div');
        fileItemDiv.classList.add('file-item');
        fileItemDiv.setAttribute('data-filepath', file.path);
        if (file.jobId) fileItemDiv.setAttribute('data-jobid', file.jobId);

        const deleteButton = document.createElement('button');
        deleteButton.classList.add('delete-file-button');
        deleteButton.innerHTML = '&#x1F5D1;'; // Trash can icon
        deleteButton.title = 'Remove file from list';
        deleteButton.disabled = activeVideoJobDetails.isProcessing || ['Processing', 'Queued for Transcription', 'Transcribing', 'Translating', 'Retrying...', 'Cancelling...'].includes(file.status);
        deleteButton.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent any parent click listeners
            selectedVideoFiles.splice(index, 1); // Remove file from array
            renderVideoFileList(); // Re-render the list
            // Potentially update button states if all files are removed or processing state changes
            checkAllVideoFilesProcessed();
        });

        const fileNameSpan = document.createElement('span');
        fileNameSpan.classList.add('file-name');
        fileNameSpan.textContent = file.name;

        const statusSpan = document.createElement('span');
        statusSpan.classList.add('file-status');
        let displayStatus = file.status;
        statusSpan.textContent = displayStatus;
        statusSpan.className = 'file-status';
        const statusClass = file.status.replace(/\s+/g, '-').split(':')[0].trim().toLowerCase();
        statusSpan.classList.add(statusClass);
        if (file.stage) {
            statusSpan.classList.add(file.stage.toLowerCase());
            if (file.stage === 'resegmenting' && !displayStatus.toLowerCase().includes('resegment')) {
                 displayStatus = `Resegmenting: ${file.status}`;
            }
        }
        statusSpan.textContent = displayStatus;

        const progressBarContainer = document.createElement('div');
        progressBarContainer.classList.add('progress-bar-container');
        const progressBar = document.createElement('div');
        progressBar.classList.add('progress-bar');
        progressBar.style.width = `${file.progress * 100}%`;
        progressBarContainer.appendChild(progressBar);
        
        const retryButton = document.createElement('button');
        retryButton.classList.add('retry-button');
        retryButton.textContent = 'Retry';
        retryButton.disabled = !(file.status.startsWith('Failed') || file.status === 'Error' || file.status === 'Cancelled');
        retryButton.addEventListener('click', () => {
            if (!(file.status.startsWith('Failed') || file.status === 'Error' || file.status === 'Cancelled')) return;
            if (!globalTargetLanguageInput.value || globalTargetLanguageInput.value.trim() === "") {
                alert('Please select a target language before retrying.');
                return;
            }
            // Removed localModelPath check for retry
            if (window.electronAPI && window.electronAPI.sendRetryFileRequest) {
                const retryJobId = `video-retry-${Date.now()}-${file.name}`;
                file.jobId = retryJobId;
                activeVideoJobDetails.isProcessing = true; // Mark batch as processing for this retry

                window.electronAPI.sendRetryFileRequest({
                    filePath: file.path,
                    targetLanguageCode: globalTargetLanguageInput.value.trim(),
                    targetLanguageFullName: targetLanguagesWithNone.find(lang => lang.code === globalTargetLanguageInput.value.trim())?.name || globalTargetLanguageInput.value.trim(),
                    settings: currentSettings,
                    type: 'video',
                    jobIdToRetry: file.jobId
                });
                file.status = 'Retrying...';
                file.stage = 'transcribing';
                file.progress = 0;
                updateVideoFileListItem(file);

                if (startVideoProcessingButton) startVideoProcessingButton.disabled = true;
                if (selectVideoFilesButton) selectVideoFilesButton.disabled = true;
                if (cancelVideoProcessingButton) cancelVideoProcessingButton.disabled = false;
            } else {
                 appendToLog('Error: IPC for retrying video file not available.', 'error', true);
            }
        });

        fileItemDiv.appendChild(deleteButton);
        fileItemDiv.appendChild(fileNameSpan);
        fileItemDiv.appendChild(statusSpan);
        fileItemDiv.appendChild(progressBarContainer);
        fileItemDiv.appendChild(retryButton);

        videoFileListArea.appendChild(fileItemDiv);
        file.element = fileItemDiv;
    });
    if (startVideoProcessingButton) {
      startVideoProcessingButton.disabled = selectedVideoFiles.length === 0 || selectedVideoFiles.every(f => f.status === 'Success' || f.status === 'Processing' || f.status === 'Queued for Transcription' || f.status.startsWith('Cancelling') || f.status.startsWith('Retrying'));
    }
    updateStartButtonStates(); // Update based on language and file states
}

function updateVideoFileListItem(file) {
    if (!file.element) {
        file.element = videoFileListArea.querySelector(`.file-item[data-filepath="${file.path}"]`);
         if (file.jobId && !file.element) {
            file.element = videoFileListArea.querySelector(`.file-item[data-jobid="${file.jobId}"]`);
        }
        if (!file.element) return;
    }

    const statusSpan = file.element.querySelector('.file-status');
    const progressBar = file.element.querySelector('.progress-bar');
    const retryButton = file.element.querySelector('.retry-button');
    const deleteButton = file.element.querySelector('.delete-file-button');

    if (statusSpan) {
        let displayStatus = file.status;
        statusSpan.textContent = displayStatus;
        statusSpan.className = 'file-status';
        const statusClass = file.status.replace(/\s+/g, '-').split(':')[0].trim().toLowerCase();
        statusSpan.classList.add(statusClass);
        if (file.stage) {
            statusSpan.classList.add(file.stage.toLowerCase());
            if (file.stage === 'resegmenting' && !statusSpan.textContent.toLowerCase().includes('resegment')) {
                statusSpan.textContent = `Resegmenting: ${file.status}`;
            }
        }
    }
    if (progressBar) {
        progressBar.style.width = `${file.progress * 100}%`;
        progressBar.className = 'progress-bar';
        if (file.status.toLowerCase().includes('error') || file.status.startsWith('Failed')) progressBar.classList.add('progress-bar-error');
        else if (file.status === 'Cancelled') progressBar.classList.add('progress-bar-cancelled');
    }
    if (retryButton) {
        retryButton.disabled = !(file.status.startsWith('Failed') || file.status === 'Error' || file.status === 'Cancelled');
    }
    if (deleteButton) {
        deleteButton.disabled = activeVideoJobDetails.isProcessing || ['Processing', 'Queued for Transcription', 'Transcribing', 'Translating', 'Retrying...', 'Cancelling...'].includes(file.status);
    }
}

function renderSrtFileList() {
    if (!srtFileListArea) return;
    srtFileListArea.innerHTML = ''; // Clear existing list

    if (selectedSrtFiles.length === 0) {
        srtFileListArea.innerHTML = '<p>No SRT files selected.</p>';
        startSrtProcessingButton.disabled = true;
        return;
    }

    selectedSrtFiles.forEach((file, index) => {
        const fileItemDiv = document.createElement('div');
        fileItemDiv.classList.add('file-item');
        fileItemDiv.setAttribute('data-filepath', file.path);
        if (file.jobId) fileItemDiv.setAttribute('data-jobid', file.jobId);

        const deleteButton = document.createElement('button');
        deleteButton.classList.add('delete-file-button');
        deleteButton.innerHTML = '&#x1F5D1;'; // Trash can icon
        deleteButton.title = 'Remove file from list';
        deleteButton.disabled = activeSrtJobDetails.isProcessing || (activeSrtJobDetails.jobIds && activeSrtJobDetails.jobIds.has(file.jobId)) || ['Processing', 'Retrying...', 'Cancelling...'].includes(file.status);
        deleteButton.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedSrtFiles.splice(index, 1);
            renderSrtFileList();
            checkAllSrtFilesProcessed();
        });

        const fileNameSpan = document.createElement('span');
        fileNameSpan.classList.add('file-name');
        fileNameSpan.textContent = file.name;

        const statusSpan = document.createElement('span');
        statusSpan.classList.add('file-status');
        statusSpan.textContent = file.status;
        statusSpan.className = 'file-status';
        if (file.status) statusSpan.classList.add(file.status.replace(/\s+/g, '-').toLowerCase());

        const progressBarContainer = document.createElement('div');
        progressBarContainer.classList.add('progress-bar-container');
        const progressBar = document.createElement('div');
        progressBar.classList.add('progress-bar');
        progressBar.style.width = `${file.progress * 100}%`;
        progressBarContainer.appendChild(progressBar);

        const retryButton = document.createElement('button');
        retryButton.classList.add('retry-button');
        retryButton.textContent = 'Retry';
        retryButton.disabled = !(file.status === 'Error' || file.status === 'Cancelled' || file.status.startsWith('Failed'));
        retryButton.addEventListener('click', () => {
            if (!(file.status === 'Error' || file.status === 'Cancelled' || file.status.startsWith('Failed'))) return;
            if (!globalTargetLanguageInput.value || globalTargetLanguageInput.value.trim() === "") {
                alert('Please select a target language before retrying.');
                return;
            }
            if (window.electronAPI && window.electronAPI.sendRetryFileRequest) {
                const retryJobId = `srt-retry-${Date.now()}-${file.name}`;
                file.jobId = retryJobId;
                activeSrtJobDetails.jobIds.add(retryJobId);
                activeSrtJobDetails.isProcessing = true; // Ensure batch is marked as processing

                window.electronAPI.sendRetryFileRequest({
                    filePath: file.path,
                    targetLanguageCode: globalTargetLanguageInput.value.trim(),
                    targetLanguageFullName: targetLanguagesWithNone.find(lang => lang.code === globalTargetLanguageInput.value.trim())?.name || globalTargetLanguageInput.value.trim(),
                    settings: currentSettings,
                    type: 'srt',
                    jobIdToRetry: file.jobId
                });
                file.status = 'Retrying...';
                file.progress = 0;
                updateSrtFileListItem(file);
                
                startSrtProcessingButton.disabled = true;
                cancelSrtProcessingButton.disabled = false;
                if(selectVideoFilesButton) selectVideoFilesButton.disabled = true;
                if(startVideoProcessingButton) startVideoProcessingButton.disabled = true;

            } else {
                appendToLog('Error: IPC for retrying SRT file not available.', 'error', true);
            }
        });
        
        fileItemDiv.appendChild(deleteButton);
        fileItemDiv.appendChild(fileNameSpan);
        fileItemDiv.appendChild(statusSpan);
        fileItemDiv.appendChild(progressBarContainer);
        fileItemDiv.appendChild(retryButton);

        srtFileListArea.appendChild(fileItemDiv);
        file.element = fileItemDiv;
    });
    startSrtProcessingButton.disabled = selectedSrtFiles.length === 0 || selectedSrtFiles.every(f => f.status === 'Success' || f.status === 'Processing' || f.status.startsWith('Cancelling') || f.status.startsWith('Retrying'));
    updateStartButtonStates(); // Update based on language and file states
}

function updateSrtFileListItem(file) {
    if (!file.element) {
        file.element = srtFileListArea.querySelector(`.file-item[data-filepath="${file.path}"][data-jobid="${file.jobId}"]`);
        if (!file.element) {
             file.element = srtFileListArea.querySelector(`.file-item[data-filepath="${file.path}"]`);
        }
        if (!file.element) return;
    }

    const statusSpan = file.element.querySelector('.file-status');
    const progressBar = file.element.querySelector('.progress-bar');
    const retryButton = file.element.querySelector('.retry-button');
    const deleteButton = file.element.querySelector('.delete-file-button');

    if (statusSpan) {
        statusSpan.textContent = file.status;
        statusSpan.className = 'file-status';
        if (file.status) statusSpan.classList.add(file.status.replace(/\s+/g, '-').toLowerCase());
    }
    if (progressBar) {
        progressBar.style.width = `${file.progress * 100}%`;
        progressBar.className = 'progress-bar';
        if (file.status === 'Error' || file.status.startsWith('Failed')) progressBar.classList.add('progress-bar-error');
        else if (file.status === 'Cancelled') progressBar.classList.add('progress-bar-cancelled');
    }
    if (retryButton) {
        retryButton.disabled = !(file.status === 'Error' || file.status === 'Cancelled' || file.status.startsWith('Failed'));
    }
    if (deleteButton) {
        deleteButton.disabled = activeSrtJobDetails.isProcessing || (activeSrtJobDetails.jobIds && activeSrtJobDetails.jobIds.has(file.jobId)) || ['Processing', 'Retrying...', 'Cancelling...'].includes(file.status);
    }
}


function checkAllSrtFilesProcessed() {
    const allDone = selectedSrtFiles.every(f =>
        f.status === 'Success' || f.status === 'Error' || f.status === 'Cancelled'
    );

    if (allDone || selectedSrtFiles.length === 0) {
        activeSrtJobDetails.isProcessing = false;
        // activeSrtJobDetails.jobIds.clear(); // Cleared individually on completion
        // If all SRT files are done or list is empty, SRT processing is not active.
        // updateStartButtonStates will handle startSrtProcessingButton.disabled
        if (selectSrtFilesButton) selectSrtFilesButton.disabled = false;
        if (cancelSrtProcessingButton) cancelSrtProcessingButton.disabled = true;

         if (selectedSrtFiles.length > 0 && allDone) {
            appendToLog('All selected SRT tasks have been processed.', 'info', true);
        }
        updateStartButtonStates(); // Ensure button states are correct after processing changes
    } else { // Some SRT tasks are still pending or processing (i.e., !allDone && selectedSrtFiles.length > 0)
        const isSrtEffectivelyProcessing = activeSrtJobDetails.isProcessing || activeSrtJobDetails.jobIds.size > 0;

        if (isSrtEffectivelyProcessing) {
            if (startSrtProcessingButton) startSrtProcessingButton.disabled = true;
            if (selectSrtFilesButton) selectSrtFilesButton.disabled = true;
            if (cancelSrtProcessingButton) cancelSrtProcessingButton.disabled = false;
        } else {
            // No SRT batch job is effectively active, but some files are not terminated (e.g., 'Pending')
            if (selectSrtFilesButton) selectSrtFilesButton.disabled = false; // Allow selecting more files
            if (cancelSrtProcessingButton) cancelSrtProcessingButton.disabled = true; // No active job to cancel

            // Enable start button if there are processable files
            const canStartBatch = selectedSrtFiles.length > 0 && selectedSrtFiles.some(
                f => f.status !== 'Success' &&
                     f.status !== 'Processing' &&
                     !f.status.startsWith('Cancelling') &&
                     !f.status.startsWith('Retrying')
            );
            // if (startSrtProcessingButton) startSrtProcessingButton.disabled = !canStartBatch; // Handled by updateStartButtonStates
        }
        updateStartButtonStates(); // Ensure button states are correct
        // Update originalSrtButtonText if button is re-enabled and not processing
        if (startSrtProcessingButton && !startSrtProcessingButton.disabled && !activeSrtJobDetails.isProcessing && !isSrtButtonHeld) {
            // Assuming "Start Translations" is the standard text when it's enabled and idle.
            originalSrtButtonText = "Start Translations";
            startSrtProcessingButton.textContent = originalSrtButtonText;
        }
    }
}

// Placeholder for video processing check (Phase 3)
function checkAllVideoFilesProcessed() {
    const allDone = selectedVideoFiles.every(f =>
        f.status === 'Success' ||
        f.status === 'Success (No Translation)' ||
        f.status === 'Success (No Translation Needed)' ||
        f.status.startsWith('Failed') || // Covers FailedTranscription, FailedTranslation
        f.status === 'Error' ||
        f.status === 'Cancelled'
    );

    if (allDone || selectedVideoFiles.length === 0) {
        activeVideoJobDetails.isProcessing = false; // Mark batch as no longer active
        // updateStartButtonStates will handle startVideoProcessingButton.disabled
        if(selectVideoFilesButton) selectVideoFilesButton.disabled = false;
        if(cancelVideoProcessingButton) cancelVideoProcessingButton.disabled = true;

         if (selectedVideoFiles.length > 0 && allDone) {
            appendToLog('All selected Video tasks have reached a final state (Success, Failed, Error, or Cancelled).', 'info', true);
        }
        updateStartButtonStates(); // Ensure button states are correct after processing changes
        renderVideoFileList(); // Re-render to update delete button states for all items
    } else { // Some video tasks are still pending or processing (i.e., !allDone && selectedVideoFiles.length > 0)
        if (activeVideoJobDetails.isProcessing) {
            // A batch job is actively running
            if(startVideoProcessingButton) startVideoProcessingButton.disabled = true;
            if(selectVideoFilesButton) selectVideoFilesButton.disabled = true;
            if(cancelVideoProcessingButton) cancelVideoProcessingButton.disabled = false;
        } else {
            // No batch job is active, but some files are not terminated (e.g., 'Pending')
            if(selectVideoFilesButton) selectVideoFilesButton.disabled = false; // Allow selecting more files
            if(cancelVideoProcessingButton) cancelVideoProcessingButton.disabled = true; // No active job to cancel

            // Enable start button if there are processable files
            const canStartBatch = selectedVideoFiles.length > 0 && selectedVideoFiles.some(
                f => f.status !== 'Success' &&
                     f.status !== 'Processing' &&
                     f.status !== 'Queued for Transcription' &&
                     !f.status.startsWith('Cancelling') &&
                     !f.status.startsWith('Retrying')
            );
            // if(startVideoProcessingButton) startVideoProcessingButton.disabled = !canStartBatch; // Handled by updateStartButtonStates
        }
        updateStartButtonStates(); // Ensure button states are correct
    }
}

// --- Log Area ---
const MAX_LOG_LINES = 500; // Maximum number of lines to keep in the log
let logLinesBuffer = []; // Buffer for incoming log lines
let logUpdateTimeoutId = null; // To throttle DOM updates
const LOG_UPDATE_INTERVAL_MS = 200; // Update DOM every 200ms
let isUserScrolledUp = false; // Track if user has scrolled away from the bottom

function updateLogAreaFromBuffer() {
    if (logLinesBuffer.length === 0) {
        return;
    }

    // Check scroll position before update
    const scrollThreshold = 5; // Pixels
    isUserScrolledUp = (logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight) > scrollThreshold;

    // Efficiently join and set the value
    logArea.value = logLinesBuffer.join(''); // Assuming logEntry in appendToLog already has '\n'

    // Trim array if over limit
    if (logLinesBuffer.length > MAX_LOG_LINES) {
        logLinesBuffer.splice(0, logLinesBuffer.length - MAX_LOG_LINES);
        // Re-set value if trimmed (though ideally buffer management prevents excessive length before join)
        logArea.value = logLinesBuffer.join('');
    }
    
    // Conditional auto-scroll
    if (!isUserScrolledUp) {
        logArea.scrollTop = logArea.scrollHeight;
    }
    // No need to clear logLinesBuffer here, appendToLog manages its growth and updateLogAreaFromBuffer trims it.
    // If we were batching additions to logLinesBuffer, then clearing the batch after processing would be here.
}

function appendToLog(message, level = 'info', withTimestamp = true, timestamp) {
    const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    const prefix = withTimestamp ? `[${time}] ` : '';
    const logEntry = `${prefix}[${level.toUpperCase()}] ${message}\n`;

    logLinesBuffer.push(logEntry);

    // Trim buffer proactively to avoid excessive memory use before DOM update
    if (logLinesBuffer.length > MAX_LOG_LINES + 50) { // Keep a small margin over MAX_LOG_LINES
        logLinesBuffer.splice(0, logLinesBuffer.length - MAX_LOG_LINES);
    }

    // Schedule or reschedule the DOM update
    if (logUpdateTimeoutId) {
        clearTimeout(logUpdateTimeoutId);
    }
    logUpdateTimeoutId = setTimeout(() => {
        updateLogAreaFromBuffer();
        logUpdateTimeoutId = null;
    }, LOG_UPDATE_INTERVAL_MS);
}

// --- Settings Tab Logic ---

geminiModelSelect.addEventListener('change', () => {
    if (geminiModelSelect.value === 'custom') {
        geminiModelCustomInput.style.display = 'block';
        geminiModelCustomInput.value = ''; // Clear previous custom value
    } else {
        geminiModelCustomInput.style.display = 'none';
    }
});
if (strongerGeminiModelSelect) {
    strongerGeminiModelSelect.addEventListener('change', () => {
        if (strongerGeminiModelSelect.value === 'custom') {
            strongerGeminiModelCustomInput.style.display = 'block';
            strongerGeminiModelCustomInput.value = ''; 
        } else {
            strongerGeminiModelCustomInput.style.display = 'none';
        }
    });
}

saveSettingsButton.addEventListener('click', () => {
    let geminiModelValue;
    if (geminiModelSelect.value === 'custom') {
        geminiModelValue = geminiModelCustomInput.value.trim();
    } else {
        geminiModelValue = geminiModelSelect.value;
    }

    let strongerGeminiModelValue; // Added
    if (strongerGeminiModelSelect.value === 'custom') { // Added
        strongerGeminiModelValue = strongerGeminiModelCustomInput.value.trim(); // Added
    } else { // Added
        strongerGeminiModelValue = strongerGeminiModelSelect.value; // Added
    } // Added

    displaySettingsError(''); // Clear previous errors

    // --- Validation for new fields ---
    let isValid = true;
    const validateNumericInput = (input, fieldName, isFloat = false, min = null, max = null) => {
        const value = isFloat ? parseFloat(input.value) : parseInt(input.value, 10);
        if (isNaN(value)) {
            displaySettingsError(`${fieldName} must be a valid number.`);
            input.classList.add('input-error');
            isValid = false;
            return undefined;
        }
        if (min !== null && value < min) {
            displaySettingsError(`${fieldName} must be at least ${min}.`);
            input.classList.add('input-error');
            isValid = false;
            return undefined;
        }
        if (max !== null && value > max) {
            displaySettingsError(`${fieldName} must be no more than ${max}.`);
            input.classList.add('input-error');
            isValid = false;
            return undefined;
        }
        input.classList.remove('input-error');
        return value;
    };
    
    document.querySelectorAll('.settings-form input, .settings-form select, .settings-form textarea').forEach(el => el.classList.remove('input-error'));


    const settingsToSave = {
        // Global Language Settings
        targetLanguage: globalTargetLanguageInput.value,
        transcriptionSourceLanguage: globalSourceLanguageSelect.value === "" ? null : globalSourceLanguageSelect.value,
        enableDiarization: globalDiarizationCheckbox.checked,
        thinkingBudget: globalThinkingEnableCheckbox.checked ? -1 : 0, // Added
        // enableVideoResegmentation: globalEnableResegmentationCheckbox.checked, // Removed
 
        // API & Translation Parameters
        apiKey: apiKeyInput.value,
        geminiModel: geminiModelValue,
        strongerRetryModelName: strongerGeminiModelValue, // Added
        systemPrompt: systemPromptInput.value,
        temperature: validateNumericInput(temperatureInput, "Gemini Temperature", true, 0, 1),
        topP: validateNumericInput(topPInput, "Gemini Top P", true, 0, 1),
        entriesPerChunk: validateNumericInput(entriesPerChunkInput, "Entries per Chunk", false, 1),
        // translationRetries: validateNumericInput(translationRetriesInput, "File Retries", false, 0), // REMOVED
        chunkRetries: validateNumericInput(chunkRetriesInput, "Chunk Retries", false, 0),
        rpm: validateNumericInput(rpmInput, "RPM", false, 1),
        
        // File & Directory Settings
        // outputDirectory: outputDirectoryInput.value.trim(), // REMOVED
        // localModelPath: localModelPathInput.value.trim(), // Removed

        // Simplified Transcription Settings
        transcriptionComputeType: transcriptionComputeTypeSelect.value,
        huggingFaceToken: huggingFaceTokenInput.value.trim(), // Added
        transcriptionConditionOnPreviousText: transcriptionConditionOnPreviousTextCheckbox.checked, // Added
        transcriptionThreads: validateNumericInput(transcriptionThreadsInput, "Transcription Threads", false, 1), // Added

        // Removed:
        // videoResegmentationTemp, videoResegmentationTopP
        // transcriptionTemperature, transcriptionNoSpeechThreshold, transcriptionConditionOnPreviousText,
        // transcriptionVadFilter, and all specific transcriptionVad... parameters
        // transcriptionCpuThreads, transcriptionNumWorkers
    };

    if (!isValid) {
        // displaySettingsError is already called by validateNumericInput
        appendToLog('Settings validation failed. Please correct the highlighted fields.', 'error', true);
        return; // Don't save if validation failed
    }
    if (window.electronAPI && window.electronAPI.sendSaveSettingsRequest) {
        window.electronAPI.sendSaveSettingsRequest(settingsToSave);
    } else {
        appendToLog('Error: IPC function for saving settings not available.', 'error', true);
    }
});

loadDefaultsButton.addEventListener('click', () => {
     if (window.electronAPI && window.electronAPI.sendLoadDefaultSettingsRequest) {
        window.electronAPI.sendLoadDefaultSettingsRequest();
    } else {
        appendToLog('Error: IPC function for loading default settings not available.', 'error', true);
    }
});
 

function loadSettingsIntoForm(settings) {
    if (!settings) settings = currentSettings; // Use cached if no specific one passed

    // Load Global Language Settings
    populateLanguageDropdown(globalTargetLanguageInput, targetLanguagesWithNone, settings.targetLanguage || 'en');
    populateLanguageDropdown(globalSourceLanguageSelect, isoLanguages, settings.transcriptionSourceLanguage || "");
    if (globalDiarizationCheckbox) globalDiarizationCheckbox.checked = !!settings.enableDiarization;
    if (globalThinkingEnableCheckbox) globalThinkingEnableCheckbox.checked = (settings.thinkingBudget === -1); // Added


    apiKeyInput.value = settings.apiKey || '';
    const modelValue = settings.geminiModel || '';
    // Check if the modelValue is one of the predefined options
    const isPredefined = Array.from(geminiModelSelect.options).some(option => option.value === modelValue);

    if (isPredefined) {
        geminiModelSelect.value = modelValue;
        geminiModelCustomInput.style.display = 'none';
        geminiModelCustomInput.value = '';
    } else if (modelValue) { // If not predefined and not empty, it's a custom value
        geminiModelSelect.value = 'custom';
        geminiModelCustomInput.style.display = 'block';
        geminiModelCustomInput.value = modelValue;
    } else { // Default to first option if no value
        geminiModelSelect.value = geminiModelSelect.options[0].value;
        geminiModelCustomInput.style.display = 'none';
        geminiModelCustomInput.value = '';
    }

    // Load strongerRetryModelName setting // Added
    const strongerModelValue = settings.strongerRetryModelName || 'gemini-2.5-pro-preview-05-06'; // Added
    const isStrongerPredefined = Array.from(strongerGeminiModelSelect.options).some(option => option.value === strongerModelValue); // Added
    if (isStrongerPredefined) { // Added
        strongerGeminiModelSelect.value = strongerModelValue; // Added
        strongerGeminiModelCustomInput.style.display = 'none'; // Added
        strongerGeminiModelCustomInput.value = ''; // Added
    } else if (strongerModelValue) { // Added
        strongerGeminiModelSelect.value = 'custom'; // Added
        strongerGeminiModelCustomInput.style.display = 'block'; // Added
        strongerGeminiModelCustomInput.value = strongerModelValue; // Added
    } else { // Added
        strongerGeminiModelSelect.value = strongerGeminiModelSelect.options[0].value; // Added
        strongerGeminiModelCustomInput.style.display = 'none'; // Added
        strongerGeminiModelCustomInput.value = ''; // Added
    } // Added

    systemPromptInput.value = settings.systemPrompt || '';
    temperatureInput.value = settings.temperature !== undefined ? settings.temperature : 0.5; // Gemini Temperature
    topPInput.value = settings.topP !== undefined ? settings.topP : 0.5; // Gemini Top P
    entriesPerChunkInput.value = settings.entriesPerChunk || 100;
    // translationRetriesInput.value = settings.translationRetries !== undefined ? settings.translationRetries : 2; // REMOVED
    chunkRetriesInput.value = settings.chunkRetries !== undefined ? settings.chunkRetries : 2;
    rpmInput.value = settings.rpm || 1000;
    // outputDirectoryInput.value = settings.outputDirectory || ''; // REMOVED
    // localModelPathInput.value = settings.localModelPath || ''; // Removed

    // Load Simplified Transcription Settings
    transcriptionComputeTypeSelect.value = settings.transcriptionComputeType || 'float16'; // Default to float16 as per plan
    huggingFaceTokenInput.value = settings.huggingFaceToken || ''; // Added
    transcriptionConditionOnPreviousTextCheckbox.checked = !!settings.transcriptionConditionOnPreviousText; // Added
    transcriptionThreadsInput.value = settings.transcriptionThreads || 8; // Added

    // Update UI based on loaded settings
    updateGlobalSourceLanguageDisabledState(); // Kept
    displaySettingsError(''); // Clear any previous errors
    updateStartButtonStates(); // Also update start buttons when settings affecting them might change
    updateHfTokenRelevance(); // Update HF token relevance when settings are loaded/changed
}

function updateGlobalSourceLanguageDisabledState() {
    // This function's logic might need review if diarization affects source language selection differently.
    // For now, assuming the original logic for multilingual (which disabled source lang) is NOT what we want for diarization.
    // Diarization should be possible even with a specified source language.
    // If the 'globalMultilingualCheckbox' was the *only* controller of this, this function might be redundant
    // or need to be re-evaluated based on how 'multilingual' (auto-detect) vs 'specific source lang' should interact.
    // For now, let's keep the original logic tied to the old checkbox ID if it's still in HTML for some reason,
    // or make it a no-op if that checkbox is truly gone.
    // Safest: if the new diarization checkbox does NOT control this, then this function's trigger might change or be removed.
    // Based on the plan, diarization checkbox should NOT disable source language.
    // So, if globalMultilingualCheckbox is truly replaced, this function's current trigger is gone.
    // Let's assume the `globalMultilingualCheckbox` element might still exist or this function is called elsewhere.
    // The original request was to remove its call from the *new* diarization checkbox listener.
    const oldMultilingualCheckbox = document.getElementById('global-multilingual-transcription'); // Check for the old element
    if (oldMultilingualCheckbox && globalSourceLanguageSelect) {
        if (oldMultilingualCheckbox.checked) {
            globalSourceLanguageSelect.disabled = true;
        } else {
            globalSourceLanguageSelect.disabled = false;
        }
    } else if (globalSourceLanguageSelect) {
        // If the old checkbox doesn't exist, ensure source language is enabled by default.
        globalSourceLanguageSelect.disabled = false;
    }
}

// Handle settings loaded from main
if (window.electronAPI && window.electronAPI.onLoadSettingsResponse) {
    window.electronAPI.onLoadSettingsResponse((event, response) => {
        if (response.error) {
            appendToLog(`Error loading settings: ${response.error}`, 'error', true);
            // Potentially load defaults or keep form empty
        } else {
            currentSettings = response.settings;
            loadSettingsIntoForm(currentSettings);
            appendToLog('Settings loaded.', 'info', true);
        }
    });
}

// Handle default settings loaded from main
if (window.electronAPI && window.electronAPI.onLoadDefaultSettingsResponse) {
    window.electronAPI.onLoadDefaultSettingsResponse((event, response) => {
        currentSettings = response.defaultSettings;
        loadSettingsIntoForm(currentSettings);
        appendToLog('Default settings loaded into form. Click "Save Settings" to apply.', 'info', true);
    });
}


// Handle save settings confirmation
if (window.electronAPI && window.electronAPI.onSaveSettingsResponse) {
    window.electronAPI.onSaveSettingsResponse((event, response) => {
        if (response.success) {
            appendToLog('Settings saved successfully.', 'info', true);
            // Optionally re-load settings to confirm, or trust the save
            if (window.electronAPI.sendLoadSettingsRequest) window.electronAPI.sendLoadSettingsRequest();
        } else {
            appendToLog(`Error saving settings: ${response.error}`, 'error', true);
            alert(`Error saving settings: ${response.error}`);
        }
    });
}

// Handle output directory selection response
if (window.electronAPI && window.electronAPI.onSelectOutputDirResponse) {
    window.electronAPI.onSelectOutputDirResponse((event, response) => {
        if (response.error) {
            appendToLog(`Error selecting output directory: ${response.error}`, 'error', true);
        } else if (response.directoryPath) {
            outputDirectoryInput.value = response.directoryPath;
            appendToLog(`Output directory selected: ${response.directoryPath}`, 'info', true);
        }
    });
}

// Handle generic directory selection response (for model path and output path)
if (window.electronAPI && window.electronAPI.onSelectDirectoryResponse) {
    window.electronAPI.onSelectDirectoryResponse((event, response) => {
        // response: { path: string, identifier: string, error?: string }
        if (response.error) {
            appendToLog(`Error selecting directory for ${response.identifier}: ${response.error}`, 'error', true);
        } else if (response.path) {
            // if (response.identifier === 'localModelPath') { // Removed
            //     localModelPathInput.value = response.path;
            //     appendToLog(`Local model path selected: ${response.path}`, 'info', true);
            // } else
            if (response.identifier === 'outputDirectory') {
                outputDirectoryInput.value = response.path;
                appendToLog(`Output directory selected: ${response.path}`, 'info', true);
            }
        }
    });
}


// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    // Request initial settings load when the renderer is ready
    if (window.electronAPI && window.electronAPI.sendLoadSettingsRequest) {
        window.electronAPI.sendLoadSettingsRequest();
    } else {
        console.error('electronAPI.sendLoadSettingsRequest is not available for initial load.');
        appendToLog('Error: Could not request initial settings load.', 'error', true);
    }

    // Populate global language dropdowns
    populateLanguageDropdown(globalTargetLanguageInput, targetLanguagesWithNone, 'en');
    populateLanguageDropdown(globalSourceLanguageSelect, isoLanguages, ""); // Default source to Auto-detect

    // Event listener for the global recursive selection checkbox
    if (globalRecursiveSelectionCheckbox) {
        globalRecursiveSelectionCheckbox.addEventListener('change', () => {
            const isRecursive = globalRecursiveSelectionCheckbox.checked;
            if (selectVideoFilesButton) {
                selectVideoFilesButton.textContent = isRecursive ? 'Select Video Directory' : 'Select Video File(s)';
            }
            if (selectSrtFilesButton) {
                selectSrtFilesButton.textContent = isRecursive ? 'Select SRT Directory' : 'Select SRT File(s)';
            }
        });
    }

    // Event listeners for global controls to update currentSettings immediately
    // and manage UI dependencies.

    if (globalTargetLanguageInput) {
        globalTargetLanguageInput.addEventListener('change', (event) => {
            if (currentSettings) {
                currentSettings.targetLanguage = event.target.value;
            }
            // Check for language conflict and update button states
            const sourceLang = globalSourceLanguageSelect.value;
            if (event.target.value && event.target.value !== "none" && sourceLang && event.target.value === sourceLang && sourceLang !== "") {
            }
            updateStartButtonStates();
        });
    }

    if (globalSourceLanguageSelect) {
        globalSourceLanguageSelect.addEventListener('change', (event) => {
            if (currentSettings) {
                currentSettings.transcriptionSourceLanguage = event.target.value === "" ? null : event.target.value;
            }
            // Check for language conflict and update button states
            const targetLang = globalTargetLanguageInput.value;
            if (targetLang && event.target.value && targetLang === event.target.value && event.target.value !== "") {
            }
            updateStartButtonStates();
            updateHfTokenRelevance(); // Call when source language changes
        });
    }

    if (globalDiarizationCheckbox) {
        globalDiarizationCheckbox.addEventListener('change', (event) => {
            if (currentSettings) {
                currentSettings.enableDiarization = event.target.checked;
            }
            // Diarization setting should not disable the source language dropdown.
            updateHfTokenRelevance(); // Call when diarization checkbox changes
        });
    }

    if (globalThinkingEnableCheckbox) { // Added
        globalThinkingEnableCheckbox.addEventListener('change', (event) => { // Added
            if (currentSettings) { // Added
                currentSettings.thinkingBudget = event.target.checked ? -1 : 0; // Added
            } // Added
        }); // Added
    } // Added

    
    // Removed event listeners for detailed transcription UI elements

    // Initial state updates based on defaults (will be overridden by loaded settings)
    updateGlobalSourceLanguageDisabledState(); // Kept
    updateStartButtonStates(); // Initial call to set button states correctly
    updateHfTokenRelevance(); // Initial call to set HF token relevance

    if (startSrtProcessingButton && startSrtProcessingButton.textContent) {
        originalSrtButtonText = startSrtProcessingButton.textContent; // Capture initial text
    }

    // Append the error display div to the settings tab
    const settingsForm = document.querySelector('#settings-tab .settings-form');
    if (settingsForm) {
        settingsForm.appendChild(settingsErrorDisplayDiv);
    }

    // Initial render for new file lists (will show "No files selected.")
    renderVideoFileList();
    renderSrtFileList();

    appendToLog('Renderer initialized.', 'info', true);
});

// --- Helper functions for UI interactivity ---
// updateSourceLanguageDisabledState is now updateGlobalSourceLanguageDisabledState and defined earlier

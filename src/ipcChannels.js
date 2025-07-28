// This file defines the IPC channels used for communication
// between the main and renderer processes.

module.exports = {
  // --- NEW IPC Channels for Tabbed UI ---

  // "Translate SRT" Tab
  SELECT_SRT_FILES_REQUEST: 'select-srt-files-request',
  SELECT_SRT_FILES_RESPONSE: 'select-srt-files-response', // payload: { filePaths: string[] } or { error: string }
  SELECT_SRT_DIRECTORY_REQUEST: 'select-srt-directory-request',       // NEW
  SELECT_SRT_DIRECTORY_RESPONSE: 'select-srt-directory-response',     // NEW
  START_SRT_BATCH_PROCESSING_REQUEST: 'start-srt-batch-processing-request', // payload: { srtFilePaths: string[], globalSettings: object, allSettings: object }
  CANCEL_SRT_BATCH_PROCESSING_REQUEST: 'cancel-srt-batch-processing-request', // payload: {} (or { jobId } if needed later)

  // "Translate Videos" Tab
  SELECT_VIDEO_FILES_REQUEST: 'select-video-files-request', // For multi-selection if supported, or single
  SELECT_VIDEO_FILES_RESPONSE: 'select-video-files-response', // payload: { filePaths: string[] } or { error: string }
  SELECT_VIDEO_DIRECTORY_REQUEST: 'select-video-directory-request',   // NEW
  SELECT_VIDEO_DIRECTORY_RESPONSE: 'select-video-directory-response', // NEW
  START_VIDEO_QUEUE_PROCESSING_REQUEST: 'start-video-queue-processing-request', // payload: { videoQueue: object[], globalSettings: object, allSettings: object }
  CANCEL_VIDEO_QUEUE_PROCESSING_REQUEST: 'cancel-video-queue-processing-request', // payload: { jobId?: string } (current video job)


  // --- Existing/Shared IPC Channels (Review and ensure compatibility) ---
  TRANSLATION_PROGRESS_UPDATE: 'translation-progress-update', // payload: { filePath: string, jobId: string, progress: number, status: string, stage?: 'transcribing'|'translating', chunkInfo?: string, type?: 'video'|'srt' }
  TRANSLATION_LOG_MESSAGE: 'translation-log-message', // payload: { timestamp: number, message: string, level: 'info'|'warn'|'error' }
  TRANSLATION_FILE_COMPLETED: 'translation-file-completed', // payload: { filePath: string, jobId: string, status: 'Success'|'Error'|'Cancelled', outputPath?: string, error?: string, type?: 'video'|'srt', phaseCompleted?: string } // Added phaseCompleted
  RETRY_FILE_REQUEST: 'retry-file-request', // payload: { filePath: string, targetLanguage: string, settings: object, type: 'video'|'srt', jobIdToRetry?: string }
  
  // --- Settings Management (Remains Unchanged) ---
  LOAD_SETTINGS_REQUEST: 'load-settings-request',
  LOAD_SETTINGS_RESPONSE: 'load-settings-response', // payload: object settings or error
  SAVE_SETTINGS_REQUEST: 'save-settings-request', // payload: object settingsToSave
  SAVE_SETTINGS_RESPONSE: 'save-settings-response', // payload: { success: boolean, error?: string }
  LOAD_DEFAULT_SETTINGS_REQUEST: 'load-default-settings-request',
  LOAD_DEFAULT_SETTINGS_RESPONSE: 'load-default-settings-response', // payload: object defaultSettings

  // Generic Directory Selection (can be used for output, model path, etc.)
  SELECT_DIRECTORY_REQUEST: 'select-directory-request', // payload: string (identifier for context, e.g., 'outputDirectory', 'localModelPath')
  SELECT_DIRECTORY_RESPONSE: 'select-directory-response', // payload: { path: string, identifier: string, error?: string }
  
  };
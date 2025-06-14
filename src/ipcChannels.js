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
  TRANSLATION_FILE_COMPLETED: 'translation-file-completed', // payload: { filePath: string, jobId: string, status: 'Success'|'Error'|'Cancelled', outputPath?: string, error?: string, type?: 'video'|'srt', pipelineType?: 'standard'|'advanced' }
  // RETRY_FILE_REQUEST may need to be adapted or have new versions per tab if retry logic differs. For now, keep as is.
  RETRY_FILE_REQUEST: 'retry-file-request', // payload: { filePath: string, targetLanguage: string, settings: object, type: 'video'|'srt', jobIdToRetry?: string }

  // --- Advanced Translation Pipeline Specific Channels (NEW) ---
  // These could potentially be merged with existing channels by adding a 'pipelineType' field,
  // but defining them separately for now as per plan.
  // ADVANCED_TRANSLATION_START: 'advanced-translation-start', // Covered by progress update with initial status
  ADVANCED_TRANSLATION_PROGRESS: 'advanced-translation-progress', // payload: { jobId: string, filePath: string, progress: number, status: string, stage: string, details?: object }
  ADVANCED_TRANSLATION_COMPLETE: 'advanced-translation-complete', // payload: { jobId: string, filePath: string, status: 'Success'|'Error'|'Cancelled', outputPath?: string, error?: string }
  // ADVANCED_TRANSLATION_ERROR is covered by ADVANCED_TRANSLATION_COMPLETE with status 'Error'

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
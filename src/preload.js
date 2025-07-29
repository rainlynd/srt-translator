const { contextBridge, ipcRenderer } = require('electron');
const ipcChannels = require('./ipcChannels'); // Make sure this path is correct

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Send requests from Renderer to Main ---
  // New Tab-Specific Senders
  sendSelectSrtFilesRequest: () => ipcRenderer.send(ipcChannels.SELECT_SRT_FILES_REQUEST),
  sendSelectSrtDirectoryRequest: () => ipcRenderer.send(ipcChannels.SELECT_SRT_DIRECTORY_REQUEST), // NEW
  sendStartSrtBatchProcessingRequest: (data) => ipcRenderer.send(ipcChannels.START_SRT_BATCH_PROCESSING_REQUEST, data),
  sendCancelSrtBatchProcessingRequest: (data) => ipcRenderer.send(ipcChannels.CANCEL_SRT_BATCH_PROCESSING_REQUEST, data),

  sendSelectVideoFilesRequest: () => ipcRenderer.send(ipcChannels.SELECT_VIDEO_FILES_REQUEST),
  sendSelectVideoDirectoryRequest: () => ipcRenderer.send(ipcChannels.SELECT_VIDEO_DIRECTORY_REQUEST), // NEW
  sendLoadVideoPathsFromFileRequest: () => ipcRenderer.send(ipcChannels.LOAD_VIDEO_PATHS_FROM_FILE_REQUEST),
  sendStartVideoQueueProcessingRequest: (data) => ipcRenderer.send(ipcChannels.START_VIDEO_QUEUE_PROCESSING_REQUEST, data),
  sendCancelVideoQueueProcessingRequest: (data) => ipcRenderer.send(ipcChannels.CANCEL_VIDEO_QUEUE_PROCESSING_REQUEST, data),
  
  // Shared senders (Retry, Settings, Directory)
  sendRetryFileRequest: (data) => ipcRenderer.send(ipcChannels.RETRY_FILE_REQUEST, data),
  sendLoadSettingsRequest: () => ipcRenderer.send(ipcChannels.LOAD_SETTINGS_REQUEST),
  sendSaveSettingsRequest: (settings) => ipcRenderer.send(ipcChannels.SAVE_SETTINGS_REQUEST, settings),
  sendLoadDefaultSettingsRequest: () => ipcRenderer.send(ipcChannels.LOAD_DEFAULT_SETTINGS_REQUEST),
  // sendSelectOutputDirRequest: () => ipcRenderer.send(ipcChannels.SELECT_OUTPUT_DIR_REQUEST), // DEPRECATED by generic
  sendSelectDirectoryRequest: (identifier) => ipcRenderer.send(ipcChannels.SELECT_DIRECTORY_REQUEST, identifier), // Generic
  
  // --- Receive responses/updates from Main to Renderer ---
  // New Tab-Specific Response Handlers
  onSelectSrtFilesResponse: (callback) => ipcRenderer.on(ipcChannels.SELECT_SRT_FILES_RESPONSE, callback),
  onSelectSrtDirectoryResponse: (callback) => ipcRenderer.on(ipcChannels.SELECT_SRT_DIRECTORY_RESPONSE, callback), // NEW
  onSelectVideoFilesResponse: (callback) => ipcRenderer.on(ipcChannels.SELECT_VIDEO_FILES_RESPONSE, callback),
  onSelectVideoDirectoryResponse: (callback) => ipcRenderer.on(ipcChannels.SELECT_VIDEO_DIRECTORY_RESPONSE, callback), // NEW
  onLoadVideoPathsFromFileResponse: (callback) => ipcRenderer.on(ipcChannels.LOAD_VIDEO_PATHS_FROM_FILE_RESPONSE, callback),

  // Shared Response Handlers
  onTranslationProgressUpdate: (callback) => ipcRenderer.on(ipcChannels.TRANSLATION_PROGRESS_UPDATE, callback),
  onTranslationFileCompleted: (callback) => ipcRenderer.on(ipcChannels.TRANSLATION_FILE_COMPLETED, callback),
  onTranslationLogMessage: (callback) => ipcRenderer.on(ipcChannels.TRANSLATION_LOG_MESSAGE, callback),
  onLoadSettingsResponse: (callback) => ipcRenderer.on(ipcChannels.LOAD_SETTINGS_RESPONSE, callback),
  onSaveSettingsResponse: (callback) => ipcRenderer.on(ipcChannels.SAVE_SETTINGS_RESPONSE, callback),
  onLoadDefaultSettingsResponse: (callback) => ipcRenderer.on(ipcChannels.LOAD_DEFAULT_SETTINGS_RESPONSE, callback),
  // onSelectOutputDirResponse: (callback) => ipcRenderer.on(ipcChannels.SELECT_OUTPUT_DIR_RESPONSE, callback), // DEPRECATED by generic
  onSelectDirectoryResponse: (callback) => ipcRenderer.on(ipcChannels.SELECT_DIRECTORY_RESPONSE, callback),
  
  // Note: It's good practice to provide a way to remove listeners.
  // For simplicity, direct removal isn't shown but consider for complex apps.
  // e.g., removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});

console.log('Preload script loaded and electronAPI exposed.');

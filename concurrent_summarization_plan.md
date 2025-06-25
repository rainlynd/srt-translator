# Plan for Implementing Concurrent Summarization

This document outlines the plan to modify the SRT Translator application to support concurrent summarization of multiple files, managed by the GlobalFileAdmissionController (GFC).

## 1. Core Objective

Enable the application to perform the summarization stage for multiple SRT files (either standalone or derived from video transcription) concurrently, while respecting global API rate limits (RPM/TPM) and a configurable limit on simultaneously active file processing tasks.

## 2. Key Architectural Changes

The core idea is to integrate summarization tasks as distinct, GFC-managed jobs.

### 2.1. GlobalFileAdmissionController (GFC) Modifications
   - **New Job Types:** Introduce new job types within GFC to represent summarization tasks. Suggested types:
      - `'video_summarization_phase'`: For summarization of SRT content derived from a video file.
      - `'srt_summarization_phase'`: For summarization of a directly provided SRT file.
   - **Job Management:** GFC's existing mechanisms (`addJob`, `_tryProcessNextJob`, `activeFileJobs`, `highPriorityQueue`, `normalPriorityQueue`) will naturally extend to manage these new summarization job types.
   - **Resource Control:** The existing `maxActiveFilesProcessing` setting in GFC will limit how many summarization (and translation) jobs can be active simultaneously. The RPM and TPM token buckets will continue to govern all API calls, including those for summarization.
   - **New GFC Events:** GFC will need to emit new events upon the completion of summarization phase jobs. These events will signal other components (like `VideoProcessingCoordinator` or the SRT batch IPC handler) to proceed with the translation phase for the respective file.
      - Suggested event names:
         - `'videoSummarizationPhaseComplete'` (payload: `{ originalVideoJobId: string, originalVideoFilePath: string, status: 'Success'|'Error'|'Cancelled', summaryContent?: string, error?: string }`)
         - `'srtSummarizationPhaseComplete'` (payload: `{ originalSrtJobId: string, originalSrtFilePath: string, status: 'Success'|'Error'|'Cancelled', summaryContent?: string, error?: string }`)

### 2.2. New `SummarizationJobManager`
   - A new class, `SummarizationJobManager`, will be created, analogous to the `SimplifiedTranslationManager`.
   - **Responsibilities:**
      - Listen for `'dispatchFileJob'` events from GFC where the `fileJob.type` is one of the new summarization job types.
      - For each dispatched summarization job:
         - Invoke `summarizationOrchestrator.processSrtForSummarization()`, passing the necessary details (SRT content, settings, GFC instance for API calls, callbacks, etc.).
         - The `summarizationOrchestrator` will continue to process text chunks sequentially *within* that single file's summarization job.
      - Upon completion (success or failure) of `processSrtForSummarization()`:
         - Call `gfc.jobCompleted()` with the summarization job's ID, status, any error message, and crucially, the `summaryContent` (if successful). This `summaryContent` will then be available in the GFC completion event payload.
      - Handle cancellation signals from GFC (via `gfc.on('cancelFileJob', ...)`), propagating the cancellation to the active `summarizationOrchestrator` instance for that job.

### 2.3. Modifications to `VideoProcessingCoordinator` (for video files)
   - After the transcription stage completes successfully for a video file:
      - If summarization is enabled (based on `allSettings.enableSummarization`):
         - The `VideoProcessingCoordinator` will submit a new job of type `'video_summarization_phase'` to GFC. This job will include the SRT content from transcription.
         - It will then listen for the `'videoSummarizationPhaseComplete'` event from GFC corresponding to this summarization job.
         - Upon receiving `'videoSummarizationPhaseComplete'`:
            - If successful, it will extract the `summaryContent` from the event payload.
            - It will then submit the `'video_translation_phase'` job to GFC, now including the `summaryContent` (or an empty string if summarization failed but processing is to continue).
      - If summarization is disabled:
         - It will directly submit the `'video_translation_phase'` job to GFC with no (or empty) `summaryContent`.

### 2.4. Modifications to SRT Batch Processing (IPC Handler in `main.js`)
   - The IPC handler for `START_SRT_BATCH_PROCESSING_REQUEST` will be updated:
      - For each SRT file in the batch:
         - If summarization is enabled (based on `allSettings.enableSummarization`):
            - Submit a new job of type `'srt_summarization_phase'` to GFC. This job will include the SRT file content.
            - An internal mechanism within the IPC handler (or a temporary listener structure) will be needed to associate the completion of this summarization job (via the `'srtSummarizationPhaseComplete'` GFC event) with the original SRT file.
            - Upon successful summarization for that file, extract the `summaryContent` and then submit the corresponding `'srt'` (translation) job to GFC, including the `summaryContent`.
         - If summarization is disabled:
            - Directly submit the `'srt'` (translation) job to GFC with no (or empty) `summaryContent`.
   - This ensures that for batch SRT processing, summarization for each file is a distinct GFC-managed job, allowing multiple files to be summarized concurrently, followed by their respective translation jobs (also GFC-managed).

### 2.5. Refactor `summarizationOrchestrator.js`
   - The `summarizationOrchestrator.processSrtForSummarization` function currently calls `gfc.requestApiResources(jobId, inputTokensForChunk, 'summarize')`.
   - The `type` parameter ('summarize') is not used by GFC for any differentiated logic. This parameter should be removed from the calls to `gfc.requestApiResources()` and `gfc.releaseApiResources()` within the `summarizationOrchestrator.js` to simplify the GFC interface and avoid confusion. GFC will identify the job type from the `FileJob` object itself if needed.

## 3. Confirmed User Intentions
   - **Translation Chunks (Single File):** All chunks of a single SRT file are intended to be processed for translation concurrently, with GFC managing the API call throttling.
   - **Summarization Chunks (Single File):** Summarization for text chunks *within* a single file will remain sequential as currently implemented in `summarizationOrchestrator.js`.
   - **File-Level Concurrency:**
      - Multiple *different* files can be translated concurrently.
      - With this plan, multiple *different* files will also be able to be summarized concurrently.
   - **GFC Resource Sharing:** Summarization and translation API calls will continue to share the same GFC RPM/TPM resource pools.
   - **Token Estimation:** The current token estimation methods for TPM (in `translationOrchestrator.js` and `summarizationOrchestrator.js`) are considered adequate.
   - **Video Workflow:** For video files, the sequential flow (Transcription -> Summarization -> Translation) is intended. Translation for one video can run concurrently with summarization of another video.

## 4. Expected Outcomes
   - Improved throughput for batches of files requiring summarization, as multiple files can be summarized in parallel up to GFC limits.
   - Consistent API load management through GFC for both summarization and translation stages.
   - Clearer separation of concerns with a dedicated `SummarizationJobManager`.
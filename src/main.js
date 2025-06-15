const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs').promises; // Added fs.promises
const ipcChannels = require('./ipcChannels');
const settingsManager = require('./settingsManager');
const geminiService = require('./geminiService');
const { processSRTFile, setTranslationCancellation } = require('./translationOrchestrator');
const transcriptionService = require('./transcriptionService'); // Added
const { v4: uuidv4 } = require('uuid'); // For generating unique job IDs
const EventEmitter = require('events');
const srtParser = require('./srtParser'); // Added for GFC

// --- ISO Language List (for deriving full name from code during retries) ---
// This should ideally be kept in sync with renderer.js or a shared module.
const isoLanguages_main = [ // Renamed to avoid conflict if renderer's list was ever imported/required directly
    { name: "English", code: "en" },
    { name: "Chinese", code: "zh" },
    { name: "Korean", code: "ko" },
    { name: "Japanese", code: "ja" },
    // Add other languages as in renderer.js if they can be selected
];
const targetLanguagesWithNone_main = [ // Renamed
    { name: "None - Disable Translation", code: "none" },
    ...isoLanguages_main
];
// --- End ISO Language List ---

// --- New Concurrency Plan Implementation (Phase 1) ---

class FileJob {
    constructor(jobId, filePath, type, globalSettings, allSettings, srtContent = null, isManualRetry = false) { // Removed totalChunks, potentialApiRequestsPerChunk
        this.jobId = jobId;
        this.filePath = filePath; // Original identifier
        this.type = type; // 'srt', 'video_translation_phase'
        this.status = 'queued'; // e.g., queued, admitted, active_processing, completed, failed, cancelled
        this.progress = 0;
        this.globalSettings = globalSettings; // Specific to this job's context at the time of creation
        this.allSettings = allSettings; // Full settings snapshot for this job
        this.srtContent = srtContent; // For SRTs from video, or direct SRT processing
        this.isManualRetry = isManualRetry; // Added for priority queue
    }
}

class GlobalFileAdmissionController extends EventEmitter {
    constructor(initialSettings, sendIpcMessageCallback) {
        super();
        this.settings = initialSettings;
        this.sendIpcMessage = sendIpcMessageCallback; // To send updates to renderer

        this.highPriorityQueue = []; // For manual retries
        this.normalPriorityQueue = []; // For regular jobs
        this.activeFileJobs = new Map(); // jobId -> FileJob for active jobs
        // this.activeApiCallTokens = 0; // Removed for RPM Token Bucket
        this.apiCallRequestQueue = [];
        this.rpmLimit = this.settings.rpm || 1000;
        this.maxActiveFilesProcessing = this.settings.maxActiveFilesProcessing || 9999;
        this.cancellationFlags = { srt: false, video: false }; // Tracks cancellation per job type

        // RPM Token Bucket Settings
        this.rpmTokenBucket = this.rpmLimit;
        this.lastRpmRefillTimestamp = Date.now();

        // TPM Settings
        this.tpmOutputEstimationFactor = this.settings.tpmOutputEstimationFactor || 2.5; // New
        this.tpmLimit = this.settings.tpmLimit || 1000000; // Default TPM
        this.currentTokenBucket = this.tpmLimit; // Bucket starts full
        this.lastTokenRefillTimestamp = Date.now();
        this.tpmRequestQueue = []; // { jobId, estimatedInputTokens, estimatedTotalTokens, resolve, reject }

        // Global API Pause State
        this.isApiGloballyPaused = false;
        this.apiGlobalPauseEndTime = 0;
        this.apiGlobalPauseTimer = null;

        console.log(`GlobalFileAdmissionController initialized. RPM Limit: ${this.rpmLimit} (Bucket: ${this.rpmTokenBucket}), TPM Limit: ${this.tpmLimit}, Max Active Files: ${this.maxActiveFilesProcessing}, TPM Factor: ${this.tpmOutputEstimationFactor}`);
    }

    updateSettings(newSettings) {
        this.settings = newSettings;
        const oldRpmLimit = this.rpmLimit;
        this.rpmLimit = this.settings.rpm || 1000;
        this.maxActiveFilesProcessing = this.settings.maxActiveFilesProcessing || 9999;
        this.tpmLimit = this.settings.tpmLimit || 1000000; // Update TPM limit
        this.tpmOutputEstimationFactor = this.settings.tpmOutputEstimationFactor || 2.5; // Update factor

        // Adjust RPM Token Bucket
        if (this.rpmLimit !== oldRpmLimit) {
            // If limit decreased, cap the bucket. If increased, capacity changes, refill is time-based.
            this.rpmTokenBucket = Math.min(this.rpmTokenBucket, this.rpmLimit);
            this.lastRpmRefillTimestamp = Date.now(); // Reset timestamp if limit changes
        }
        // Cap currentTokenBucket if tpmLimit decreased
        if (this.currentTokenBucket > this.tpmLimit) {
            this.currentTokenBucket = this.tpmLimit;
        }
        // If tpmLimit increased, the bucket doesn't automatically fill here, _refillTokenBucket handles gradual refill.

        console.log(`GlobalFileAdmissionController settings updated. New RPM Limit: ${this.rpmLimit} (Bucket: ${this.rpmTokenBucket}), New TPM Limit: ${this.tpmLimit}, Max Active Files: ${this.maxActiveFilesProcessing}, TPM Factor: ${this.tpmOutputEstimationFactor}`);
        // Potentially re-evaluate queue if RPM/TPM limits change significantly
        this._tryProcessNextJob();
        this._processApiCallQueue(); // Process RPM queue first
        this._processTpmQueue(); // Then process TPM queue
    }

    addJob(fileJobData, isManualRetry = false) {
        // fileJobData: { filePath, type ('srt' or 'video_translation_phase'), globalSettings, allSettings, srtContent (optional for type 'srt') }
        const jobType = fileJobData.type; // 'srt' or 'video_translation_phase'
        const typeSpecificCancelFlag = jobType === 'srt' ? this.cancellationFlags.srt : this.cancellationFlags.video;

        if (typeSpecificCancelFlag) {
            console.log(`Cancel flag for type '${jobType}' is active. Job for ${fileJobData.filePath} rejected.`);
            this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                filePath: fileJobData.filePath,
                jobId: `job-cancelled-${uuidv4()}`, // Temporary ID
                status: 'Cancelled',
                error: `Cancellation active for ${jobType} jobs.`,
                type: jobType === 'video_translation_phase' ? 'video' : 'srt'
            });
            return null; // Job rejected
        }

        const jobId = `${jobType}-${uuidv4()}-${path.basename(fileJobData.filePath)}`;
        
        let srtEntries;
        try {
            if (fileJobData.srtContent) {
                srtEntries = srtParser.parseSRTContent(fileJobData.srtContent, fileJobData.filePath);
            } else if (fileJobData.type === 'srt') {
                // This case requires reading the file content.
                // For simplicity in this step, we'll assume srtContent is provided for 'srt' type as well,
                // or this method needs to become async to read the file.
                // The plan implies START_SRT_BATCH_PROCESSING_REQUEST will handle parsing.
                // Let's assume srtContent will be passed or this needs adjustment.
                // For now, if srtContent is not provided for 'srt', we can't calculate chunks.
                 console.error(`Error in addJob for ${fileJobData.filePath}: srtContent not provided for type 'srt'. Cannot calculate chunks.`);
                 this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: fileJobData.filePath, jobId, status: 'Error', error: 'Internal error: SRT content missing for chunk calculation.', type: 'srt'
                });
                return null; // Job rejected
            } else { // video_translation_phase must have srtContent
                 console.error(`Error in addJob for ${fileJobData.filePath}: srtContent not provided for type 'video_translation_phase'.`);
                 this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: fileJobData.filePath, jobId, status: 'Error', error: 'Internal error: SRT content missing for video translation phase.', type: 'video'
                });
                return null; // Job rejected
            }
        } catch (parseError) {
            console.error(`Error parsing SRT for ${fileJobData.filePath} in addJob: ${parseError.message}`);
            this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                filePath: fileJobData.filePath, jobId, status: 'Error', error: `SRT parsing failed: ${parseError.message}`, type: fileJobData.type === 'video_translation_phase' ? 'video' : 'srt'
            });
            return null; // Job rejected
        }

        if (!srtEntries || srtEntries.length === 0) {
             console.warn(`No SRT entries found for ${fileJobData.filePath}. Job not added.`);
             this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                filePath: fileJobData.filePath, jobId, status: 'Error', error: 'No content in SRT file.', type: fileJobData.type === 'video_translation_phase' ? 'video' : 'srt'
            });
            return null; // Job rejected
        }
        
        const newFileJob = new FileJob(
            jobId,
            fileJobData.filePath,
            fileJobData.type,
            // Ensure globalSettings in FileJob now contains targetLanguageCode and targetLanguageFullName
            // The renderer.js change ensures fileJobData.globalSettings already has these.
            fileJobData.globalSettings,
            fileJobData.allSettings,
            fileJobData.srtContent, // Store the already parsed/provided content
            isManualRetry // Pass the flag
        );

        if (isManualRetry) {
            this.highPriorityQueue.push(newFileJob);
            console.log(`Job added to HIGH PRIORITY queue: ${newFileJob.jobId} for ${newFileJob.filePath}.`);
        } else {
            this.normalPriorityQueue.push(newFileJob);
            console.log(`Job added to NORMAL PRIORITY queue: ${newFileJob.jobId} for ${newFileJob.filePath}.`);
        }
        
        this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
            filePath: newFileJob.filePath, jobId: newFileJob.jobId, progress: 0, status: 'Queued', type: newFileJob.type === 'video_translation_phase' ? 'video' : 'srt'
        });
        this._tryProcessNextJob();
        return jobId; // Return the generated job ID
    }

    _tryProcessNextJob() {
        // Check both cancellation flags. If either is true, it might affect queue processing.
        // However, individual jobs are added based on their specific flag.
        // This method primarily decides if *any* job can be picked.
        // The more specific check happens in addJob.
        // For _tryProcessNextJob, if a specific type is cancelled, its jobs won't be in the queue for long
        // or will be filtered out by the cancellation methods.
        // So, a general check might not be needed here, or it should be nuanced.
        // Let's assume for now that if a job is in the queue, its type's cancel flag was false when added.
        // The original plan didn't specify changing this method's top-level cancel check.
        // Re-evaluating: if e.g. SRTs are cancelled, we shouldn't try to process an SRT job from the queue.
        // However, the cancellation methods should have already cleared them or marked them.
        // Let's proceed without a top-level cancel check here, relying on queue management by cancel methods.
        // If this.isGloballyCancelled was meant to stop all processing, then we need a similar check.
        // The plan implies that jobs of a cancelled type are rejected/removed.

        let jobToProcess = null;
        let fromHighPriority = false;

        // 1. Check if we can admit a new job based on maxActiveFilesProcessing
        if (this.activeFileJobs.size < this.maxActiveFilesProcessing) {
            // Prefer high-priority queue
            if (this.highPriorityQueue.length > 0) {
                jobToProcess = this.highPriorityQueue.shift();
                fromHighPriority = true;
            } else if (this.normalPriorityQueue.length > 0) {
                jobToProcess = this.normalPriorityQueue.shift();
            }
        }

        if (jobToProcess) {
            this.activeFileJobs.set(jobToProcess.jobId, jobToProcess);
            jobToProcess.status = 'admitted'; // Changed from 'budget_admitted'

            console.log(`Job admitted from ${fromHighPriority ? 'HIGH' : 'NORMAL'} priority queue: ${jobToProcess.jobId} for ${jobToProcess.filePath}. Active jobs: ${this.activeFileJobs.size}/${this.maxActiveFilesProcessing}`);
            this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                filePath: jobToProcess.filePath, jobId: jobToProcess.jobId, progress: 0, status: 'Admitted, Processing Starting...', type: jobToProcess.type === 'video_translation_phase' ? 'video' : 'srt'
            });
            this.emit('dispatchFileJob', jobToProcess);
        } else if (this.highPriorityQueue.length > 0 || this.normalPriorityQueue.length > 0) {
            // Jobs are in queue, but max active files limit reached
            const nextJobInQueue = this.highPriorityQueue.length > 0 ? this.highPriorityQueue[0] : this.normalPriorityQueue[0];
            const queueType = this.highPriorityQueue.length > 0 ? 'High' : 'Normal';
            console.log(`${queueType}-priority job ${nextJobInQueue.jobId} deferred. Active jobs: ${this.activeFileJobs.size}/${this.maxActiveFilesProcessing}. Queue full.`);
            this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                filePath: nextJobInQueue.filePath, jobId: nextJobInQueue.jobId, progress: 0, status: `Queued (${queueType} Priority - Max Active Files Reached)`, type: nextJobInQueue.type === 'video_translation_phase' ? 'video' : 'srt'
            });
        }
    }

    jobCompleted(jobId, finalStatus, errorMsg = null, outputPath = null) {
        const job = this.activeFileJobs.get(jobId);
        if (job) {
            this.activeFileJobs.delete(jobId);
            job.status = finalStatus;
            job.progress = 100;

            console.log(`Job completed: ${jobId} for ${job.filePath}. Status: ${finalStatus}. Active jobs: ${this.activeFileJobs.size}.`);
            this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                filePath: job.filePath,
                jobId: job.jobId,
                status: finalStatus,
                error: errorMsg,
                outputPath: outputPath,
                type: job.type === 'video_translation_phase' ? 'video' : 'srt'
            });

            // If it's a video translation phase job, emit an event for VideoProcessingCoordinator
            if (job.type === 'video_translation_phase') {
                this.emit('videoTranslationPhaseComplete', {
                    originalVideoJobId: job.jobId, // This might need to be the GFC job ID if VPC tracks that
                    originalVideoFilePath: job.filePath, // The original video file path
                    status: finalStatus,
                    error: errorMsg,
                    outputPath: outputPath
                });
            }
        } else {
            console.warn(`jobCompleted called for unknown or already removed job: ${jobId}`);
        }
        this._tryProcessNextJob(); // Attempt to process next in queue
    }

    cancelSrtJobs() {
        console.log('GFC: Handling cancellation for SRT jobs.');
        this.cancellationFlags.srt = true;
        const cancelError = new Error('SRT job cancellation active.');

        // Filter and cancel from high-priority queue
        this.highPriorityQueue = this.highPriorityQueue.filter(job => {
            if (job.type === 'srt') {
                job.status = 'Cancelled';
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: job.filePath, jobId: job.jobId, status: 'Cancelled', error: 'SRT batch cancelled.', type: 'srt'
                });
                return false; // Remove from queue
            }
            return true; // Keep other types
        });

        // Filter and cancel from normal-priority queue
        this.normalPriorityQueue = this.normalPriorityQueue.filter(job => {
            if (job.type === 'srt') {
                job.status = 'Cancelled';
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: job.filePath, jobId: job.jobId, status: 'Cancelled', error: 'SRT batch cancelled.', type: 'srt'
                });
                return false; // Remove from queue
            }
            return true; // Keep other types
        });
        
        // Reject pending promises in API resource queues FOR SRT JOBS
        // This is tricky as queues don't store job type directly. We'd need to check activeFileJobs or pass type.
        // For now, a broader clear might be acceptable if one type cancels, or we refine this.
        // The plan: "clear these jobs from the GFC's internal queues"
        // Let's assume for now that if a job is in apiCallRequestQueue or tpmRequestQueue, and its type is cancelled,
        // it should be rejected. We need to iterate and check.
        this.apiCallRequestQueue = this.apiCallRequestQueue.filter(req => {
            const activeJob = this.activeFileJobs.get(req.jobId); // Check if it's an active job being cancelled
            if (activeJob && activeJob.type === 'srt') {
                req.reject(cancelError);
                return false;
            } // If not active or not SRT, keep it for now. This might need refinement if a queued-but-not-active job needs cancelling.
            // A simpler approach might be to clear all requests if ANY type is cancelled, but that's too broad.
            // Let's assume the job is active if it's in API queues.
            const jobInAnyQueue = [...this.highPriorityQueue, ...this.normalPriorityQueue].find(j => j.jobId === req.jobId);
            if (jobInAnyQueue && jobInAnyQueue.type === 'srt') { // This check is redundant if queues are already filtered
                 req.reject(cancelError);
                 return false;
            }
            // If a job was in a GFC queue and then cancelled, it won't reach API queues.
            // This primarily affects jobs that were active and then got into API queues.
            return true; // Default to keep if not clearly an SRT job to cancel
        });
        this.tpmRequestQueue = this.tpmRequestQueue.filter(req => {
            const activeJob = this.activeFileJobs.get(req.jobId);
            if (activeJob && activeJob.type === 'srt') {
                req.reject(cancelError);
                return false;
            }
            return true;
        });


        // Signal active SRT jobs to cancel
        this.activeFileJobs.forEach(job => {
            if (job.type === 'srt') {
                job.status = 'Cancelling...';
                this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                    filePath: job.filePath, jobId: job.jobId, progress: job.progress, status: 'Cancelling (SRT Batch)...', type: 'srt'
                });
                this.emit('cancelFileJob', job.jobId); // SimplifiedTranslationManager listens to this
            }
        });
        // Note: GFC doesn't remove from activeFileJobs here; jobCompleted does that.
    }

    cancelVideoTranslationPhaseJobs() {
        console.log('GFC: Handling cancellation for Video Translation Phase jobs.');
        this.cancellationFlags.video = true;
        const cancelError = new Error('Video translation phase cancellation active.');

        this.highPriorityQueue = this.highPriorityQueue.filter(job => {
            if (job.type === 'video_translation_phase') {
                job.status = 'Cancelled';
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: job.filePath, jobId: job.jobId, status: 'Cancelled', error: 'Video batch cancelled.', type: 'video'
                });
                return false;
            }
            return true;
        });

        this.normalPriorityQueue = this.normalPriorityQueue.filter(job => {
            if (job.type === 'video_translation_phase') {
                job.status = 'Cancelled';
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: job.filePath, jobId: job.jobId, status: 'Cancelled', error: 'Video batch cancelled.', type: 'video'
                });
                return false;
            }
            return true;
        });

        this.apiCallRequestQueue = this.apiCallRequestQueue.filter(req => {
            const activeJob = this.activeFileJobs.get(req.jobId);
            if (activeJob && activeJob.type === 'video_translation_phase') {
                req.reject(cancelError);
                return false;
            }
            return true;
        });
        this.tpmRequestQueue = this.tpmRequestQueue.filter(req => {
            const activeJob = this.activeFileJobs.get(req.jobId);
            if (activeJob && activeJob.type === 'video_translation_phase') {
                req.reject(cancelError);
                return false;
            }
            return true;
        });

        this.activeFileJobs.forEach(job => {
            if (job.type === 'video_translation_phase') {
                job.status = 'Cancelling...';
                this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                    filePath: job.filePath, jobId: job.jobId, progress: job.progress, status: 'Cancelling (Video Batch)...', type: 'video'
                });
                this.emit('cancelFileJob', job.jobId);
            }
        });
    }

    resetSrtCancellation() {
        this.cancellationFlags.srt = false;
        console.log('GFC: SRT cancellation flag reset.');
        // Resetting API queues and buckets on any type reset might be too broad if other type is active.
        // Plan: "These will be called when a new batch of the respective type is started."
        // This implies a full reset for that type's context.
        // For shared resources like API queues, if we clear them, it affects all.
        // Let's assume for now that starting a new batch implies a fresh start for API resources too.
        // This matches the old global reset behavior.
        this._resetApiResourceState();
    }

    resetVideoCancellation() {
        this.cancellationFlags.video = false;
        console.log('GFC: Video cancellation flag reset.');
        this._resetApiResourceState();
    }
    
    _resetApiResourceState() { // Helper for resetting shared API resources
        console.log('GFC: Resetting API resource state (queues, buckets, pause).');
        this.apiCallRequestQueue.forEach(queuedCall => {
            console.warn(`GFC: Clearing unresolved API call request for ${queuedCall.jobId} from RPM queue after cancellation reset.`);
            if (queuedCall.reject) queuedCall.reject(new Error('Cancellation reset, request stale.'));
        });
        this.apiCallRequestQueue = [];

        this.tpmRequestQueue.forEach(queuedCall => {
            console.warn(`GFC: Clearing unresolved API call request for ${queuedCall.jobId} from TPM queue after cancellation reset.`);
            if (queuedCall.reject) queuedCall.reject(new Error('Cancellation reset, request stale.'));
        });
        this.tpmRequestQueue = [];

        this.rpmTokenBucket = this.rpmLimit;
        this.lastRpmRefillTimestamp = Date.now();
        this.currentTokenBucket = this.tpmLimit;
        this.lastTokenRefillTimestamp = Date.now();

        if (this.apiGlobalPauseTimer) {
            clearTimeout(this.apiGlobalPauseTimer);
            this.apiGlobalPauseTimer = null;
        }
        this.isApiGloballyPaused = false;
        this.apiGlobalPauseEndTime = 0;
        
        // Attempt to process next job as state is reset
        this._tryProcessNextJob();
        this._processApiCallQueue();
        this._processTpmQueue();
    }


    // --- Global API Pause Methods ---
    activateGlobalApiPause(durationMs, originatingJobId) {
        if (this.isApiGloballyPaused && this.apiGlobalPauseEndTime > Date.now() + durationMs) {
            console.log(`GFC: Global API pause already active and longer (${(this.apiGlobalPauseEndTime - Date.now()) / 1000}s remaining) than new request (${durationMs / 1000}s). Not shortening.`);
            return;
        }

        if (this.apiGlobalPauseTimer) {
            clearTimeout(this.apiGlobalPauseTimer);
        }

        this.isApiGloballyPaused = true;
        this.apiGlobalPauseEndTime = Date.now() + durationMs;
        console.log(`GFC: Global API pause ACTIVATED for ${durationMs / 1000}s. Triggered by Job ID: ${originatingJobId}. Pause ends at: ${new Date(this.apiGlobalPauseEndTime).toISOString()}`);
        
        this.apiGlobalPauseTimer = setTimeout(() => {
            this.resumeGlobalApiAccess(originatingJobId, 'timer_expired');
        }, durationMs);
    }

    resumeGlobalApiAccess(originatingJobIdContext, reason) {
        if (!this.isApiGloballyPaused) {
            return;
        }

        this.isApiGloballyPaused = false;
        this.apiGlobalPauseEndTime = 0;
        if (this.apiGlobalPauseTimer) {
            clearTimeout(this.apiGlobalPauseTimer);
            this.apiGlobalPauseTimer = null;
        }
        console.log(`GFC: Global API access RESUMED. Triggering Job Context: ${originatingJobIdContext}, Reason: ${reason}. Processing queues...`);

        this._processApiCallQueue();
        this._processTpmQueue();
    }

    // --- Resource Management Methods ---
    _refillRpmBucket() {
        const now = Date.now();
        const elapsedSeconds = (now - this.lastRpmRefillTimestamp) / 1000;

        if (elapsedSeconds <= 0) { // Use <= to handle potential clock skew or rapid calls
            return;
        }

        // Calculate tokens to add: (rpmLimit / 60) tokens per second
        const tokensToAdd = Math.floor(elapsedSeconds * (this.rpmLimit / 60));

        if (tokensToAdd > 0) {
            this.rpmTokenBucket = Math.min(this.rpmLimit, this.rpmTokenBucket + tokensToAdd);
        }
        this.lastRpmRefillTimestamp = now; // Always update timestamp
    }

    async requestApiResources(jobId, estimatedInputTokens) {
        if (this.isApiGloballyPaused) {
            if (Date.now() >= this.apiGlobalPauseEndTime) {
                this.resumeGlobalApiAccess(jobId, 'auto_resume_on_request');
            } else {
                console.log(`GFC: API resource request for Job ID: ${jobId} deferred. Global API pause active for another ${(this.apiGlobalPauseEndTime - Date.now()) / 1000}s.`);
            }
        }

        const job = this.activeFileJobs.get(jobId) ||
                    this.highPriorityQueue.find(j => j.jobId === jobId) ||
                    this.normalPriorityQueue.find(j => j.jobId === jobId);

        if (job) {
            const jobTypeCancelFlag = job.type === 'srt' ? this.cancellationFlags.srt : this.cancellationFlags.video;
            if (jobTypeCancelFlag) {
                console.log(`GFC: Cancel for type '${job.type}' active. API resource request for Job ID: ${jobId} rejected.`);
                throw new Error(`Cancellation active for ${job.type} jobs, API resources rejected.`);
            }
        } else {
            // If job not found, it might have been cancelled and removed from all queues/active list.
            // Or it's a new job not yet fully registered. This path should ideally not be hit if job management is tight.
            console.warn(`GFC: Job ID ${jobId} not found in active or queued jobs during API resource request. Proceeding with caution.`);
            // If we can't determine job type, we can't check specific flag. A general check might be too restrictive.
            // For now, let it proceed if job not found, assuming it's a new job being processed.
        }


        const estimatedTotalTokens = Math.ceil(estimatedInputTokens * this.tpmOutputEstimationFactor);

        // RPM Token Bucket Logic
        this._refillRpmBucket();
        if (this.rpmTokenBucket >= 1) {
            // RPM token available, now check TPM
            this._refillTokenBucket(); // TPM bucket
            if (this.currentTokenBucket >= estimatedTotalTokens) {
                this.rpmTokenBucket--; // Consume RPM token
                this.currentTokenBucket -= estimatedTotalTokens; // Consume TPM tokens
                console.log(`GFC: RPM+TPM granted for Job ID: ${jobId}. RPM Bucket: ${this.rpmTokenBucket}/${this.rpmLimit}. TPM Budget: ${this.currentTokenBucket}/${this.tpmLimit} (used ${estimatedTotalTokens} estimated total).`);
                return true; // Resolve immediately
            } else {
                // RPM token available, but not enough TPM. Queue for TPM.
                console.log(`GFC: RPM token OK, but TPM insufficient for Job ID: ${jobId} (needs ${estimatedTotalTokens} total, has ${this.currentTokenBucket}). Queued for TPM. RPM Queue: ${this.apiCallRequestQueue.length}, TPM Queue: ${this.tpmRequestQueue.length}`);
                return new Promise((resolve, reject) => {
                    this.tpmRequestQueue.push({ jobId, estimatedInputTokens, estimatedTotalTokens, resolve, reject });
                });
            }
        } else {
            // No RPM token available. Queue for RPM.
            console.log(`GFC: RPM token unavailable for Job ID: ${jobId}. Queued for RPM. RPM Bucket: ${this.rpmTokenBucket}/${this.rpmLimit}. RPM Queue: ${this.apiCallRequestQueue.length}, TPM Queue: ${this.tpmRequestQueue.length}`);
            return new Promise((resolve, reject) => {
                // Store estimatedTotalTokens as well, as it's needed if it later gets processed by TPM queue directly from RPM queue
                this.apiCallRequestQueue.push({ jobId, estimatedInputTokens, estimatedTotalTokens, resolve, reject });
            });
        }
    }

    releaseApiResources(jobId, actualInputTokens, outputTokens) {
        // RPM Token is NOT returned directly. It refills via _refillRpmBucket() over time.

        // TPM Budget Adjustment - Output tokens are no longer deducted here.
        // Input tokens were already deducted predictively.
        this._refillTokenBucket(); // Refill TPM bucket in case time passed, though no deduction follows.

        console.log(`GFC: API resources released for Job ID: ${jobId}. RPM Bucket: ${this.rpmTokenBucket}/${this.rpmLimit}. TPM Budget: ${this.currentTokenBucket}/${this.tpmLimit}. (Actual Input: ${actualInputTokens}, Actual Output: ${outputTokens} - for logging only).`);

        // Process Queues
        this._processApiCallQueue(); // Try to process RPM queue first
        this._processTpmQueue();     // Then try to process TPM queue
    }

    _processApiCallQueue() { // RPM Queue Processor
        if (this.isGloballyPaused) {
            if (Date.now() >= this.apiGlobalPauseEndTime) {
                this.resumeGlobalApiAccess('RPMQueueProcessor', 'auto_resume_in_queue_processor');
            } else {
                return;
            }
        }
        // No top-level global cancel check, individual job type flags handled by requestApiResources or job removal.
        // if (this.cancellationFlags.srt && this.cancellationFlags.video) return; // Example: if ALL are cancelled

        this._refillRpmBucket(); // Refill RPM bucket before processing queue

        while (this.apiCallRequestQueue.length > 0 && this.rpmTokenBucket >= 1) {
            const nextRequest = this.apiCallRequestQueue.shift();
            
            // RPM token is available, now check TPM for this request
            this._refillTokenBucket(); // Refill TPM bucket
            // Use nextRequest.estimatedTotalTokens which was calculated when the job was first pushed to a queue
            if (this.currentTokenBucket >= nextRequest.estimatedTotalTokens) {
                this.rpmTokenBucket--; // Consume RPM token
                this.currentTokenBucket -= nextRequest.estimatedTotalTokens; // Consume TPM tokens
                console.log(`GFC: RPM+TPM granted to queued Job ID: ${nextRequest.jobId} from RPM queue. RPM Bucket: ${this.rpmTokenBucket}/${this.rpmLimit}. TPM Budget: ${this.currentTokenBucket}/${this.tpmLimit} (used ${nextRequest.estimatedTotalTokens} total).`);
                nextRequest.resolve(true);
            } else {
                // RPM token available, but TPM not. Add to TPM queue.
                console.log(`GFC: Job ID: ${nextRequest.jobId} (from RPM queue) has RPM token, but TPM insufficient (needs ${nextRequest.estimatedTotalTokens} total, has ${this.currentTokenBucket}). Moving to TPM queue.`);
                this.tpmRequestQueue.push(nextRequest); // Pass the original promise's resolve/reject and all token info
            }
        }
    }

    _processTpmQueue() {
        if (this.isApiGloballyPaused) {
            if (Date.now() >= this.apiGlobalPauseEndTime) {
                this.resumeGlobalApiAccess('TPMQueueProcessor', 'auto_resume_in_queue_processor');
            } else {
                return;
            }
        }
        // No top-level global cancel check here either.

        this._refillTokenBucket(); // Refill TPM bucket
        this._refillRpmBucket();   // Also refill RPM bucket, as a TPM-queued item still needs an RPM slot

        // Important: A job from TPM queue also needs an RPM slot.
        while (this.tpmRequestQueue.length > 0 && this.rpmTokenBucket >= 1 && this.currentTokenBucket > 0) {
            const nextRequest = this.tpmRequestQueue[0]; // Peek

            // Use nextRequest.estimatedTotalTokens
            if (this.currentTokenBucket >= nextRequest.estimatedTotalTokens) {
                this.tpmRequestQueue.shift(); // Now remove it
                this.rpmTokenBucket--; // Consume an RPM token
                this.currentTokenBucket -= nextRequest.estimatedTotalTokens; // Consume TPM tokens
                console.log(`GFC: TPM+RPM granted to queued Job ID: ${nextRequest.jobId} from TPM queue. RPM Bucket: ${this.rpmTokenBucket}/${this.rpmLimit}. TPM Budget: ${this.currentTokenBucket}/${this.tpmLimit} (used ${nextRequest.estimatedTotalTokens} total).`);
                nextRequest.resolve(true);
            } else {
                // Not enough TPM tokens for the head of the queue, stop processing TPM queue for now
                break;
            }
        }
    }

    _refillTokenBucket() { // This is the original TPM refill
        const now = Date.now();
        const elapsedSeconds = (now - this.lastTokenRefillTimestamp) / 1000;

        if (elapsedSeconds <= 0) { // Avoid issues if called multiple times quickly or clock skew
            return;
        }

        const tokensToAdd = Math.floor(elapsedSeconds * (this.tpmLimit / 60));

        if (tokensToAdd > 0) {
            this.currentTokenBucket = Math.min(this.tpmLimit, this.currentTokenBucket + tokensToAdd);
        }
        this.lastTokenRefillTimestamp = now; // Always update timestamp, even if no tokens added
    }
}

// --- End New Concurrency Plan Implementation ---

let mainWindow;
let globalFileAdmissionController; // Declare here

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({ // Assign to the higher-scoped variable
    width: 1200, // Increased width for better layout
    height: 800, // Increased height
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY, // Path to preload script
    },
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  createWindow();

  // Set a more secure Content Security Policy
  if (session.defaultSession) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const newCSP = [
        "default-src 'self'",
        // 'unsafe-inline' and 'unsafe-eval' for script-src are often needed for webpack hot reload.
        // For production, aim to remove these if possible by hashing/noncing scripts.
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        // Allow inline styles (needed by style-loader) and styles from Google Fonts.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        // Allow fonts from Google Fonts.
        "font-src 'self' https://fonts.gstatic.com",
        // Allow images from self and data URIs (based on original default-src).
        "img-src 'self' data:",
        // Allow connections to self (e.g., for IPC or local dev server).
        "connect-src 'self'"
      ].join('; ');

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': newCSP,
        }
      });
    });
  } else {
    console.warn('session.defaultSession is not available to set CSP.');
  }

  // Load settings and initialize Gemini model
  try {
    const settings = await settingsManager.loadSettings();
    if (settings.apiKey && settings.geminiModel) {
      try {
        geminiService.initializeGeminiModel(settings.apiKey, settings.geminiModel, 'primary');
        console.log('Primary Gemini Service initialized on app ready.');
        if (settings.strongerRetryModelName && settings.strongerRetryModelName.trim() !== '') {
          geminiService.initializeGeminiModel(settings.apiKey, settings.strongerRetryModelName, 'retry');
          console.log('Stronger retry Gemini Service initialized on app ready.');
        } else {
          console.warn('Stronger retry model name not configured. Retry model not initialized.');
        }
      } catch (initError) {
        console.error('Failed to initialize Gemini Service(s) on app ready:', initError);
      }
    } else {
      console.warn('API key or primary model not found in settings. Gemini Service not initialized yet.');
    }

    // Initialize GlobalFileAdmissionController here
    if (mainWindow && mainWindow.webContents) {
        globalFileAdmissionController = new GlobalFileAdmissionController(settings, mainWindow.webContents.send.bind(mainWindow.webContents));
        console.log('GlobalFileAdmissionController initialized after app ready.');
        
        // Listener for dispatching file jobs from GFC to the new SimplifiedTranslationManager
        globalFileAdmissionController.on('dispatchFileJob', (fileJob) => {
            // Ensure simplifiedTranslationManager is instantiated and ready
            if (simplifiedTranslationManager) {
                simplifiedTranslationManager.processFile(fileJob);
            } else {
                console.error('SimplifiedTranslationManager not initialized when dispatchFileJob was emitted from GFC.');
                globalFileAdmissionController.jobCompleted(fileJob.jobId, 'Error', 'SimplifiedTranslationManager not ready.');
            }
        });

        globalFileAdmissionController.on('cancelFileJob', (jobIdToCancel) => {
            if (simplifiedTranslationManager) {
                simplifiedTranslationManager.cancelJob(jobIdToCancel);
            } else {
                console.error('SimplifiedTranslationManager not initialized when cancelFileJob was emitted from GFC.');
            }
        });

        // Initialize SimplifiedTranslationManager here, after GFC and mainWindow are available
        if (globalFileAdmissionController && mainWindow && mainWindow.webContents) {
            simplifiedTranslationManager = new SimplifiedTranslationManager(globalFileAdmissionController, mainWindow.webContents.send.bind(mainWindow.webContents));
            console.log('SimplifiedTranslationManager initialized within the main app.whenReady block.');
        } else {
            console.error('Cannot initialize SimplifiedTranslationManager: GFC or mainWindow not available during its setup.');
        }

    } else {
        console.error('Cannot initialize GlobalFileAdmissionController: mainWindow or webContents not available at app.whenReady.');
        // This is a critical issue. The app might not function correctly without GFC.
        // Consider sending an error to renderer or logging prominently.
    }
  } catch (error) {
    console.error('Failed to load settings or initialize services on app ready:', error);
  }


  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- IPC Handlers ---

// --- IPC Handlers ---

// Recursive File Scanning Utility
async function recursivelyScanDirectory(directoryPath, allowedExtensions, logCallback) {
    let foundFiles = [];
    try {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                try {
                    const subDirFiles = await recursivelyScanDirectory(fullPath, allowedExtensions, logCallback);
                    foundFiles = foundFiles.concat(subDirFiles);
                } catch (subDirError) {
                    if (logCallback) logCallback('warn', `Skipping directory ${fullPath} due to error: ${subDirError.message}`);
                    // Optionally, continue scanning other directories
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (allowedExtensions.includes(ext)) {
                    foundFiles.push(fullPath);
                }
            }
        }
    } catch (error) {
        if (logCallback) logCallback('error', `Error reading directory ${directoryPath}: ${error.message}`);
        throw error; // Re-throw to be caught by the IPC handler
    }
    return foundFiles;
}

// New File Selection Handlers
ipcMain.on(ipcChannels.SELECT_SRT_FILES_REQUEST, async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'SRT Subtitles', extensions: ['srt'] }],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send(ipcChannels.SELECT_SRT_FILES_RESPONSE, { filePaths: result.filePaths });
    } else {
      event.sender.send(ipcChannels.SELECT_SRT_FILES_RESPONSE, { filePaths: [] });
    }
  } catch (error) {
    console.error('Error showing SRT file dialog:', error);
    event.sender.send(ipcChannels.SELECT_SRT_FILES_RESPONSE, { error: error.message });
  }
});

ipcMain.on(ipcChannels.SELECT_SRT_DIRECTORY_REQUEST, async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'], // Only allow directory selection
      title: 'Select Directory Containing SRT Files'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const directoryPath = result.filePaths[0];
      const srtFiles = await recursivelyScanDirectory(directoryPath, ['.srt'], (level, message) => {
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message, level });
      });
      event.sender.send(ipcChannels.SELECT_SRT_DIRECTORY_RESPONSE, { filePaths: srtFiles });
    } else {
      event.sender.send(ipcChannels.SELECT_SRT_DIRECTORY_RESPONSE, { filePaths: [] }); // User cancelled
    }
  } catch (error) {
    console.error('Error selecting SRT directory or scanning files:', error);
    event.sender.send(ipcChannels.SELECT_SRT_DIRECTORY_RESPONSE, { error: error.message });
  }
});

ipcMain.on(ipcChannels.SELECT_VIDEO_FILES_REQUEST, async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'], // Allow multi-selection for queue
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm4v'] },
        { name: 'All Files', extensions: ['*'] }
      ],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send(ipcChannels.SELECT_VIDEO_FILES_RESPONSE, { filePaths: result.filePaths });
    } else {
      event.sender.send(ipcChannels.SELECT_VIDEO_FILES_RESPONSE, { filePaths: [] });
    }
  } catch (error) {
    console.error('Error showing video file dialog:', error);
    event.sender.send(ipcChannels.SELECT_VIDEO_FILES_RESPONSE, { error: error.message });
  }
});

ipcMain.on(ipcChannels.SELECT_VIDEO_DIRECTORY_REQUEST, async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'], // Only allow directory selection
      title: 'Select Directory Containing Video Files'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const directoryPath = result.filePaths[0];
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m4v']; // Match existing filter
      const videoFiles = await recursivelyScanDirectory(directoryPath, videoExtensions, (level, message) => {
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message, level });
      });
      event.sender.send(ipcChannels.SELECT_VIDEO_DIRECTORY_RESPONSE, { filePaths: videoFiles });
    } else {
      event.sender.send(ipcChannels.SELECT_VIDEO_DIRECTORY_RESPONSE, { filePaths: [] }); // User cancelled
    }
  } catch (error) {
    console.error('Error selecting video directory or scanning files:', error);
    event.sender.send(ipcChannels.SELECT_VIDEO_DIRECTORY_RESPONSE, { error: error.message });
  }
});

// Output Directory Selection
ipcMain.on(ipcChannels.SELECT_OUTPUT_DIR_REQUEST, async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm4v'] },
        { name: 'All Files', extensions: ['*'] }
      ],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send(ipcChannels.SELECT_VIDEO_RESPONSE, { filePath: result.filePaths[0] });
    } else {
      event.sender.send(ipcChannels.SELECT_VIDEO_RESPONSE, { filePath: null }); // Send null if cancelled
    }
  } catch (error) {
    console.error('Error showing video open dialog:', error);
    event.sender.send(ipcChannels.SELECT_VIDEO_RESPONSE, { error: error.message });
  }
});

// Output Directory Selection
ipcMain.on(ipcChannels.SELECT_OUTPUT_DIR_REQUEST, async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send(ipcChannels.SELECT_OUTPUT_DIR_RESPONSE, { directoryPath: result.filePaths[0] });
    } else {
      // Optionally send an empty or specific response if cancelled
      event.sender.send(ipcChannels.SELECT_OUTPUT_DIR_RESPONSE, { directoryPath: null });
    }
  } catch (error) {
    console.error('Error showing directory dialog:', error);
    event.sender.send(ipcChannels.SELECT_OUTPUT_DIR_RESPONSE, { error: error.message });
  }
});

// Generic Directory Selection Handler
ipcMain.on(ipcChannels.SELECT_DIRECTORY_REQUEST, async (event, identifier) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'dontAddToRecent'], // Added dontAddToRecent
    });
    if (!result.canceled && result.filePaths.length > 0) {
      event.sender.send(ipcChannels.SELECT_DIRECTORY_RESPONSE, {
        path: result.filePaths[0],
        identifier: identifier, // Pass back the identifier
      });
    } else {
      event.sender.send(ipcChannels.SELECT_DIRECTORY_RESPONSE, {
        path: null,
        identifier: identifier,
      });
    }
  } catch (error) {
    console.error(`Error showing directory dialog for ${identifier}:`, error);
    event.sender.send(ipcChannels.SELECT_DIRECTORY_RESPONSE, {
      error: error.message,
      identifier: identifier,
    });
  }
});


// Settings Management
ipcMain.handle(ipcChannels.LOAD_SETTINGS_REQUEST, async () => { // Using handle for direct response
  try {
    const settings = await settingsManager.loadSettings();
    // If Gemini is not initialized and we have key/model, try now.
    if (settings.apiKey && settings.geminiModel && !geminiService.isInitialized()) { // Assuming an isInitialized method
        try {
            geminiService.initializeGeminiModel(settings.apiKey, settings.geminiModel);
            console.log('Gemini Service initialized via settings load.');
        } catch (initError) {
            console.error('Failed to initialize Gemini Service during settings load:', initError);
            // Don't let this fail the settings load, renderer can show an error.
        }
    }
    return { settings };
  } catch (error) {
    console.error('Error loading settings in main:', error);
    return { error: error.message, settings: settingsManager.defaultSettings }; // Send defaults on error
  }
});
// For 'on' style
ipcMain.on(ipcChannels.LOAD_SETTINGS_REQUEST, async (event) => {
  try {
    const settings = await settingsManager.loadSettings();
     if (settings.apiKey && settings.geminiModel) { // Check if geminiService has an isInitialized method or similar
        try {
            // Avoid re-initializing if already done. Add a check in geminiService if needed.
            geminiService.initializeGeminiModel(settings.apiKey, settings.geminiModel);
            console.log('Gemini Service (re)initialized via settings load.');
             event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                timestamp: Date.now(),
                message: 'Gemini Service initialized with new API key/model.',
                level: 'info',
            });
        } catch (initError) {
            console.error('Failed to initialize Gemini Service during settings load:', initError);
             event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                timestamp: Date.now(),
                message: `Failed to initialize Gemini Service: ${initError.message}`,
                level: 'error',
            });
        }
    }
    event.sender.send(ipcChannels.LOAD_SETTINGS_RESPONSE, { settings });
  } catch (error) {
    console.error('Error loading settings in main:', error);
    event.sender.send(ipcChannels.LOAD_SETTINGS_RESPONSE, { error: error.message, settings: settingsManager.defaultSettings });
  }
});

ipcMain.on(ipcChannels.SAVE_SETTINGS_REQUEST, async (event, settingsToSave) => {
  try {
    await settingsManager.saveSettings(settingsToSave);
    // If API key or model changed, re-initialize Gemini Service
    if (settingsToSave.apiKey) {
        let primaryModelInitialized = false;
        let retryModelInitialized = false;
        if (settingsToSave.geminiModel) {
            try {
                geminiService.initializeGeminiModel(settingsToSave.apiKey, settingsToSave.geminiModel, 'primary');
                console.log('Primary Gemini Service re-initialized due to settings change.');
                event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                    timestamp: Date.now(),
                    message: 'Primary Gemini Service re-initialized with updated API Key/Model.',
                    level: 'info',
                });
                primaryModelInitialized = true;
            } catch (initError) {
                 console.error('Failed to re-initialize primary Gemini Service after settings save:', initError);
                 event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                    timestamp: Date.now(),
                    message: `Failed to re-initialize primary Gemini Service: ${initError.message}`,
                    level: 'error',
                });
            }
        } else {
            console.warn('Primary Gemini model name not configured. Primary model not re-initialized.');
        }

        if (settingsToSave.strongerRetryModelName && settingsToSave.strongerRetryModelName.trim() !== '') {
            try {
                geminiService.initializeGeminiModel(settingsToSave.apiKey, settingsToSave.strongerRetryModelName, 'retry');
                console.log('Stronger retry Gemini Service re-initialized due to settings change.');
                 event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                    timestamp: Date.now(),
                    message: 'Stronger retry Gemini Service re-initialized.',
                    level: 'info',
                });
                retryModelInitialized = true;
            } catch (initError) {
                console.error('Failed to re-initialize stronger retry Gemini Service after settings save:', initError);
                event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                    timestamp: Date.now(),
                    message: `Failed to re-initialize stronger retry Gemini Service: ${initError.message}`,
                    level: 'error',
                });
            }
        } else {
            console.warn('Stronger retry model name not configured. Retry model not re-initialized (or cleared if it was set before).');
            // Optionally, explicitly de-initialize or clear the 'retry' model instance if it was previously set and now the name is empty
            // geminiService.clearModelInstance('retry'); // Hypothetical function
        }
    } else {
        console.warn('API key not configured. Gemini models not re-initialized.');
    }
    // Update GFC with new settings
    if (globalFileAdmissionController) {
        globalFileAdmissionController.updateSettings(settingsToSave);
    }
    event.sender.send(ipcChannels.SAVE_SETTINGS_RESPONSE, { success: true });
  } catch (error) {
    console.error('Error saving settings in main:', error);
    event.sender.send(ipcChannels.SAVE_SETTINGS_RESPONSE, { success: false, error: error.message });
  }
});

ipcMain.on(ipcChannels.LOAD_DEFAULT_SETTINGS_REQUEST, (event) => {
    event.sender.send(ipcChannels.LOAD_DEFAULT_SETTINGS_RESPONSE, { defaultSettings: settingsManager.defaultSettings });
});


// ongoingTranslations can be used for text translation jobs.
// transcriptionService manages its own active Python processes.
const ongoingTranslations = new Map(); // filePath -> { cancel: () => void } or similar control object
let activeSrtProcessingJobs = new Set(); // Stores jobIds (e.g., filePath or uuid) of currently processing SRT files
let srtProcessingQueue = []; // Stores filePaths waiting to be processed if concurrency limit is hit
let isSrtBatchCancelled = false; // Flag for batch cancellation

// --- Video Processing Redesign (based on video_pipeline_redesign_plan.md) ---

let videoProcessingCoordinatorInstance = null;

class TranscriptionManager extends EventEmitter {
    constructor(settings, sendIpcMessage) {
        super();
        this.settings = settings;
        this.sendIpcMessage = sendIpcMessage;
        this.transcriptionQueue = [];
        this.currentJob = null;
        this.isProcessing = false;
        this.isCancelled = false;
    }

    addJob(videoJob) { // videoJob: { filePath, jobId, globalSettings, allSettings }
        this.transcriptionQueue.push(videoJob);
        this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
            filePath: videoJob.filePath, jobId: videoJob.jobId, progress: 0, status: 'Queued for Transcription', stage: 'transcribing', type: 'video'
        });
        this._processNext();
    }

    async _processNext() {
        if (this.isProcessing || this.transcriptionQueue.length === 0 || this.isCancelled) {
            return;
        }
        this.isProcessing = true;
        this.currentJob = this.transcriptionQueue.shift();
        const { filePath, jobId, globalSettings, allSettings } = this.currentJob;

        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(filePath)}] Starting transcription.`, level: 'info' });
        this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
            filePath, jobId, progress: 0, status: 'Initializing transcription...', stage: 'transcribing', type: 'video'
        });

        try {
            // Determine output path for the pre-translation SRT
            const outputDir = path.dirname(filePath); // Output SRT next to the video file
            // Ensure output directory exists (transcriptionService also does this, but good to be robust)
            try {
                await fs.mkdir(outputDir, { recursive: true });
            } catch (dirError) {
                 this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(filePath)}] Failed to create output directory ${outputDir}: ${dirError.message}`, level: 'error' });
                 throw new Error(`Failed to create output directory ${outputDir}: ${dirError.message}`);
            }
            const videoFileNameBase = path.parse(filePath).name;
            const preTranslationSrtPath = path.join(outputDir, `${videoFileNameBase}.srt`); // Changed to .srt
            
            this.currentJob.preTranslationSrtPath = preTranslationSrtPath; // Store this path

            // outputSrtPathForService will now be the final pre-translation SRT path
            const outputSrtPathForService = preTranslationSrtPath;

            const transcriptionSettings = {
                // Common settings for both WhisperX and FunASR (though FunASR might not use all of them via CLI)
                language: globalSettings ? globalSettings.transcriptionSourceLanguage : null,
                enable_diarization: (globalSettings && globalSettings.enableDiarization === true),
                // Conditional Hugging Face Token
                huggingFaceToken: (globalSettings && globalSettings.enableDiarization === true && (!globalSettings.transcriptionSourceLanguage || !globalSettings.transcriptionSourceLanguage.toLowerCase().startsWith('zh'))) ? allSettings.huggingFaceToken : null,
            };

            // Add WhisperX-specific settings only if not Chinese
            if (!globalSettings || !globalSettings.transcriptionSourceLanguage || !globalSettings.transcriptionSourceLanguage.toLowerCase().startsWith('zh')) {
                transcriptionSettings.compute_type = allSettings.transcriptionComputeType;
                transcriptionSettings.condition_on_previous_text = allSettings.transcriptionConditionOnPreviousText;
                transcriptionSettings.threads = allSettings.transcriptionThreads;
            }
            // For FunASR, specific model parameters like 'paraformer-zh', 'fsmn-vad' etc. are hardcoded in video_to_srt.py
            // and not passed from here. `allSettings` might contain other general settings if needed by transcriptionService.
            // We can also pass allSettings directly and let transcriptionService pick what it needs if that's cleaner.
            // For now, being explicit with what's added.

            const transcriptionResult = await transcriptionService.startVideoToSrtTranscription(
                jobId, filePath, outputSrtPathForService, transcriptionSettings, // modelPath removed
                (progress) => { // Progress Callback
                    if (this.isCancelled && this.currentJob && this.currentJob.jobId === jobId) {
                        transcriptionService.cancelTranscription(jobId);
                        return;
                    }
                    this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                        filePath, jobId,
                        progress: (typeof progress.numerical_progress === 'number' && progress.numerical_progress >= 0) ? progress.numerical_progress : (progress.total_seconds > 0 ? (progress.processed_seconds / progress.total_seconds) * 100 : 0),
                        status: progress.current_segment_text ? `Segment: ${progress.current_segment_text.substring(0,30)}...` : (progress.status || 'Processing...'),
                        stage: 'transcribing', type: 'video',
                        chunkInfo: progress.type === 'progress' ? `Processed ${Math.round(progress.processed_seconds || 0)}s / ${Math.round(progress.total_seconds || 0)}s` : (progress.message || '')
                    });
                },
                (level, message) => this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(filePath)}] Python log: ${message}`, level })
            );

            if (this.isCancelled && this.currentJob && this.currentJob.jobId === jobId) {
                 throw new Error('Transcription cancelled by user.');
            }

            // --- Plan Section III.A.1.d ---
            // transcriptionResult from the modified transcriptionService will now contain:
            // { srtFilePath: preTranslationSrtPath, srtContent: null, detectedLanguage, languageProbability }
            if (!transcriptionResult || !transcriptionResult.srtFilePath || transcriptionResult.srtFilePath !== preTranslationSrtPath) {
                throw new Error(`Transcription did not produce the expected SRT file at ${preTranslationSrtPath}.`);
            }
            // No need to read rawWhisperSrtContentString here, VPC will do it from preTranslationSrtPath
            
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(filePath)}] Transcription complete. Detected Lang: ${transcriptionResult.detectedLanguage} (Prob: ${transcriptionResult.languageProbability}). Pre-translation SRT saved at: ${transcriptionResult.srtFilePath}`, level: 'info' });
            
            this.emit('transcriptionComplete', {
                jobId,
                preTranslationSrtPath: transcriptionResult.srtFilePath, // Pass the path to the pre-translation SRT file
                originalVideoJob: this.currentJob,
                detectedLanguage: transcriptionResult.detectedLanguage,
                languageProbability: transcriptionResult.languageProbability,
            });

        } catch (error) {
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(filePath)}] Transcription failed: ${error.message}`, level: 'error' });
            this.emit('transcriptionFailed', { jobId, error: error.message, originalVideoJob: this.currentJob });
            transcriptionService.cancelTranscription(jobId); // Ensure cleanup
        } finally {
            this.isProcessing = false;
            this.currentJob = null;
            if (!this.isCancelled) {
                this._processNext();
            }
        }
    }

    cancel(jobIdToCancel) { // Can be specific job or all
         if (this.currentJob && this.currentJob.jobId === jobIdToCancel) {
            this.isCancelled = true; // Signal current job to stop if possible
            transcriptionService.cancelTranscription(jobIdToCancel);
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(this.currentJob.filePath)}] Transcription cancellation requested for active job ${jobIdToCancel}.`, level: 'warn' });
             // The current job's finally block will handle emitting failure/cancelled
        }
        this.transcriptionQueue = this.transcriptionQueue.filter(job => {
            if (job.jobId === jobIdToCancel || !jobIdToCancel) { // if no specific job, cancel all in queue
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: job.filePath, jobId: job.jobId, status: 'Cancelled', error: 'Cancelled by user before transcription.', type: 'video'
                });
                return false;
            }
            return true;
        });
        if (!jobIdToCancel) { // If it's a "cancel all"
            this.isCancelled = true;
             if (this.currentJob) { // also cancel current if it's a general cancel
                transcriptionService.cancelTranscription(this.currentJob.jobId);
             }
        }
        if (this.transcriptionQueue.length === 0 && !this.isProcessing) {
            this.isCancelled = false; // Reset if queue empty and not processing
        }
    }

    resetCancellation() {
        this.isCancelled = false;
    }
}

// Simplified TranslationManager as per new plan
class SimplifiedTranslationManager {
    constructor(gfc, sendIpcMessageCallback) {
        this.gfc = gfc; // Reference to GlobalFileAdmissionController
        this.sendIpcMessage = sendIpcMessageCallback;
        this.activeOrchestratorJobs = new Map(); // jobId -> true (or some state if needed)
    }

    async processFile(fileJob) { // fileJob is an instance of FileJob
        const { jobId, filePath, type, srtContent, globalSettings, allSettings } = fileJob;
        const identifierForLogging = path.basename(filePath);

        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, {
            timestamp: Date.now(),
            message: `[${identifierForLogging}] SimplifiedTM: Starting translation for Job ID: ${jobId}. Type: ${type}`,
            level: 'info'
        });
        this.activeOrchestratorJobs.set(jobId, true);

        // Reset translation orchestrator's specific cancel flag for this job
        // The global flag in translationOrchestrator.js is set by GFC's handleGlobalCancel via this.cancelJob
        setTranslationCancellation(false, jobId);

        try {
            // **** EXTRACT sourceLanguageOfSrt ****
            // globalSettings here are specific to this job, passed from GFC.addJob
            const sourceLang = globalSettings.sourceLanguageOfSrt;

            const result = await processSRTFile(
                filePath, // Identifier for UI and logging (original file path)
                srtContent, // Actual SRT content to translate (already parsed and passed in FileJob)
                globalSettings.targetLanguageFullName, // Pass the full name for prompt
                sourceLang, // **** PASS IT HERE ****
                { ...allSettings, targetLanguageCode: globalSettings.targetLanguageCode, targetLanguageFullName: globalSettings.targetLanguageFullName }, // Pass both to orchestrator via settings
                (fp, progress, statusText, chunkInfo) => { // Progress callback
                    // Check if this job was cancelled by GFC while orchestrator was running
                    if (!this.activeOrchestratorJobs.has(jobId)) { // If job was cancelled and removed
                         setTranslationCancellation(true, jobId); // Signal orchestrator to stop this specific job
                         return;
                    }
                    this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                        filePath: fp, // This should be the original filePath from FileJob
                        jobId,
                        progress,
                        status: statusText,
                        stage: 'translating', // This manager only handles translation phase
                        chunkInfo,
                        type: type === 'video_translation_phase' ? 'video' : 'srt'
                    });
                },
                (timestamp, message, level) => { // Log callback
                    this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                        timestamp,
                        message: `[${identifierForLogging}] Orchestrator: ${message}`,
                        level
                    });
                },
                jobId, // Pass job ID to orchestrator
                this.gfc // Pass GFC instance to orchestrator
            );

            // Check again if job was cancelled while orchestrator was finishing
            if (!this.activeOrchestratorJobs.has(jobId)) {
                console.log(`SimplifiedTM: Job ${jobId} was cancelled during/after orchestrator completion. GFC already notified.`);
                // GFC.jobCompleted would have been called by cancelJob if it was an active cancel.
                // If it was a passive cancel (global flag caught by orchestrator), result.status might be 'Cancelled'.
                // Ensure GFC is notified correctly.
                if (result.status !== 'Cancelled') { // If orchestrator didn't self-cancel due to global flag
                     this.gfc.jobCompleted(jobId, 'Cancelled', 'Cancelled during finalization.');
                } else {
                    this.gfc.jobCompleted(jobId, result.status, result.error, result.outputPath);
                }
            } else {
                 this.gfc.jobCompleted(jobId, result.status, result.error, result.outputPath);
            }

        } catch (error) {
            console.error(`SimplifiedTM: Unhandled error processing job ${jobId} for ${filePath}: ${error.message}`);
            if (this.activeOrchestratorJobs.has(jobId)) { // Only notify GFC if not already handled by a cancel
                this.gfc.jobCompleted(jobId, 'Error', `Unhandled Orchestrator Error: ${error.message}`);
            }
        } finally {
            this.activeOrchestratorJobs.delete(jobId);
        }
    }

    cancelJob(jobIdToCancel) {
        if (this.activeOrchestratorJobs.has(jobIdToCancel)) {
            console.log(`SimplifiedTM: Received cancel for active job ${jobIdToCancel}. Signalling orchestrator.`);
            setTranslationCancellation(true, jobIdToCancel); // Signal orchestrator for this specific job
            
            // Orchestrator will eventually call its callbacks which lead to gfc.jobCompleted.
            // To ensure GFC knows it's a cancellation, we can proactively tell GFC.
            // However, the orchestrator's result.status should be 'Cancelled'.
            // For now, let the orchestrator finish and report 'Cancelled'.
            // If orchestrator doesn't handle the flag quickly, this might delay GFC update.
            // Alternative:
            // this.gfc.jobCompleted(jobIdToCancel, 'Cancelled', 'Cancelled by GFC signal.');
            // this.activeOrchestratorJobs.delete(jobIdToCancel);
            // This needs careful thought: if we tell GFC it's cancelled, but orchestrator still writes a file, it's inconsistent.
            // Best is to rely on orchestrator respecting the flag and returning 'Cancelled'.
        } else {
            console.log(`SimplifiedTM: Received cancel for job ${jobIdToCancel}, but it's not actively tracked here (might be already finished or not started by this TM).`);
        }
    }
}
let simplifiedTranslationManager; // Declare instance variable

class VideoProcessingCoordinator extends EventEmitter {
    constructor(event, initialVideoFiles, globalSettings, allSettings) {
        super();
        this.event = event; // IPC event for sending messages back to renderer
        this.initialVideoFiles = initialVideoFiles; // Array of filePaths
        this.globalSettings = globalSettings;
        this.allSettings = allSettings;

        this.videoJobs = new Map(); // videoJobId -> { filePath, status, srtPath, outputPath, originalJobData, gfcTranslationJobId? }
        this.isBatchCancelled = false;

        this.transcriptionManager = new TranscriptionManager(allSettings, this.sendIpcMessage.bind(this));
        // TranslationManager is no longer directly used by VideoProcessingCoordinator in this manner.
        // It will interact with GlobalFileAdmissionController for the translation phase.

        this._setupManagerListeners();
    }

    sendIpcMessage(channel, payload) {
        if (this.event && this.event.sender) {
            this.event.sender.send(channel, payload);
        } else {
            console.error("VideoProcessingCoordinator: IPC event sender not available.");
        }
    }

    _setupManagerListeners() {
        this.transcriptionManager.on('transcriptionComplete', async ({ jobId, preTranslationSrtPath, originalVideoJob, detectedLanguage, languageProbability }) => {
            if (this.isBatchCancelled) return;
            const jobData = this.videoJobs.get(jobId);
            if (!jobData) {
                this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[Job ID: ${jobId}] Video job data not found after transcription. Cannot proceed.`, level: 'error' });
                return;
            }

            jobData.preTranslationSrtPath = preTranslationSrtPath; // Store the path to the SRT in the output directory
 
            // Read content from the pre-translation SRT file in the output directory
            let rawWhisperSrtContent;
            try {
                rawWhisperSrtContent = await fs.readFile(preTranslationSrtPath, 'utf8');
            } catch (readErr) {
                this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(jobData.filePath)}] Failed to read pre-translation SRT file ${preTranslationSrtPath}: ${readErr.message}`, level: 'error' });
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath: jobData.filePath, jobId, status: 'Error', error: `Failed to read pre-translation SRT file: ${readErr.message}`, type: 'video'});
                this._checkBatchCompletion();
                return;
            }
 
            if (!rawWhisperSrtContent || !rawWhisperSrtContent.trim()) {
                this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(jobData.filePath)}] Pre-translation SRT content is empty or missing from ${preTranslationSrtPath}. Cannot proceed.`, level: 'error' });
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath: jobData.filePath, jobId, status: 'Error', error: 'Empty or missing pre-translation SRT content.', type: 'video'});
                this._checkBatchCompletion();
                return;
            }
 
            // Check if translation is disabled
            if (this.globalSettings.targetLanguageCode === 'none') {
                this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(jobData.filePath)}] Translation disabled (target language code is 'none'). Transcription output is final.`, level: 'info' });
                jobData.status = 'Success (No Translation)';
                jobData.outputPath = preTranslationSrtPath; // The transcribed SRT is the final output
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                   filePath: jobData.filePath,
                   jobId,
                   status: 'Success (No Translation)',
                   outputPath: preTranslationSrtPath,
                   type: 'video'
               });
               this._checkBatchCompletion();
            } else {
                // Proceed with translation
                const finalPreTranslationSrtContent = rawWhisperSrtContent;
                jobData.srtPath = preTranslationSrtPath; // The path to the WhisperX output (now in output dir)
               
                jobData.status = 'PendingTranslation';
                this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                    filePath: jobData.filePath, jobId, progress: 50, // Adjusted progress
                    status: 'Transcription Complete, Queued for Translation Budget',
                    stage: 'translating',
                    type: 'video'
                });

                if (globalFileAdmissionController) {
                    const gfcJobId = globalFileAdmissionController.addJob({
                        filePath: originalVideoJob.filePath,
                        type: 'video_translation_phase',
                        srtContent: finalPreTranslationSrtContent,
                        globalSettings: {
                            targetLanguageCode: this.globalSettings.targetLanguageCode,
                            targetLanguageFullName: this.globalSettings.targetLanguageFullName,
                            sourceLanguageOfSrt: detectedLanguage,
                            thinkingBudget: this.allSettings.thinkingBudget, // Add this line
                        },
                        allSettings: this.allSettings
                    });

                    if (gfcJobId) {
                        jobData.gfcTranslationJobId = gfcJobId;
                        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(jobData.filePath)}] Translation phase submitted to GFC with GFC Job ID: ${gfcJobId}`, level: 'info' });
                    } else {
                        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(jobData.filePath)}] GFC rejected translation phase job.`, level: 'error' });
                        this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath: jobData.filePath, jobId, status: 'Error', error: 'GFC rejected translation phase.', type: 'video'});
                        this._checkBatchCompletion();
                    }
                } else {
                    this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(jobData.filePath)}] Error: GFC not available for translation phase.`, level: 'error' });
                    this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath: jobData.filePath, jobId, status: 'Error', error: 'GFC not available for translation.', type: 'video'});
                    this._checkBatchCompletion();
                }
            }
        });

        this.transcriptionManager.on('transcriptionFailed', ({ jobId, error, originalVideoJob }) => {
            if (this.isBatchCancelled && !error.toLowerCase().includes('cancel')) return; // If batch cancelled, only propagate explicit cancel errors
            const jobData = this.videoJobs.get(jobId);
            if (jobData) {
                jobData.status = 'FailedTranscription';
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: jobData.filePath, jobId, status: 'Error', error: `Transcription Failed: ${error}`, type: 'video'
                });
            }
            this._checkBatchCompletion();
        });

        // Listen for GFC's completion of a video translation phase
        if (globalFileAdmissionController) {
            globalFileAdmissionController.on('videoTranslationPhaseComplete', async ({ originalVideoJobId, originalVideoFilePath, status, error, outputPath }) => {
                // The originalVideoJobId from GFC event is the GFC job ID.
                // We need to find the VPC job that corresponds to this GFC job ID.
                let vpcJobToUpdate = null;
                for (const [vpcJobId, jobDetails] of this.videoJobs.entries()) {
                    if (jobDetails.gfcTranslationJobId === originalVideoJobId) {
                        vpcJobToUpdate = jobDetails;
                        // Use the VPC's own job ID for IPC messages to the renderer
                        // as the renderer tracks files by the VPC's job ID.
                        // The GFC's originalVideoFilePath should match vpcJobToUpdate.filePath.
                        if (vpcJobToUpdate.filePath !== originalVideoFilePath) {
                             this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[VPC] Mismatch in file path for GFC job ${originalVideoJobId}. GFC path: ${originalVideoFilePath}, VPC path: ${vpcJobToUpdate.filePath}`, level: 'warn' });
                        }
                        break;
                    }
                }

                if (vpcJobToUpdate) {
                    this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                        timestamp: Date.now(),
                        message: `[${path.basename(vpcJobToUpdate.filePath)}] Translation phase completed by GFC. Status: ${status}. GFC Job ID: ${originalVideoJobId}`,
                        level: status === 'Success' ? 'info' : 'error'
                    });

                    vpcJobToUpdate.status = status; // Update VPC's internal job status
                    if (status === 'Success') {
                        vpcJobToUpdate.outputPath = outputPath; // Store translated output path
                        vpcJobToUpdate.progress = 100;
                    } else {
                        vpcJobToUpdate.error = error; // Store error message
                    }
                    
                    // Send a TRANSLATION_FILE_COMPLETED event to the renderer,
                    // using the VPC's original job ID for the video file.
                    this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                        filePath: vpcJobToUpdate.filePath,
                        jobId: vpcJobToUpdate.originalJobData.jobId, // This is the VPC's original job ID for this video file
                        status: status,
                        outputPath: outputPath,
                        error: error,
                        type: 'video'
                    });

                    // Pre-translation SRT is now saved in the output directory and should NOT be cleaned up.
                    // The old cache cleanup logic is removed.
                    if (vpcJobToUpdate.preTranslationSrtPath) {
                         this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[${path.basename(vpcJobToUpdate.filePath)}] Pre-translation SRT remains at: ${vpcJobToUpdate.preTranslationSrtPath}`, level: 'info' });
                    }

                } else {
                    this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[VPC] Received videoTranslationPhaseComplete for unknown GFC Job ID: ${originalVideoJobId} (File: ${originalVideoFilePath}). Could not map to VPC job.`, level: 'warn' });
                }
                this._checkBatchCompletion(); // Check if the whole batch is done
            });
        } else {
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `[VPC] Critical: GFC not available to listen for videoTranslationPhaseComplete events.`, level: 'error' });
        }
    }

    async start() {
        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Video processing batch started for ${this.initialVideoFiles.length} files.`, level: 'info' });
        
        // Initialize Gemini if needed
        if (!geminiService.isInitialized()) {
            try {
                if (this.allSettings.apiKey && this.allSettings.geminiModel) {
                    geminiService.initializeGeminiModel(this.allSettings.apiKey, this.allSettings.geminiModel);
                    this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Gemini Service initialized for video batch.', level: 'info' });
                } else {
                    throw new Error('API Key or Model for Gemini is not configured in settings.');
                }
            } catch (initError) {
                this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Cannot start video batch: Gemini Service error. ${initError.message}`, level: 'error' });
                this.initialVideoFiles.forEach(filePath => {
                    const tempJobId = `video-init-fail-${uuidv4()}`;
                     this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: tempJobId, status: 'Error', error: 'Gemini Service initialization failed.', type: 'video' });
                });
                return; // Stop if Gemini can't be initialized
            }
        }
        this.transcriptionManager.resetCancellation();
        if (globalFileAdmissionController) globalFileAdmissionController.resetVideoCancellation(); // Reset GFC's video-specific cancel state
        this.isBatchCancelled = false;

        for (const filePath of this.initialVideoFiles) {
            const jobId = `video-${uuidv4()}-${path.basename(filePath)}`;
            const videoJobData = {
                filePath,
                jobId,
                globalSettings: this.globalSettings,
                allSettings: this.allSettings
            };
            this.videoJobs.set(jobId, { filePath, status: 'PendingTranscription', originalJobData: videoJobData });
            this.transcriptionManager.addJob(videoJobData);
        }
    }

    cancelBatch() {
        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Video processing batch cancellation initiated.', level: 'warn' });
        this.isBatchCancelled = true; // VPC's own flag
        this.transcriptionManager.cancel(null); // Cancel all in transcription manager
        if (globalFileAdmissionController) {
            globalFileAdmissionController.cancelVideoTranslationPhaseJobs(); // This will handle cancelling video translation phase jobs in GFC
        }

        // Mark any jobs in videoJobs map that might not have been picked up by manager cancellations yet
        // This is mainly for jobs that might be in a state before GFC took over or if GFC signal is missed.
        this.videoJobs.forEach(job => {
            if (job.status !== 'Success' && job.status !== 'Error' && job.status !== 'Cancelled' &&
                !job.status.startsWith('Failed')) { // Avoid overwriting final error states
                job.status = 'Cancelled';
                 this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath: job.filePath, jobId: job.originalJobData.jobId, status: 'Cancelled', error: 'Batch cancelled by user.', type: 'video'
                });
            }
        });
        this._checkBatchCompletion(); // To potentially log completion of cancellation
    }
    
    async retryJob(jobIdToRetry, filePath, targetLanguage) { // Made async for potential fs.readFile
        const jobData = this.videoJobs.get(jobIdToRetry);
        if (!jobData) {
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Cannot retry job ${jobIdToRetry} for ${filePath}. Job data not found.`, level: 'warn' });
            return;
        }

        const originalStatus = jobData.status; // Store original status for decision making

        // Allow retry from 'FailedTranscription', 'FailedTranslation', 'Error', 'Cancelled'.
        // 'FailedResegmentation' is removed.
        if (originalStatus !== 'FailedTranscription' &&
            originalStatus !== 'FailedTranslation' &&
            originalStatus !== 'Error' &&
            originalStatus !== 'Cancelled') {
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Cannot retry job ${jobIdToRetry} for ${filePath}. Status: ${originalStatus} is not a failed/cancellable state for retry.`, level: 'warn' });
            return;
        }

        this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Retrying job ${jobIdToRetry} for ${filePath} (Original Status: ${originalStatus}).`, level: 'info' });
        
        // Update global settings for this retry if targetLanguage is provided for translation phase
        const retryGlobalSettings = {
            ...this.globalSettings, // Base global settings
            targetLanguage: targetLanguage || this.globalSettings.targetLanguage // Override if provided
        };
        // For transcription retries, globalSettings from originalJobData are typically reused by TranscriptionManager

        const newJobIdForRetryAttempt = `video-retry-${uuidv4()}-${path.basename(filePath)}`;

        // If failed before or during transcription
        if (originalStatus === 'FailedTranscription' ||
            (originalStatus === 'Error' && !jobData.preTranslationSrtPath) || // Error before transcription produced SRT
            (originalStatus === 'Cancelled' && !jobData.preTranslationSrtPath) // Cancelled before transcription produced SRT
           ) {
            // Retry from the transcription phase
            this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                filePath, jobId: newJobIdForRetryAttempt, progress: 0, status: 'Retrying Transcription...', stage: 'transcribing', type: 'video'
            });
            
            const newTranscriptionJobData = {
                filePath,
                jobId: newJobIdForRetryAttempt, // Use a new Job ID for the retry attempt
                globalSettings: jobData.originalJobData.globalSettings, // Use original global settings for transcription
                allSettings: this.allSettings
            };
            
            this.videoJobs.delete(jobIdToRetry); // Remove old failed/cancelled job entry
            this.videoJobs.set(newJobIdForRetryAttempt, { filePath, status: 'PendingTranscription', originalJobData: newTranscriptionJobData, preTranslationSrtPath: null }); // preTranslationSrtPath is null as transcription is being retried
 
            this.transcriptionManager.resetCancellation();
            this.transcriptionManager.addJob(newTranscriptionJobData);
            console.log(`VPC: Retrying from transcription for ${filePath} with new job ID ${newJobIdForRetryAttempt}`);

        } else if (originalStatus === 'FailedTranslation' ||
                   (originalStatus === 'Error' && jobData.preTranslationSrtPath) ||      // Error after transcription
                   (originalStatus === 'Cancelled' && jobData.preTranslationSrtPath)    // Cancelled after transcription
                  ) {
            // Retry only the translation phase
            // This means transcription was successful.
            
            let srtContentToTranslate;
            let srtPathForLog;
 
            // jobData.preTranslationSrtPath is the path to the SRT in the output directory
            if (jobData.preTranslationSrtPath) {
                try {
                    srtContentToTranslate = await fs.readFile(jobData.preTranslationSrtPath, 'utf8');
                    srtPathForLog = jobData.preTranslationSrtPath;
                } catch (readError) {
                    this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Cannot retry translation for ${filePath}: Failed to read pre-translation SRT file ${jobData.preTranslationSrtPath}. Error: ${readError.message}`, level: 'error' });
                    this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: jobIdToRetry, status: 'Error', error: 'Pre-translation SRT file read error for translation retry.', type: 'video' });
                    return;
                }
            } else {
                 this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Cannot retry translation for ${filePath}: No pre-translation SRT path found.`, level: 'error' });
                 this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: jobIdToRetry, status: 'Error', error: 'No pre-translation SRT path for translation retry.', type: 'video' });
                return;
            }

            this.sendIpcMessage(ipcChannels.TRANSLATION_PROGRESS_UPDATE, {
                filePath, jobId: newJobIdForRetryAttempt, progress: 0, status: 'Retrying Translation (Queued for Budget)...', stage: 'translating', type: 'video'
            });
            
            // Update the job in videoJobs map with the new Job ID for the retry attempt
            this.videoJobs.delete(jobIdToRetry); // Remove old job
            const newTranslationPhaseJobData = {
                 filePath,
                 jobId: newJobIdForRetryAttempt,
                 globalSettings: retryGlobalSettings,
                 allSettings: this.allSettings,
                 srtContent: srtContentToTranslate, // Pass the actual content
                 type: 'video_translation_phase'
            };
            // ResegmentedSrtContent is removed. srtPath is the cached WhisperX output.
            this.videoJobs.set(newJobIdForRetryAttempt, {
                filePath,
                status: 'PendingTranslationRetry',
                originalJobData: newTranslationPhaseJobData,
                srtPath: jobData.preTranslationSrtPath, // Path to WhisperX SRT output (in output dir)
                preTranslationSrtPath: jobData.preTranslationSrtPath // Store for clarity
            });
 
            if (!globalFileAdmissionController) {
                this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Error preparing translation retry for ${filePath}: GFC not available.`, level: 'error' });
                this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: newJobIdForRetryAttempt, status: 'Error', error: 'GFC not available for retry.', type: 'video' });
                return;
            }

            globalFileAdmissionController.resetGlobalCancel();
            const gfcRetryJobId = globalFileAdmissionController.addJob({
                filePath: filePath, // Original video file path
                type: 'video_translation_phase',
                srtContent: srtContentToTranslate,
                globalSettings: { // Ensure thinkingBudget is part of the globalSettings for GFC
                    targetLanguage: retryGlobalSettingsVideo.targetLanguage,
                    sourceLanguageOfSrt: detectedLanguage, // This needs to be available or re-detected for translation phase
                    thinkingBudget: currentFullSettings.thinkingBudget,
                },
                allSettings: currentFullSettings // Pass fresh full settings
            }, true); // isManualRetry = true

            if (gfcRetryJobId) {
                // Update the VPC job with the new GFC job ID for this retry attempt
                const vpcJobData = this.videoJobs.get(newJobIdForRetryAttempt);
                if (vpcJobData) {
                    vpcJobData.gfcTranslationJobId = gfcRetryJobId;
                }
                console.log(`VPC: Retrying translation for ${filePath} (using ${srtPathForLog}) via GFC. New GFC Job ID: ${gfcRetryJobId}. VPC tracking ID: ${newJobIdForRetryAttempt}`);
            } else {
                 console.error(`VPC: GFC rejected retry translation job for ${filePath}.`);
                 this.sendIpcMessage(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: newJobIdForRetryAttempt, status: 'Error', error: 'GFC rejected retry translation.', type: 'video' });
                 this._checkBatchCompletion();
            }

        } else {
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Job ${jobIdToRetry} for ${filePath} has unhandled status for retry: ${originalStatus}.`, level: 'warn' });
        }
    }


    _checkBatchCompletion() {
        let allDone = true;
        for (const job of this.videoJobs.values()) {
            if (job.status !== 'Success' &&
                job.status !== 'FailedTranscription' &&
                job.status !== 'FailedTranslation' &&
                job.status !== 'Error' &&
                job.status !== 'Cancelled' &&
                job.status !== 'Success (No Translation)' &&
                job.status !== 'Success (No Translation Needed)') {
                allDone = false;
                break;
            }
        }
        if (allDone) {
            this.sendIpcMessage(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Video processing batch finished.', level: 'info' });
            videoProcessingCoordinatorInstance = null; // Allow for new batch
        }
    }
}

// --- New "Translate SRT" Tab Handlers (Refactored for GFC) ---
ipcMain.on(ipcChannels.START_SRT_BATCH_PROCESSING_REQUEST, async (event, { srtFilePaths, globalSettings, allSettings }) => {
    if (!globalFileAdmissionController) {
        console.error('GlobalFileAdmissionController not initialized. Cannot start SRT batch.');
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Error: Concurrency controller not ready.', level: 'error' });
        return;
    }
    globalFileAdmissionController.resetSrtCancellation(); // Reset for new SRT batch

    if (!geminiService.isInitialized()) {
        try {
            // Use allSettings passed from renderer, which should be current
            if (allSettings.apiKey && allSettings.geminiModel) {
                geminiService.initializeGeminiModel(allSettings.apiKey, allSettings.geminiModel);
                event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Gemini Service initialized for SRT batch.', level: 'info' });
            } else {
                throw new Error('API Key or Model is not configured in provided settings.');
            }
        } catch (initError) {
            console.error('Gemini service init failed for SRT batch:', initError);
            event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Cannot start SRT batch: Gemini Service error. ${initError.message}`, level: 'error' });
            srtFilePaths.forEach(fp => {
                event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath: fp, jobId: `srt-init-fail-${uuidv4()}`, status: 'Error', error: 'Gemini Service initialization failed.', type: 'srt' });
            });
            return;
        }
    }

    event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Received request to process ${srtFilePaths.length} SRT files. Handing over to GlobalFileAdmissionController.`, level: 'info' });

    for (const filePath of srtFilePaths) {
        try {
            const srtFileContent = await fs.readFile(filePath, 'utf8');
            if (!srtFileContent.trim()) {
                 event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `SRT file ${filePath} is empty. Skipping.`, level: 'warn' });
                 event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: `srt-empty-${uuidv4()}`, status: 'Error', error: 'SRT file is empty.', type: 'srt' });
                continue;
            }
            
            if (globalSettings.targetLanguageCode === 'none') {
                // Translation is disabled. The original file is considered the output.
                // No new file is created or copied.
                const outputPath = filePath; // The original file path is the output path.
                
                event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `SRT file ${filePath} processed (translation disabled, original file is output).`, level: 'info' });
                event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath,
                    jobId: `srt-none-${uuidv4()}`,
                    status: 'Success (No Translation)',
                    outputPath, // Report original file path as output
                    type: 'srt'
                });
            } else {
                globalFileAdmissionController.addJob({
                    filePath,
                    type: 'srt',
                    srtContent: srtFileContent,
                    globalSettings, // This already includes thinkingBudget from renderer.js
                    allSettings
                });
            }
        } catch (readError) {
            console.error(`Failed to read SRT file ${filePath} for batch processing: ${readError.message}`);
            event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `Failed to read SRT file ${filePath}: ${readError.message}`, level: 'error' });
            event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: `srt-read-err-${uuidv4()}`, status: 'Error', error: `Failed to read file: ${readError.message}`, type: 'srt' });
        }
    }
});

ipcMain.on(ipcChannels.CANCEL_SRT_BATCH_PROCESSING_REQUEST, (event) => {
  console.log('Cancellation request received for SRT batch processing.');
  if (globalFileAdmissionController) {
      globalFileAdmissionController.cancelSrtJobs();
      event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'SRT batch cancellation initiated.', level: 'warn'});
  } else {
      console.error('GlobalFileAdmissionController not initialized. Cannot cancel SRT batch.');
    event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Error: Concurrency controller not ready for cancellation.', level: 'error' });
  }
});

// --- "Translate Videos" Tab Handlers (Adjusted for GFC) ---
ipcMain.on(ipcChannels.START_VIDEO_QUEUE_PROCESSING_REQUEST, async (event, { videoQueue, globalSettings, allSettings }) => {
    if (videoProcessingCoordinatorInstance) {
        console.warn('Video processing is already active. Request ignored.');
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Video processing already active.', level: 'warn'});
        return;
    }
    console.log(`Received request to process video batch with ${videoQueue.length} videos. Initializing VideoProcessingCoordinator.`);
    // Ensure GFC is ready before VideoProcessingCoordinator starts adding jobs to it.
    if (!globalFileAdmissionController) {
        console.error('GlobalFileAdmissionController not initialized. Cannot start video batch processing.');
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Error: Concurrency controller not ready for video batch.', level: 'error' });
        return;
    }
    // VideoProcessingCoordinator will now use globalFileAdmissionController for the translation phase.
    videoProcessingCoordinatorInstance = new VideoProcessingCoordinator(event, videoQueue, globalSettings, allSettings);
    videoProcessingCoordinatorInstance.start(); // This will eventually call GFC.addJob for translation phases
});

ipcMain.on(ipcChannels.CANCEL_VIDEO_QUEUE_PROCESSING_REQUEST, (event) => {
    console.log('Cancellation request received for Video Queue Processing.');
    if (videoProcessingCoordinatorInstance) {
        videoProcessingCoordinatorInstance.cancelBatch(); // This will call GFC.cancelVideoTranslationPhaseJobs() internally
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'Video queue processing cancellation initiated.', level: 'warn'});
    } else {
        console.warn('Cancellation request for video queue, but no active coordinator. Attempting to cancel video translation phase jobs in GFC.');
        if (globalFileAdmissionController) {
            globalFileAdmissionController.cancelVideoTranslationPhaseJobs(); // Ensure any pending translation phases are also cleared
        }
        event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: 'No active video processing batch to cancel, but video translation phase cancellation triggered in GFC if GFC exists.', level: 'warn'});
    }
});

// DEPRECATED Handlers (Review if any logic needs to be preserved or adapted)
ipcMain.on(ipcChannels.RETRY_FILE_REQUEST, async (event, { filePath, targetLanguageCode, targetLanguageFullName, sourceLanguageOfSrt, settings, type, jobIdToRetry }) => { // Added sourceLanguageOfSrt
    console.log(`Retry request received for: ${filePath}, Type: ${type}, JobID to retry: ${jobIdToRetry}, Target Lang Code: ${targetLanguageCode}, Target Lang FullName: ${targetLanguageFullName}, Source Lang: ${sourceLanguageOfSrt}`);
    
    const currentFullSettings = await settingsManager.loadSettings(); // Always get fresh settings for retry

    if (!globalFileAdmissionController) {
        console.error('GFC not available for retry request.');
        event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: jobIdToRetry, status: 'Error', error: 'Concurrency controller not ready for retry.', type });
        return;
    }

    if (type === 'srt') {
        globalFileAdmissionController.resetSrtCancellation(); // Reset for SRT retry
        try {
            const srtFileContent = await fs.readFile(filePath, 'utf8');
            if (!srtFileContent.trim()) {
                event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `SRT file ${filePath} for retry is empty. Skipping.`, level: 'warn' });
                event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: jobIdToRetry, status: 'Error', error: 'SRT file is empty for retry.', type: 'srt' });
                return;
            }
            const retryGlobalSettingsSRT = {
                targetLanguageCode: targetLanguageCode || currentFullSettings.targetLanguageCode, // Use the destructured targetLanguageCode from IPC arguments
                targetLanguageFullName: targetLanguageFullName || // Use destructured targetLanguageFullName if available
                                      (targetLanguageCode ? targetLanguagesWithNone_main.find(lang => lang.code === targetLanguageCode)?.name : null) || // Else, derive from targetLanguageCode
                                      currentFullSettings.targetLanguageFullName // Fallback to current settings
            };

            if (retryGlobalSettingsSRT.targetLanguageCode === 'none') {
                const baseName = path.parse(filePath).name;
                const outputFileName = `${baseName}.none.srt`;
                const outputDirFullPath = path.resolve(currentFullSettings.outputDirectory);
                const outputPath = path.join(outputDirFullPath, outputFileName);

                await fs.mkdir(outputDirFullPath, { recursive: true });
                await fs.writeFile(outputPath, srtFileContent, 'utf8');
                
                event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, { timestamp: Date.now(), message: `SRT file ${filePath} (retry) copied to ${outputPath} (translation disabled).`, level: 'info' });
                event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, {
                    filePath,
                    jobId: jobIdToRetry, // Use the original job ID for retry completion tracking
                    status: 'Success (No Translation)',
                    outputPath,
                    type: 'srt'
                });
            } else {
                console.log(`Retrying SRT job: ${jobIdToRetry} for file ${filePath}`);
                event.sender.send(ipcChannels.TRANSLATION_PROGRESS_UPDATE, { filePath, jobId: jobIdToRetry, progress: 0, status: 'Retrying (Queued for Budget)...', type: 'srt' });

                globalFileAdmissionController.addJob({
                    filePath,
                    type: 'srt',
                    srtContent: srtFileContent,
                    globalSettings: { // Ensure thinkingBudget is part of the globalSettings for GFC
                        targetLanguageCode: retryGlobalSettingsSRT.targetLanguageCode,
                        targetLanguageFullName: retryGlobalSettingsSRT.targetLanguageFullName,
                        sourceLanguageOfSrt: sourceLanguageOfSrt, // Added source language for retry
                        thinkingBudget: currentFullSettings.thinkingBudget,
                    },
                    allSettings: currentFullSettings
                }, true); // isManualRetry = true
            }
        } catch (readError) {
            console.error(`Failed to read SRT file ${filePath} for retry: ${readError.message}`);
            event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: jobIdToRetry, status: 'Error', error: `Failed to read file for retry: ${readError.message}`, type: 'srt' });
        }
    } else if (type === 'video') {
        // Define retryGlobalSettingsVideo here so it's available for both existing and new coordinator instances
        const retryGlobalSettingsVideo = {
            targetLanguageCode: targetLanguage || currentFullSettings.targetLanguageCode, // Assuming targetLanguage passed is a code
            targetLanguageFullName: targetLanguage ? (targetLanguagesWithNone.find(lang => lang.code === targetLanguage)?.name || targetLanguage) : currentFullSettings.targetLanguageFullName,
            // Ensure other necessary global settings for transcription are included if VPC expects them for retry
            transcriptionSourceLanguage: currentFullSettings.transcriptionSourceLanguage,
            enableDiarization: currentFullSettings.enableDiarization,
        };

        // Video retry is handled by VideoProcessingCoordinator
        if (videoProcessingCoordinatorInstance) {
            console.log(`Retrying Video job: ${jobIdToRetry} for file ${filePath} via VideoProcessingCoordinator.`);
            // The coordinator will decide if it's a transcription retry or translation phase retry (by adding to GFC)
            // Pass both code and full name if available, or let VPC derive if only code is passed
            videoProcessingCoordinatorInstance.retryJob(jobIdToRetry, filePath, retryGlobalSettingsVideo.targetLanguageCode, retryGlobalSettingsVideo.targetLanguageFullName);
        } else { // videoProcessingCoordinatorInstance is null, start a new one for this retry
            console.log(`No active video processing coordinator for video retry of ${filePath}. Starting a new coordinator for this single file.`);
            event.sender.send(ipcChannels.TRANSLATION_LOG_MESSAGE, {
                timestamp: Date.now(),
                message: `Starting new video processing batch for retrying: ${path.basename(filePath)}`,
                level: 'info'
            });

            // currentFullSettings is loaded at the beginning of RETRY_FILE_REQUEST handler
            // retryGlobalSettingsVideo is also defined earlier using targetLanguage and currentFullSettings
            
            videoProcessingCoordinatorInstance = new VideoProcessingCoordinator(
                event,
                [filePath], // Array with the single file to retry
                retryGlobalSettingsVideo, // Contains targetLanguage, transcriptionSourceLanguage, etc.
                currentFullSettings
            );
            videoProcessingCoordinatorInstance.start();
            // The new VideoProcessingCoordinator will handle its own job ID generation and progress updates.
            // The original jobIdToRetry is effectively for the old, defunct job.
        }
    } else {
        console.error(`Unknown type for retry request: ${type} for job ${jobIdToRetry}`);
        event.sender.send(ipcChannels.TRANSLATION_FILE_COMPLETED, { filePath, jobId: jobIdToRetry, status: 'Error', error: `Unknown retry type: ${type}`, type });
    }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

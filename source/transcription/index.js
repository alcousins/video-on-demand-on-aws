/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

const { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require("@aws-sdk/client-transcribe");
const { S3Client } = require("@aws-sdk/client-s3");
const { createDynamoSubtitleClient } = require('./dynamo-subtitle-client.js');
const error = require('./lib/error.js');
const { 
    isVideoFormatSupported, 
    generateTranscriptionJobName, 
    validateAndNormalizeSubtitleConfig, 
    createSubtitleErrorReport,
    logSubtitleError,
    calculateTranscriptionTimeout,
    estimateVideoDuration,
    SUBTITLE_STATUS,
    SUBTITLE_ERROR_TYPES,
    PERFORMANCE_CONFIG
} = require('./subtitle-utils.js');
const { 
    SubtitleErrorHandler,
    handleSubtitleError,
    createRetryWrapper
} = require('./subtitle-error-handler.js');
const {
    calculateOptimizedTranscriptionTimeout,
    createOptimizedPollingConfig,
    monitorResourceUsage,
    estimateVideoDurationFromSize,
    NOTIFICATION_CONFIG
} = require('./performance-optimizer.js');
const {
    sendSubtitleNotification,
    sendProgressNotification
} = require('./notification-integration.js');
const {
    createOptimizedS3Client,
    storeJsonDataInS3,
    generateTranscriptionResultsKey
} = require('./s3-storage-utils.js');

/**
 * Performance-optimized exponential backoff configuration for job polling
 * Dynamically adjusted based on estimated video duration with 4-hour support
 */
function createPollingConfig(estimatedDurationMinutes = 60) {
    // Use enhanced performance optimizer for better 4-hour video support
    return createOptimizedPollingConfig(estimatedDurationMinutes);
}

/**
 * AWS Transcribe job status constants
 */
const TRANSCRIBE_STATUS = {
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
};

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    // Create correlation ID for error tracking
    const correlationId = SubtitleErrorHandler.getOrCreateCorrelationId(event, 'transcription');
    console.log(`Processing transcription with correlation ID: ${correlationId}`);

    // Initialize variables that need to be accessible in error handling
    let estimatedDurationMinutes = 60; // Default assumption

    const transcribeClient = new TranscribeClient({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    const dynamoClient = createDynamoSubtitleClient();

    try {
        // Validate input parameters
        if (!event.guid || !event.srcVideo || !event.srcBucket || !event.destBucket) {
            throw new Error('Missing required parameters: guid, srcVideo, srcBucket, or destBucket');
        }

        // Check if subtitle processing is enabled
        const subtitleConfig = event.subtitleConfig || { enabled: false };
        
        // Use enhanced validation
        const configResult = validateAndNormalizeSubtitleConfig(subtitleConfig);
        
        if (!configResult.isValid) {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
                `Invalid subtitle configuration: ${configResult.errors.join(', ')}`,
                {
                    guid: event.guid,
                    stage: 'transcription',
                    correlationId,
                    configErrors: configResult.errors
                }
            );
            
            logSubtitleError(errorReport);
            throw new Error(errorReport.errorMessage);
        }

        if (!configResult.config.enabled) {
            console.log('Subtitle processing is disabled, skipping transcription');
            return { ...event, correlationId };
        }

        // Validate video format
        if (!isVideoFormatSupported(event.srcVideo)) {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR,
                `Video format not supported for transcription: ${event.srcVideo}`,
                {
                    guid: event.guid,
                    stage: 'transcription',
                    correlationId,
                    videoFile: event.srcVideo
                }
            );
            
            logSubtitleError(errorReport);
            console.log(`Video format not supported for transcription: ${event.srcVideo}`);
            await dynamoClient.updateTranscriptionStatus(event.guid, 'FAILED', {
                failureReason: errorReport.errorMessage
            });
            return { ...event, correlationId };
        }

        // Estimate video duration for performance optimization with enhanced accuracy
        // Try to get file size from event metadata for better duration estimation
        if (event.srcVideoSize || event.fileSize) {
            const fileSizeBytes = event.srcVideoSize || event.fileSize;
            const videoFormat = event.srcVideo.split('.').pop().toLowerCase();
            estimatedDurationMinutes = estimateVideoDurationFromSize(fileSizeBytes, videoFormat);
            console.log(`Enhanced estimated video duration: ${estimatedDurationMinutes} minutes based on file size: ${fileSizeBytes} bytes and format: ${videoFormat}`);
        }

        // Send processing start notification
        await sendSubtitleNotification(
            NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
            {
                guid: event.guid,
                stage: 'transcription',
                correlationId,
                estimatedDuration: estimatedDurationMinutes,
                srcVideo: event.srcVideo,
                srcBucket: event.srcBucket,
                destBucket: event.destBucket
            }
        );

        // Create performance-optimized polling configuration
        const pollingConfig = createPollingConfig(estimatedDurationMinutes);
        console.log(`Using optimized polling config for ${estimatedDurationMinutes}min video:`, {
            initialDelay: pollingConfig.initialDelayMs,
            maxDelay: pollingConfig.maxDelayMs,
            maxAttempts: pollingConfig.maxAttempts,
            timeoutMs: pollingConfig.timeoutMs
        });

        // Generate unique job name
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const transcriptionJobName = generateTranscriptionJobName(event.guid, timestamp);

        // Prepare transcription job parameters with performance optimizations
        const mediaUri = `s3://${event.srcBucket}/${event.srcVideo}`;
        const outputLocation = `s3://${event.destBucket}/${event.guid}/transcription/`;

        const transcriptionParams = {
            TranscriptionJobName: transcriptionJobName,
            Media: {
                MediaFileUri: mediaUri
            },
            OutputBucketName: event.destBucket,
            OutputKey: `${event.guid}/transcription/`,
            Subtitles: {
                Formats: ['vtt'],
                OutputStartIndex: 1
            }
            // Note: JobExecutionSettings removed to avoid data access role requirement
        };

        // Handle language detection vs explicit specification
        if (configResult.config.primaryLanguage && configResult.config.primaryLanguage !== 'auto') {
            // Map common language codes to AWS Transcribe language codes
            const languageMapping = {
                'en': 'en-US',
                'es': 'es-US',
                'fr': 'fr-FR',
                'de': 'de-DE',
                'it': 'it-IT',
                'pt': 'pt-BR',
                'pt-BR': 'pt-BR',
                'ja': 'ja-JP',
                'ko': 'ko-KR',
                'zh': 'zh-CN',
                'ar': 'ar-SA'
            };
            
            const transcribeLanguageCode = languageMapping[configResult.config.primaryLanguage] || configResult.config.primaryLanguage;
            transcriptionParams.LanguageCode = transcribeLanguageCode;
            console.log(`Using explicit language: ${transcribeLanguageCode}`);
        } else {
            // Enable automatic language detection
            transcriptionParams.IdentifyLanguage = true;
            console.log('Using automatic language detection');
        }

        // Update DynamoDB with transcription start status
        await dynamoClient.updateTranscriptionStatus(event.guid, 'STARTING', {
            transcriptionJobId: transcriptionJobName,
            correlationId
        });

        // Create retry wrapper for transcription operations
        const retryTranscriptionOperation = createRetryWrapper('transcription', {
            correlationId,
            estimatedDurationMinutes,
            operationName: 'startTranscriptionJob'
        });

        // Start transcription job with retry logic
        console.log(`Starting transcription job: ${transcriptionJobName}`);
        console.log(`Transcription parameters: ${JSON.stringify(transcriptionParams, null, 2)}`);
        
        await retryTranscriptionOperation(async () => {
            const startJobCommand = new StartTranscriptionJobCommand(transcriptionParams);
            return await transcribeClient.send(startJobCommand);
        });

        // Poll for job completion with performance-optimized exponential backoff
        const startTime = Date.now();
        const jobResult = await pollTranscriptionJobWithRetry(
            transcribeClient, 
            transcriptionJobName, 
            pollingConfig, 
            correlationId,
            startTime,
            event
        );

        if (jobResult.status === TRANSCRIBE_STATUS.COMPLETED) {
            console.log(`Transcription job completed successfully: ${transcriptionJobName}`);
            
            // Send completion notification
            await sendSubtitleNotification(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TRANSCRIPTION_COMPLETE,
                {
                    guid: event.guid,
                    stage: 'transcription',
                    correlationId,
                    processingTime: jobResult.processingTimeSeconds,
                    detectedLanguage: jobResult.detectedLanguage,
                    srcVideo: event.srcVideo
                }
            );
            
            // Store full transcription results in S3 to avoid Step Functions payload limits
            const s3Client = createOptimizedS3Client(process.env.AWS_REGION, process.env.SOLUTION_IDENTIFIER);
            const tempBucket = event.subtitleConfig?.tempBucket || event.srcBucket;
            const transcriptionResultsKey = generateTranscriptionResultsKey(event.guid);
            
            const fullTranscriptionResults = {
                guid: event.guid,
                transcriptionJobName,
                transcriptionOutputLocation: outputLocation,
                detectedLanguage: jobResult.detectedLanguage,
                estimatedDurationMinutes,
                processingTimeSeconds: jobResult.processingTimeSeconds,
                correlationId,
                // Store all original event data that might be needed downstream
                srcVideo: event.srcVideo,
                srcBucket: event.srcBucket,
                destBucket: event.destBucket,
                subtitleConfig: event.subtitleConfig,
                // Add any other relevant fields from the original event
                acceleratedTranscoding: event.acceleratedTranscoding,
                archiveSource: event.archiveSource,
                cloudFront: event.cloudFront,
                enableMediaPackage: event.enableMediaPackage,
                enableSns: event.enableSns,
                enableSqs: event.enableSqs,
                frameCapture: event.frameCapture,
                inputRotate: event.inputRotate,
                jobTemplate_1080p: event.jobTemplate_1080p,
                jobTemplate_2160p: event.jobTemplate_2160p,
                jobTemplate_720p: event.jobTemplate_720p,
                srcMediainfo: event.srcMediainfo,
                startTime: event.startTime,
                workflowName: event.workflowName,
                workflowStatus: event.workflowStatus,
                workflowTrigger: event.workflowTrigger,
                srcHeight: event.srcHeight,
                srcWidth: event.srcWidth,
                encodingProfile: event.encodingProfile,
                jobTemplate: event.jobTemplate,
                isCustomTemplate: event.isCustomTemplate
            };
            
            const s3StorageResult = await storeJsonDataInS3(
                s3Client,
                tempBucket,
                transcriptionResultsKey,
                fullTranscriptionResults,
                {
                    dataType: 'transcription-results',
                    guid: event.guid,
                    stage: 'transcription'
                }
            );
            
            console.log(`Stored transcription results in S3: ${s3StorageResult.s3Location}`);
            
            // Return minimal event with S3 reference instead of full data
            const minimalResult = {
                guid: event.guid,
                transcriptionJobName,
                transcriptionOutputLocation: outputLocation,
                detectedLanguage: jobResult.detectedLanguage,
                estimatedDurationMinutes,
                correlationId,
                // S3 reference for full results
                transcriptionResultsS3Location: s3StorageResult.s3Location,
                transcriptionResultsBucket: tempBucket,
                transcriptionResultsKey: transcriptionResultsKey
            };
            
            // Update DynamoDB with completion status including S3 reference
            await dynamoClient.updateTranscriptionStatus(event.guid, 'COMPLETED', {
                transcriptionJobId: transcriptionJobName,
                detectedLanguage: jobResult.detectedLanguage,
                outputLocation: outputLocation,
                processingTimeSeconds: jobResult.processingTimeSeconds,
                correlationId,
                resultsS3Location: s3StorageResult.s3Location
            });

            return minimalResult;

        } else {
            const errorMessage = `Transcription job failed: ${jobResult.failureReason || 'Unknown error'}`;
            console.error(errorMessage);
            
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR,
                errorMessage,
                {
                    guid: event.guid,
                    stage: 'transcription',
                    correlationId,
                    jobName: transcriptionJobName,
                    failureReason: jobResult.failureReason
                }
            );
            
            logSubtitleError(errorReport);
            
            await dynamoClient.updateTranscriptionStatus(event.guid, 'FAILED', {
                transcriptionJobId: transcriptionJobName,
                failureReason: jobResult.failureReason,
                correlationId
            });
            
            throw new Error(errorMessage);
        }

    } catch (err) {
        console.error('Transcription Lambda error:', err);
        
        // Use the new centralized error handling system
        const errorHandlingResult = await handleSubtitleError(event, err, {
            stage: 'transcription',
            correlationId,
            functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
            estimatedDurationMinutes: estimatedDurationMinutes
        });

        // Update DynamoDB with error status
        try {
            await dynamoClient.updateSubtitleError(event.guid, err.message, errorHandlingResult.correlationId);
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }
        
        // If this is a critical error that should fail the workflow
        if (errorHandlingResult.shouldFailWorkflow) {
            throw err;
        }

        // For non-critical errors, return minimal event to continue workflow without subtitles
        console.log(`Non-critical transcription error, continuing workflow without subtitles: ${err.message}`);
        return { 
            guid: event.guid,
            correlationId: errorHandlingResult.correlationId,
            subtitleProcessingFailed: true,
            subtitleError: err.message
        };
    }

    // This should not be reached, but return minimal event as fallback
    return {
        guid: event.guid,
        correlationId,
        subtitleProcessingFailed: true,
        subtitleError: 'Unknown error in transcription processing'
    };
};

/**
 * Polls transcription job status with performance-optimized exponential backoff and retry logic
 * Enhanced with resource monitoring and progress notifications for 4-hour video support
 * @param {TranscribeClient} transcribeClient - AWS Transcribe client
 * @param {string} jobName - Transcription job name
 * @param {Object} pollingConfig - Performance-optimized polling configuration
 * @param {string} correlationId - Correlation ID for error tracking
 * @param {number} startTime - Processing start time for resource monitoring
 * @param {Object} event - Original Lambda event for progress notifications
 * @returns {Promise<Object>} Job result with status and details
 */
async function pollTranscriptionJobWithRetry(transcribeClient, jobName, pollingConfig, correlationId, startTime, event) {
    const retryPollingOperation = createRetryWrapper('transcription', {
        correlationId,
        operationName: 'pollTranscriptionJob'
    });

    return await retryPollingOperation(async () => {
        return await pollTranscriptionJob(transcribeClient, jobName, pollingConfig, startTime, event);
    });
}

/**
 * Polls transcription job status with performance-optimized exponential backoff
 * Enhanced with resource monitoring and progress notifications for 4-hour video support
 * @param {TranscribeClient} transcribeClient - AWS Transcribe client
 * @param {string} jobName - Transcription job name
 * @param {Object} pollingConfig - Performance-optimized polling configuration
 * @param {number} startTime - Processing start time for resource monitoring
 * @param {Object} event - Original Lambda event for progress notifications
 * @returns {Promise<Object>} Job result with status and details
 */
async function pollTranscriptionJob(transcribeClient, jobName, pollingConfig, startTime, event) {
    let attempt = 0;
    let delayMs = pollingConfig.initialDelayMs;
    let lastProgressNotification = startTime;
    const progressNotificationInterval = 10 * 60 * 1000; // 10 minutes

    console.log(`Starting enhanced transcription job polling with timeout: ${pollingConfig.timeoutMs}ms`);

    while (attempt < pollingConfig.maxAttempts) {
        const currentTime = Date.now();
        const elapsedTime = currentTime - startTime;
        
        // Check for overall timeout to prevent Lambda timeout
        if (elapsedTime > pollingConfig.timeoutMs) {
            console.warn(`Transcription polling timed out after ${elapsedTime}ms`);
            throw new Error(`Transcription job polling timed out after ${Math.floor(elapsedTime / 1000)} seconds. Job may still be processing.`);
        }

        // Monitor resource usage and send progress notifications for long-running jobs
        if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
            const mockContext = {
                getRemainingTimeInMillis: () => Math.max(0, pollingConfig.timeoutMs - elapsedTime)
            };
            
            const resourceUsage = monitorResourceUsage(mockContext, startTime);
            
            // Send progress notification every 10 minutes for long videos
            if (currentTime - lastProgressNotification > progressNotificationInterval) {
                await sendProgressNotification({
                    guid: event.guid,
                    stage: 'transcription',
                    correlationId: event.correlationId,
                    elapsedTimeSeconds: Math.floor(elapsedTime / 1000),
                    estimatedDurationMinutes: event.estimatedDurationMinutes || 60,
                    progressPercent: Math.min(90, (elapsedTime / pollingConfig.timeoutMs) * 100),
                    resourceUsage
                });
                lastProgressNotification = currentTime;
            }
            
            // Check for critical resource usage
            if (resourceUsage.recommendations.criticalResourceUsage) {
                console.warn('Critical resource usage detected during transcription polling');
                await sendProgressNotification({
                    guid: event.guid,
                    stage: 'transcription',
                    correlationId: event.correlationId,
                    elapsedTimeSeconds: Math.floor(elapsedTime / 1000),
                    estimatedDurationMinutes: event.estimatedDurationMinutes || 60,
                    resourceUsage
                });
            }
        }

        try {
            const getJobCommand = new GetTranscriptionJobCommand({
                TranscriptionJobName: jobName
            });
            
            const response = await transcribeClient.send(getJobCommand);
            const job = response.TranscriptionJob;
            
            console.log(`Transcription job status (attempt ${attempt + 1}/${pollingConfig.maxAttempts}, elapsed: ${Math.floor(elapsedTime / 1000)}s): ${job.TranscriptionJobStatus}`);

            if (job.TranscriptionJobStatus === TRANSCRIBE_STATUS.COMPLETED) {
                console.log(`Transcription completed successfully after ${Math.floor(elapsedTime / 1000)} seconds`);
                return {
                    status: TRANSCRIBE_STATUS.COMPLETED,
                    detectedLanguage: job.LanguageCode,
                    outputLocation: job.Transcript?.TranscriptFileUri,
                    processingTimeSeconds: Math.floor(elapsedTime / 1000)
                };
            }

            if (job.TranscriptionJobStatus === TRANSCRIBE_STATUS.FAILED) {
                return {
                    status: TRANSCRIBE_STATUS.FAILED,
                    failureReason: job.FailureReason,
                    processingTimeSeconds: Math.floor(elapsedTime / 1000)
                };
            }

            // Job is still in progress, wait before next poll
            if (job.TranscriptionJobStatus === TRANSCRIBE_STATUS.IN_PROGRESS) {
                // Enhanced adaptive delay: increase delay for longer-running jobs to reduce API calls
                // and optimize for 4-hour video processing
                const adaptiveDelay = Math.min(
                    delayMs,
                    pollingConfig.maxDelayMs,
                    // Increase delay based on elapsed time to reduce API calls for long jobs
                    Math.max(delayMs, Math.floor(elapsedTime / 20))
                );
                
                console.log(`Waiting ${adaptiveDelay}ms before next poll (adaptive delay based on ${Math.floor(elapsedTime / 1000)}s elapsed)...`);
                await sleep(adaptiveDelay);
                
                // Exponential backoff with performance optimization
                delayMs = Math.min(delayMs * pollingConfig.backoffMultiplier, pollingConfig.maxDelayMs);
                attempt++;
            }

        } catch (err) {
            console.error(`Error polling transcription job (attempt ${attempt + 1}):`, err);
            
            // Enhanced throttling handling for long-running jobs
            if (err.name === 'ThrottlingException' || err.name === 'TooManyRequestsException') {
                const throttleDelay = Math.min(delayMs * 4, pollingConfig.maxDelayMs); // Increased multiplier
                console.log(`Throttling detected, using extended delay: ${throttleDelay}ms`);
                await sleep(throttleDelay);
            } else {
                await sleep(delayMs);
            }
            
            if (attempt >= pollingConfig.maxAttempts - 1) {
                throw new Error(`Failed to poll transcription job after ${pollingConfig.maxAttempts} attempts: ${err.message}`);
            }
            
            delayMs = Math.min(delayMs * pollingConfig.backoffMultiplier, pollingConfig.maxDelayMs);
            attempt++;
        }
    }

    const elapsedTime = Date.now() - startTime;
    throw new Error(`Transcription job polling exceeded maximum attempts (${pollingConfig.maxAttempts}) after ${Math.floor(elapsedTime / 1000)} seconds`);
}

/**
 * Sleep utility function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after the specified time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
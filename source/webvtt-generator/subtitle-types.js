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

/**
 * TypeScript-style interfaces for subtitle processing data models
 * These are implemented as JSDoc comments for runtime validation and documentation
 */

/**
 * @typedef {Object} SubtitleConfig
 * @property {boolean} enabled - Whether subtitle processing is enabled
 * @property {string} primaryLanguage - Primary language code or 'auto' for detection
 * @property {string[]} targetLanguages - Array of target language codes for translation
 * @property {string} [tempBucket] - Temporary storage bucket for subtitle files
 * @property {string} [tempPrefix] - Temporary storage prefix for subtitle files
 */

/**
 * @typedef {Object} TranscriptionConfig
 * @property {string} jobName - Unique transcription job name
 * @property {string} mediaUri - S3 URI of the video file
 * @property {string} outputBucket - S3 bucket for transcription output
 * @property {string} outputKey - S3 key prefix for transcription output
 * @property {string} languageCode - Language code for transcription ('auto' for detection)
 * @property {string[]} subtitleFormats - Array of subtitle formats (e.g., ['vtt'])
 * @property {number} outputStartIndex - Starting index for subtitle output
 */

/**
 * @typedef {Object} TextSegment
 * @property {number} startTime - Start time in milliseconds
 * @property {number} endTime - End time in milliseconds
 * @property {string} text - Text content of the segment
 * @property {number} [confidence] - Confidence score for the transcription (0-1)
 * @property {string} [speaker] - Speaker identification (if available)
 */

/**
 * @typedef {Object} TranslationTask
 * @property {string} sourceLanguage - Source language code
 * @property {string} targetLanguage - Target language code
 * @property {TextSegment[]} textSegments - Array of text segments to translate
 * @property {string} jobId - Unique job identifier
 * @property {Object} [metadata] - Additional metadata for the translation task
 */

/**
 * @typedef {Object} TranslationResult
 * @property {string} targetLanguage - Target language code
 * @property {TextSegment[]} translatedSegments - Array of translated text segments
 * @property {string} status - Translation status ('completed', 'failed', 'in_progress')
 * @property {string} [errorMessage] - Error message if translation failed
 * @property {number} processingTimeMs - Time taken for translation in milliseconds
 */

/**
 * @typedef {Object} WebVTTFile
 * @property {string} language - Language code for the WebVTT file
 * @property {string} filename - Generated filename for the WebVTT file
 * @property {string} s3Location - S3 location of the WebVTT file
 * @property {string} content - WebVTT formatted content
 * @property {number} size - File size in bytes
 * @property {string} checksum - File checksum for integrity verification
 * @property {string} [cloudFrontUrl] - CloudFront URL for the file
 */

/**
 * @typedef {Object} MediaConvertJobConfig
 * @property {string} jobTemplate - MediaConvert job template name
 * @property {string} role - IAM role ARN for MediaConvert
 * @property {MediaConvertSettings} settings - MediaConvert job settings
 * @property {Object} [userMetadata] - User metadata for the job
 * @property {Object} [tags] - Tags for the MediaConvert job
 */

/**
 * @typedef {Object} MediaConvertSettings
 * @property {MediaConvertInput[]} inputs - Array of input configurations
 * @property {MediaConvertOutputGroup[]} outputGroups - Array of output group configurations
 * @property {Object} [timecodeConfig] - Timecode configuration
 * @property {Object} [accelerationSettings] - Acceleration settings
 */

/**
 * @typedef {Object} MediaConvertInput
 * @property {string} fileInput - S3 URI of the input file
 * @property {Object} [audioSelectors] - Audio selector configuration
 * @property {Object} [videoSelector] - Video selector configuration
 * @property {string} [timecodeSource] - Timecode source configuration
 * @property {Object.<string, CaptionSelector>} [captionSelectors] - Caption selector configurations (keyed by selector name)
 */

/**
 * @typedef {Object} CaptionSelector
 * @property {CaptionSourceSettings} sourceSettings - Caption source settings
 */

/**
 * @typedef {Object} CaptionSourceSettings
 * @property {string} sourceType - Source type (e.g., 'WEBVTT', 'SCC', 'TTML')
 * @property {FileSourceSettings} [fileSourceSettings] - File source settings for file-based captions
 * @property {Object} [dvbSubSourceSettings] - DVB-Sub source settings
 * @property {Object} [embeddedSourceSettings] - Embedded source settings
 * @property {Object} [teletextSourceSettings] - Teletext source settings
 */

/**
 * @typedef {Object} FileSourceSettings
 * @property {string} sourceFile - S3 URI of the caption file
 * @property {number} [timeDelta] - Time delta in milliseconds
 * @property {string} [convert608To708] - Convert 608 captions to 708
 */

/**
 * @typedef {Object} MediaConvertOutputGroup
 * @property {string} name - Name of the output group
 * @property {MediaConvertOutputGroupSettings} outputGroupSettings - Output group settings
 * @property {MediaConvertOutput[]} outputs - Array of output configurations
 * @property {string} [customName] - Custom name for the output group
 */

/**
 * @typedef {Object} MediaConvertOutputGroupSettings
 * @property {string} type - Output group type (e.g., 'FILE_GROUP_SETTINGS')
 * @property {Object} [fileGroupSettings] - File group settings
 * @property {Object} [hlsGroupSettings] - HLS group settings
 * @property {Object} [dashIsoGroupSettings] - DASH ISO group settings
 * @property {Object} [cmafGroupSettings] - CMAF group settings
 * @property {Object} [msSmoothGroupSettings] - MS Smooth group settings
 */

/**
 * @typedef {Object} MediaConvertOutput
 * @property {string} nameModifier - Name modifier for the output
 * @property {Object} containerSettings - Container settings
 * @property {Object} [videoDescription] - Video description settings
 * @property {Object[]} [audioDescriptions] - Audio description settings
 * @property {CaptionDescription[]} [captionDescriptions] - Caption description settings
 */

/**
 * @typedef {Object} CaptionDescription
 * @property {string} captionSelectorName - Name of the caption selector
 * @property {string} languageCode - Language code for the captions
 * @property {string} languageDescription - Human-readable language description
 * @property {CaptionDestinationSettings} destinationSettings - Caption destination settings
 */

/**
 * @typedef {Object} CaptionDestinationSettings
 * @property {string} destinationType - Destination type (e.g., 'WEBVTT')
 * @property {Object} [webvttDestinationSettings] - WebVTT-specific settings
 * @property {Object} [sccDestinationSettings] - SCC-specific settings
 * @property {Object} [ttmlDestinationSettings] - TTML-specific settings
 */

/**
 * @typedef {Object} ProcessWorkflowInput
 * @property {string} guid - Unique identifier for the video processing job
 * @property {string} jobId - Job identifier
 * @property {string} srcVideo - Source video filename
 * @property {string} srcBucket - Source S3 bucket name
 * @property {string} destBucket - Destination S3 bucket name
 * @property {SubtitleConfig} [subtitleConfig] - Subtitle processing configuration
 * @property {string} [workflowName] - Name of the workflow
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * @typedef {Object} ProcessWorkflowOutput
 * @property {string} guid - Unique identifier for the video processing job
 * @property {string} jobId - Job identifier
 * @property {string} mediaConvertJobId - MediaConvert job identifier
 * @property {SubtitleProcessingResult} [subtitleProcessing] - Subtitle processing results
 * @property {string} [errorMessage] - Error message if processing failed
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * @typedef {Object} SubtitleProcessingResult
 * @property {string} status - Processing status
 * @property {Object.<string, string>} tempSubtitleFiles - Temporary subtitle file locations by language
 * @property {Object.<string, string>} finalSubtitleFiles - Final subtitle file locations by language
 * @property {string} [errorDetails] - Error details if processing failed
 * @property {string} [transcriptionJobId] - AWS Transcribe job identifier
 * @property {string} [detectedLanguage] - Detected primary language
 * @property {number} [processingTimeMs] - Total processing time in milliseconds
 */

/**
 * @typedef {Object} DynamoDBSubtitleFields
 * @property {boolean} subtitleProcessingEnabled - Whether subtitle processing is enabled
 * @property {string} subtitleProcessingStatus - Current processing status
 * @property {string} subtitlePrimaryLanguage - Primary language for transcription
 * @property {string[]} subtitleTargetLanguages - Target languages for translation
 * @property {string} [subtitleTranscriptionJobId] - AWS Transcribe job ID
 * @property {string} [subtitleTranscriptionStatus] - Transcription job status
 * @property {string} [subtitleDetectedLanguage] - Detected language from transcription
 * @property {Object.<string, string>} [subtitleTempFiles] - Temporary file locations
 * @property {Object.<string, string>} [subtitleFinalFiles] - Final file locations
 * @property {Object.<string, string>} [subtitleCloudFrontUrls] - CloudFront URLs
 * @property {string} [subtitleErrorDetails] - Error details if processing failed
 * @property {string} [subtitleProcessingStartTime] - Processing start timestamp
 * @property {string} [subtitleProcessingEndTime] - Processing end timestamp
 * @property {string} [subtitleProcessingLastUpdated] - Last update timestamp
 */

/**
 * @typedef {Object} SubtitleErrorReport
 * @property {string} errorType - Type of error from SUBTITLE_ERROR_TYPES
 * @property {string} errorMessage - Human-readable error message
 * @property {string} timestamp - ISO timestamp when error occurred
 * @property {string} severity - Error severity ('HIGH', 'MEDIUM', 'LOW')
 * @property {boolean} retryable - Whether the error is retryable
 * @property {boolean} userActionRequired - Whether user action is required
 * @property {Object} context - Additional context information
 * @property {string} context.guid - Video processing job GUID
 * @property {string} context.stage - Processing stage where error occurred
 */

/**
 * @typedef {Object} RetryConfig
 * @property {number} maxAttempts - Maximum number of retry attempts
 * @property {number} initialDelayMs - Initial delay in milliseconds
 * @property {number} backoffMultiplier - Backoff multiplier for exponential backoff
 * @property {number} maxDelayMs - Maximum delay in milliseconds
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * @typedef {Object} PerformanceConfig
 * @property {number} [batchSize] - Batch size for processing
 * @property {number} [batchDelay] - Delay between batches in milliseconds
 * @property {number} [maxConcurrent] - Maximum concurrent operations
 * @property {boolean} [useMemoryOptimization] - Whether to use memory optimization
 * @property {Object} [uploadStrategy] - S3 upload strategy configuration
 */

/**
 * Validation functions for the data models
 */

/**
 * Validates a SubtitleConfig object
 * @param {SubtitleConfig} config - Configuration to validate
 * @returns {boolean} True if valid
 */
function isValidSubtitleConfig(config) {
    return config &&
           typeof config === 'object' &&
           typeof config.enabled === 'boolean' &&
           typeof config.primaryLanguage === 'string' &&
           Array.isArray(config.targetLanguages) &&
           config.targetLanguages.every(lang => typeof lang === 'string');
}

/**
 * Validates a TextSegment object
 * @param {TextSegment} segment - Segment to validate
 * @returns {boolean} True if valid
 */
function isValidTextSegment(segment) {
    return segment &&
           typeof segment === 'object' &&
           typeof segment.startTime === 'number' &&
           typeof segment.endTime === 'number' &&
           typeof segment.text === 'string' &&
           segment.startTime >= 0 &&
           segment.endTime > segment.startTime;
}

/**
 * Validates a TranslationTask object
 * @param {TranslationTask} task - Task to validate
 * @returns {boolean} True if valid
 */
function isValidTranslationTask(task) {
    return task &&
           typeof task === 'object' &&
           typeof task.sourceLanguage === 'string' &&
           typeof task.targetLanguage === 'string' &&
           typeof task.jobId === 'string' &&
           Array.isArray(task.textSegments) &&
           task.textSegments.every(isValidTextSegment);
}

/**
 * Validates a WebVTTFile object
 * @param {WebVTTFile} file - File to validate
 * @returns {boolean} True if valid
 */
function isValidWebVTTFile(file) {
    return file &&
           typeof file === 'object' &&
           typeof file.language === 'string' &&
           typeof file.filename === 'string' &&
           typeof file.s3Location === 'string' &&
           typeof file.content === 'string' &&
           typeof file.size === 'number' &&
           typeof file.checksum === 'string';
}

/**
 * Creates a default SubtitleConfig object
 * @returns {SubtitleConfig} Default configuration
 */
function createDefaultSubtitleConfig() {
    return {
        enabled: false,
        primaryLanguage: 'auto',
        targetLanguages: ['en']
    };
}

/**
 * Creates a TextSegment object
 * @param {number} startTime - Start time in milliseconds
 * @param {number} endTime - End time in milliseconds
 * @param {string} text - Text content
 * @param {Object} [options] - Additional options
 * @returns {TextSegment} Text segment object
 */
function createTextSegment(startTime, endTime, text, options = {}) {
    const segment = {
        startTime,
        endTime,
        text
    };

    if (options.confidence !== undefined) {
        segment.confidence = options.confidence;
    }

    if (options.speaker !== undefined) {
        segment.speaker = options.speaker;
    }

    // Add any additional properties from options
    Object.keys(options).forEach(key => {
        if (key !== 'confidence' && key !== 'speaker') {
            segment[key] = options[key];
        }
    });

    return segment;
}

/**
 * Creates a TranslationTask object
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @param {TextSegment[]} textSegments - Text segments to translate
 * @param {string} jobId - Job identifier
 * @param {Object} [metadata] - Additional metadata
 * @returns {TranslationTask} Translation task object
 */
function createTranslationTask(sourceLanguage, targetLanguage, textSegments, taskId, metadata = {}) {
    return {
        sourceLanguage,
        targetLanguage,
        textSegments,
        taskId,
        metadata
    };
}

/**
 * Creates a WebVTTFile object
 * @param {string} language - Language code
 * @param {string} filename - Filename
 * @param {string} s3Location - S3 location
 * @param {string} content - WebVTT content
 * @param {Object} [options] - Additional options
 * @returns {WebVTTFile} WebVTT file object
 */
function createWebVTTFile(language, filename, s3Location, content, options = {}) {
    const file = {
        language,
        filename,
        s3Location,
        content,
        size: Buffer.byteLength(content, 'utf8'),
        checksum: require('crypto').createHash('md5').update(content).digest('hex')
    };

    if (options.cloudFrontUrl) {
        file.cloudFrontUrl = options.cloudFrontUrl;
    }

    return file;
}

module.exports = {
    // Validation functions
    isValidSubtitleConfig,
    isValidTextSegment,
    isValidTranslationTask,
    isValidWebVTTFile,
    
    // Factory functions
    createDefaultSubtitleConfig,
    createTextSegment,
    createTranslationTask,
    createWebVTTFile
};
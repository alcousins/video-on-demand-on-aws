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
 * Shared utilities for subtitle processing
 */

/**
 * Performance and timeout configurations for subtitle processing
 */
const PERFORMANCE_CONFIG = {
    // Transcription timeouts for different video lengths
    TRANSCRIPTION_TIMEOUTS: {
        // Base timeout for short videos (up to 30 minutes)
        BASE_TIMEOUT_MS: 15 * 60 * 1000, // 15 minutes
        // Additional timeout per hour of video content
        TIMEOUT_PER_HOUR_MS: 20 * 60 * 1000, // 20 minutes per hour
        // Maximum timeout for very long videos (4+ hours)
        MAX_TIMEOUT_MS: 120 * 60 * 1000, // 2 hours maximum
        // Minimum timeout regardless of video length
        MIN_TIMEOUT_MS: 5 * 60 * 1000 // 5 minutes minimum
    },
    
    // Translation batch processing configuration
    TRANSLATION_BATCH: {
        // Number of segments to process in parallel per language
        SEGMENTS_PER_BATCH: 25,
        // Delay between batches to avoid rate limiting
        BATCH_DELAY_MS: 200,
        // Maximum concurrent translation requests
        MAX_CONCURRENT_REQUESTS: 10,
        // Timeout for individual translation requests
        REQUEST_TIMEOUT_MS: 30 * 1000 // 30 seconds
    },
    
    // WebVTT generation optimization
    WEBVTT_GENERATION: {
        // Maximum segments to process before yielding control
        MAX_SEGMENTS_PER_YIELD: 100,
        // Memory threshold for large subtitle files (in bytes)
        MEMORY_THRESHOLD_BYTES: 50 * 1024 * 1024, // 50MB
        // Maximum file size for WebVTT files (in bytes)
        MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024 // 10MB
    },
    
    // S3 upload optimization
    S3_UPLOAD: {
        // Use multipart upload for files larger than this threshold
        MULTIPART_THRESHOLD_BYTES: 5 * 1024 * 1024, // 5MB
        // Part size for multipart uploads
        PART_SIZE_BYTES: 5 * 1024 * 1024, // 5MB
        // Maximum concurrent uploads
        MAX_CONCURRENT_UPLOADS: 5,
        // Retry configuration for S3 operations
        RETRY_CONFIG: {
            maxAttempts: 5,
            initialDelayMs: 1000,
            backoffMultiplier: 2,
            maxDelayMs: 30000
        }
    },
    
    // Lambda resource management
    LAMBDA_OPTIMIZATION: {
        // Memory allocation recommendations by function type
        MEMORY_ALLOCATIONS: {
            transcription: 1024, // MB - needs more memory for polling
            translationCoordinator: 512, // MB - lightweight coordination
            translationWorker: 1024, // MB - processing translation batches
            webvttGenerator: 1024, // MB - generating and validating WebVTT
            subtitleConfig: 256 // MB - simple configuration loading
        },
        // Timeout recommendations by function type
        TIMEOUT_SECONDS: {
            transcription: 900, // 15 minutes - for polling long transcription jobs
            translationCoordinator: 300, // 5 minutes - for processing large transcripts
            translationWorker: 600, // 10 minutes - for translating many segments
            webvttGenerator: 600, // 10 minutes - for generating large WebVTT files
            subtitleConfig: 60 // 1 minute - simple configuration
        }
    }
};

/**
 * Subtitle processing status constants
 */
const SUBTITLE_STATUS = {
    PENDING: 'pending',
    TRANSCRIBING: 'transcribing',
    TRANSLATING: 'translating',
    GENERATING: 'generating',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

/**
 * WebVTT generation status constants
 */
const WEBVTT_STATUS = {
    STARTING: 'STARTING',
    GENERATING: 'GENERATING',
    UPLOADING: 'UPLOADING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
};

/**
 * Supported video formats for transcription
 */
const SUPPORTED_VIDEO_FORMATS = [
    'mp4', 'mov', 'm4v', 'mpg', 'm2ts'
];

/**
 * Supported languages for translation
 * Based on AWS Translate supported languages
 */
const SUPPORTED_LANGUAGES = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'pt-BR': 'Brazilian Portuguese',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese (Simplified)',
    'ar': 'Arabic'
};

/**
 * Default subtitle processing configuration
 */
const DEFAULT_SUBTITLE_CONFIG = {
    enabled: false,
    primaryLanguage: 'auto',
    targetLanguages: ['en']
};

/**
 * Configuration override keys that can be set via metadata files
 */
const CONFIGURABLE_SUBTITLE_KEYS = [
    'subtitleEnabled',
    'subtitlePrimaryLanguage', 
    'subtitleTargetLanguages',
    'subtitleProcessingEnabled'
];

/**
 * Error notification types for subtitle processing
 */
const SUBTITLE_ERROR_TYPES = {
    CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
    TRANSCRIPTION_ERROR: 'TRANSCRIPTION_ERROR',
    TRANSLATION_ERROR: 'TRANSLATION_ERROR',
    WEBVTT_ERROR: 'WEBVTT_ERROR',
    STORAGE_ERROR: 'STORAGE_ERROR',
    TIMEOUT_ERROR: 'TIMEOUT_ERROR'
};

/**
 * Validates if a video format is supported for transcription
 * @param {string} filename - Video filename
 * @returns {boolean} True if format is supported
 */
function isVideoFormatSupported(filename) {
    if (!filename || typeof filename !== 'string') {
        return false;
    }
    
    const extension = filename.toLowerCase().split('.').pop();
    return SUPPORTED_VIDEO_FORMATS.includes(extension);
}

/**
 * Validates if a language code is supported for translation
 * @param {string} languageCode - Language code to validate
 * @returns {boolean} True if language is supported
 */
function isLanguageSupported(languageCode) {
    if (!languageCode || typeof languageCode !== 'string') {
        return false;
    }
    
    // Check for exact match first, then try lowercase for case-insensitive matching
    return Object.keys(SUPPORTED_LANGUAGES).includes(languageCode) || 
           Object.keys(SUPPORTED_LANGUAGES).includes(languageCode.toLowerCase());
}

/**
 * Generates a unique transcription job name
 * @param {string} guid - Video processing job GUID
 * @param {string} timestamp - Timestamp string
 * @returns {string} Unique job name
 */
function generateTranscriptionJobName(guid, timestamp) {
    if (!guid || !timestamp) {
        throw new Error('GUID and timestamp are required for job name generation');
    }
    
    // Remove any characters that aren't alphanumeric, hyphens, or underscores
    const cleanGuid = guid.replace(/[^a-zA-Z0-9-_]/g, '');
    const cleanTimestamp = timestamp.replace(/[^a-zA-Z0-9-_]/g, '');
    
    return `transcription-${cleanGuid}-${cleanTimestamp}`;
}

/**
 * Generates WebVTT filename for a specific language
 * @param {string} videoFilename - Original video filename
 * @param {string} languageCode - Language code
 * @returns {string} WebVTT filename
 */
function generateWebVTTFilename(videoFilename, languageCode) {
    if (!videoFilename || !languageCode) {
        throw new Error('Video filename and language code are required');
    }
    
    // Remove extension from video filename but preserve original characters for filename
    const baseName = videoFilename.replace(/\.[^/.]+$/, '');
    return `${baseName}.${languageCode.toLowerCase()}.vtt`;
}

/**
 * Validates subtitle processing configuration
 * @param {Object} config - Subtitle configuration object
 * @returns {Object} Validation result with isValid boolean and errors array
 */
function validateSubtitleConfig(config) {
    const errors = [];
    
    if (!config || typeof config !== 'object') {
        return { isValid: false, errors: ['Configuration must be an object'] };
    }
    
    // Validate enabled flag
    if (typeof config.enabled !== 'boolean') {
        errors.push('enabled must be a boolean');
    }
    
    // Validate primary language
    if (config.primaryLanguage && config.primaryLanguage !== 'auto') {
        if (!isLanguageSupported(config.primaryLanguage)) {
            errors.push(`Primary language '${config.primaryLanguage}' is not supported`);
        }
    }
    
    // Validate target languages
    if (config.targetLanguages) {
        if (!Array.isArray(config.targetLanguages)) {
            errors.push('targetLanguages must be an array');
        } else {
            const invalidLanguages = config.targetLanguages.filter(lang => !isLanguageSupported(lang));
            if (invalidLanguages.length > 0) {
                errors.push(`Unsupported target languages: ${invalidLanguages.join(', ')}`);
            }
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Builds subtitle configuration from environment variables and metadata overrides
 * @param {Object} metadataOverrides - Configuration overrides from metadata file
 * @returns {Object} Complete subtitle configuration
 */
function buildSubtitleConfig(metadataOverrides = {}) {
    // Start with environment-based defaults
    const config = {
        enabled: process.env.SUBTITLE_PROCESSING_ENABLED === 'true' || false,
        primaryLanguage: process.env.SUBTITLE_PRIMARY_LANGUAGE || 'auto',
        targetLanguages: process.env.SUBTITLE_TARGET_LANGUAGES ? 
            process.env.SUBTITLE_TARGET_LANGUAGES.split(',').map(lang => lang.trim()) : 
            ['en']
    };

    // Apply metadata overrides using the same pattern as existing workflow
    if (metadataOverrides.subtitleEnabled !== undefined) {
        config.enabled = Boolean(metadataOverrides.subtitleEnabled);
    }
    
    if (metadataOverrides.subtitleProcessingEnabled !== undefined) {
        config.enabled = Boolean(metadataOverrides.subtitleProcessingEnabled);
    }

    if (metadataOverrides.subtitlePrimaryLanguage) {
        config.primaryLanguage = metadataOverrides.subtitlePrimaryLanguage;
    }

    if (metadataOverrides.subtitleTargetLanguages) {
        if (Array.isArray(metadataOverrides.subtitleTargetLanguages)) {
            config.targetLanguages = metadataOverrides.subtitleTargetLanguages;
        } else if (typeof metadataOverrides.subtitleTargetLanguages === 'string') {
            config.targetLanguages = metadataOverrides.subtitleTargetLanguages
                .split(',')
                .map(lang => lang.trim())
                .filter(lang => lang.length > 0);
        }
    }

    return config;
}

/**
 * Validates and normalizes subtitle configuration with detailed error reporting
 * @param {Object} config - Raw subtitle configuration
 * @returns {Object} Normalized configuration with validation results
 */
function validateAndNormalizeSubtitleConfig(config) {
    const result = {
        config: { ...DEFAULT_SUBTITLE_CONFIG },
        isValid: true,
        errors: [],
        warnings: []
    };

    if (!config || typeof config !== 'object') {
        result.isValid = false;
        result.errors.push('Configuration must be an object');
        return result;
    }

    // Validate and normalize enabled flag
    if (config.enabled !== undefined) {
        if (typeof config.enabled === 'boolean') {
            result.config.enabled = config.enabled;
        } else if (typeof config.enabled === 'string') {
            const enabledStr = config.enabled.toLowerCase();
            if (enabledStr === 'true' || enabledStr === '1' || enabledStr === 'yes') {
                result.config.enabled = true;
            } else if (enabledStr === 'false' || enabledStr === '0' || enabledStr === 'no') {
                result.config.enabled = false;
            } else {
                result.errors.push(`Invalid enabled value: '${config.enabled}'. Must be boolean or 'true'/'false'`);
                result.isValid = false;
            }
        } else {
            result.errors.push(`Invalid enabled type: ${typeof config.enabled}. Must be boolean or string`);
            result.isValid = false;
        }
    }

    // Validate and normalize primary language
    if (config.primaryLanguage !== undefined) {
        if (typeof config.primaryLanguage === 'string') {
            const normalizedLang = config.primaryLanguage.toLowerCase().trim();
            if (normalizedLang === 'auto' || normalizedLang === 'detect') {
                result.config.primaryLanguage = 'auto';
            } else if (isLanguageSupported(normalizedLang)) {
                result.config.primaryLanguage = normalizedLang;
            } else {
                result.errors.push(`Unsupported primary language: '${config.primaryLanguage}'`);
                result.isValid = false;
            }
        } else {
            result.errors.push(`Invalid primaryLanguage type: ${typeof config.primaryLanguage}. Must be string`);
            result.isValid = false;
        }
    }

    // Validate and normalize target languages
    if (config.targetLanguages !== undefined) {
        if (Array.isArray(config.targetLanguages)) {
            const normalizedLanguages = [];
            const invalidLanguages = [];
            
            for (const lang of config.targetLanguages) {
                if (typeof lang === 'string') {
                    const normalizedLang = lang.toLowerCase().trim();
                    if (isLanguageSupported(normalizedLang)) {
                        if (!normalizedLanguages.includes(normalizedLang)) {
                            normalizedLanguages.push(normalizedLang);
                        }
                    } else {
                        invalidLanguages.push(lang);
                    }
                } else {
                    result.errors.push(`Invalid target language type: ${typeof lang}. All languages must be strings`);
                    result.isValid = false;
                }
            }

            if (invalidLanguages.length > 0) {
                result.errors.push(`Unsupported target languages: ${invalidLanguages.join(', ')}`);
                result.isValid = false;
            }

            if (normalizedLanguages.length === 0 && config.targetLanguages.length > 0) {
                result.warnings.push('No valid target languages found, using default: [en]');
                result.config.targetLanguages = ['en'];
            } else if (normalizedLanguages.length > 0) {
                result.config.targetLanguages = normalizedLanguages;
            }
        } else if (typeof config.targetLanguages === 'string') {
            // Handle comma-separated string
            const languages = config.targetLanguages
                .split(',')
                .map(lang => lang.trim().toLowerCase())
                .filter(lang => lang.length > 0);
            
            const validLanguages = [];
            const invalidLanguages = [];
            
            for (const lang of languages) {
                if (isLanguageSupported(lang)) {
                    if (!validLanguages.includes(lang)) {
                        validLanguages.push(lang);
                    }
                } else {
                    invalidLanguages.push(lang);
                }
            }

            if (invalidLanguages.length > 0) {
                result.errors.push(`Unsupported target languages: ${invalidLanguages.join(', ')}`);
                result.isValid = false;
            }

            if (validLanguages.length === 0) {
                result.warnings.push('No valid target languages found, using default: [en]');
                result.config.targetLanguages = ['en'];
            } else {
                result.config.targetLanguages = validLanguages;
            }
        } else {
            result.errors.push(`Invalid targetLanguages type: ${typeof config.targetLanguages}. Must be array or string`);
            result.isValid = false;
        }
    }

    return result;
}

/**
 * Formats time in milliseconds to WebVTT timestamp format (HH:MM:SS.mmm)
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} WebVTT formatted timestamp
 */
function formatWebVTTTimestamp(milliseconds) {
    if (typeof milliseconds !== 'number' || milliseconds < 0) {
        throw new Error('Milliseconds must be a non-negative number');
    }
    
    const totalSeconds = Math.floor(milliseconds / 1000);
    const ms = milliseconds % 1000;
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * Creates a basic WebVTT header
 * @param {string} languageCode - Language code for the WebVTT file
 * @returns {string} WebVTT header
 */
function createWebVTTHeader(languageCode) {
    if (!languageCode) {
        throw new Error('Language code is required for WebVTT header');
    }
    
    const languageName = SUPPORTED_LANGUAGES[languageCode] || languageCode;
    return `WEBVTT\nKind: subtitles\nLanguage: ${languageCode}\n\nNOTE\nGenerated by Video on Demand on AWS - ${languageName} subtitles\n\n`;
}

/**
 * Generates CloudFront URL for a subtitle file
 * @param {string} cloudFrontDomain - CloudFront distribution domain
 * @param {string} s3Key - S3 key for the subtitle file
 * @returns {string} CloudFront URL
 */
function generateCloudFrontUrl(cloudFrontDomain, s3Key) {
    if (!cloudFrontDomain || !s3Key) {
        throw new Error('CloudFront domain and S3 key are required');
    }
    
    // Ensure domain doesn't have protocol prefix
    const domain = cloudFrontDomain.replace(/^https?:\/\//, '');
    
    // Ensure S3 key doesn't start with slash
    const key = s3Key.startsWith('/') ? s3Key.substring(1) : s3Key;
    
    // URL encode the key to handle spaces and special characters
    const encodedKey = encodeURIComponent(key).replace(/%2F/g, '/'); // Keep forward slashes unencoded
    
    return `https://${domain}/${encodedKey}`;
}

/**
 * Generates S3 key for subtitle file following the same pattern as video files
 * @param {string} guid - Video processing job GUID
 * @param {string} filename - Subtitle filename
 * @returns {string} S3 key
 */
function generateSubtitleS3Key(guid, filename) {
    if (!guid || !filename) {
        throw new Error('GUID and filename are required for S3 key generation');
    }
    
    // Sanitize filename for S3 - replace problematic characters with underscores
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Follow the same directory structure as video files: {guid}/subtitles/{filename}
    return `${guid}/subtitles/${sanitizedFilename}`;
}

/**
 * Creates a DynamoDB update expression for subtitle processing status
 * @param {string} status - Overall subtitle processing status
 * @param {Object} additionalFields - Additional fields to update
 * @returns {Object} DynamoDB update parameters
 */
function createSubtitleStatusUpdate(status, additionalFields = {}) {
    const updateExpression = ['SET subtitleProcessingStatus = :status'];
    const expressionAttributeNames = {};
    const expressionAttributeValues = { ':status': status };

    // Add timestamp
    updateExpression.push('subtitleProcessingLastUpdated = :timestamp');
    expressionAttributeValues[':timestamp'] = new Date().toISOString();

    // Add processing start time if status is starting
    if (status === SUBTITLE_STATUS.PENDING || status === SUBTITLE_STATUS.TRANSCRIBING) {
        updateExpression.push('subtitleProcessingStartTime = :startTime');
        expressionAttributeValues[':startTime'] = new Date().toISOString();
    }

    // Add processing end time if status is completed or failed
    if (status === SUBTITLE_STATUS.COMPLETED || status === SUBTITLE_STATUS.FAILED) {
        updateExpression.push('subtitleProcessingEndTime = :endTime');
        expressionAttributeValues[':endTime'] = new Date().toISOString();
    }

    // Add additional fields with subtitle prefix
    Object.keys(additionalFields).forEach((key, index) => {
        const attributeName = `#field${index}`;
        const valueName = `:value${index}`;
        const fieldName = `subtitle${key.charAt(0).toUpperCase() + key.slice(1)}`;
        
        updateExpression.push(`${attributeName} = ${valueName}`);
        expressionAttributeNames[attributeName] = fieldName;
        expressionAttributeValues[valueName] = additionalFields[key];
    });

    const result = {
        UpdateExpression: updateExpression.join(', '),
        ExpressionAttributeValues: expressionAttributeValues
    };

    // Only include ExpressionAttributeNames if we have any
    if (Object.keys(expressionAttributeNames).length > 0) {
        result.ExpressionAttributeNames = expressionAttributeNames;
    }

    return result;
}

/**
 * Creates a DynamoDB update expression for transcription status
 * @param {string} status - Transcription status
 * @param {Object} transcriptionData - Transcription job data
 * @returns {Object} DynamoDB update parameters
 */
function createTranscriptionStatusUpdate(status, transcriptionData = {}) {
    const additionalFields = {
        transcriptionStatus: status,
        ...transcriptionData
    };

    // Determine overall subtitle processing status based on transcription status
    let overallStatus = SUBTITLE_STATUS.TRANSCRIBING;
    if (status === 'COMPLETED') {
        overallStatus = SUBTITLE_STATUS.COMPLETED;
    } else if (status === 'FAILED' || status === 'failed') {
        overallStatus = SUBTITLE_STATUS.FAILED;
    }

    return createSubtitleStatusUpdate(overallStatus, additionalFields);
}

/**
 * Creates a DynamoDB update expression for translation status
 * @param {string} status - Translation status
 * @param {Object} translationData - Translation job data
 * @returns {Object} DynamoDB update parameters
 */
function createTranslationStatusUpdate(status, translationData = {}) {
    const additionalFields = {
        translationStatus: status,
        ...translationData
    };

    return createSubtitleStatusUpdate(SUBTITLE_STATUS.TRANSLATING, additionalFields);
}

/**
 * Creates a DynamoDB update expression for WebVTT generation status
 * @param {string} status - WebVTT generation status
 * @param {Array} uploadedFiles - Array of uploaded file information
 * @param {string} errorDetails - Error details if failed
 * @returns {Object} DynamoDB update parameters
 */
function createWebVTTStatusUpdate(status, uploadedFiles = null, errorDetails = null) {
    const additionalFields = {
        webvttStatus: status,
        webvttTimestamp: new Date().toISOString()
    };

    // Add file information if provided
    if (uploadedFiles && Array.isArray(uploadedFiles)) {
        const subtitleFiles = {};
        const cloudFrontUrls = {};
        
        uploadedFiles.forEach(file => {
            subtitleFiles[file.language] = file.s3Location;
            if (file.cloudFrontUrl) {
                cloudFrontUrls[file.language] = file.cloudFrontUrl;
            }
        });

        additionalFields.subtitleFiles = subtitleFiles;
        if (Object.keys(cloudFrontUrls).length > 0) {
            additionalFields.cloudFrontUrls = cloudFrontUrls;
        }
        additionalFields.fileCount = uploadedFiles.length;
        additionalFields.languages = uploadedFiles.map(file => file.language);
    }

    // Add error details if provided
    if (errorDetails) {
        additionalFields.webvttError = errorDetails;
    }

    // Determine overall status
    let overallStatus = SUBTITLE_STATUS.GENERATING;
    if (status === WEBVTT_STATUS.COMPLETED) {
        overallStatus = SUBTITLE_STATUS.COMPLETED;
    } else if (status === WEBVTT_STATUS.FAILED) {
        overallStatus = SUBTITLE_STATUS.FAILED;
    }

    return createSubtitleStatusUpdate(overallStatus, additionalFields);
}

/**
 * Creates a comprehensive error report for subtitle processing failures
 * @param {string} errorType - Type of error from SUBTITLE_ERROR_TYPES
 * @param {string} errorMessage - Human-readable error message
 * @param {Object} context - Additional context information
 * @returns {Object} Structured error report
 */
function createSubtitleErrorReport(errorType, errorMessage, context = {}) {
    const errorReport = {
        errorType,
        errorMessage,
        timestamp: new Date().toISOString(),
        context: {
            guid: context.guid || 'unknown',
            stage: context.stage || 'unknown',
            ...context
        }
    };

    // Add specific error details based on type
    switch (errorType) {
        case SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR:
            errorReport.severity = 'HIGH';
            errorReport.retryable = false;
            errorReport.userActionRequired = true;
            break;
        case SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR:
            errorReport.severity = 'MEDIUM';
            errorReport.retryable = true;
            errorReport.userActionRequired = false;
            break;
        case SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR:
            errorReport.severity = 'MEDIUM';
            errorReport.retryable = true;
            errorReport.userActionRequired = false;
            break;
        case SUBTITLE_ERROR_TYPES.WEBVTT_ERROR:
            errorReport.severity = 'LOW';
            errorReport.retryable = true;
            errorReport.userActionRequired = false;
            break;
        case SUBTITLE_ERROR_TYPES.STORAGE_ERROR:
            errorReport.severity = 'MEDIUM';
            errorReport.retryable = true;
            errorReport.userActionRequired = false;
            break;
        case SUBTITLE_ERROR_TYPES.TIMEOUT_ERROR:
            errorReport.severity = 'MEDIUM';
            errorReport.retryable = true;
            errorReport.userActionRequired = false;
            break;
        default:
            errorReport.severity = 'MEDIUM';
            errorReport.retryable = false;
            errorReport.userActionRequired = false;
    }

    return errorReport;
}

/**
 * Logs structured error information for subtitle processing
 * @param {Object} errorReport - Error report from createSubtitleErrorReport
 * @param {Object} logger - Logger instance (defaults to console)
 */
function logSubtitleError(errorReport, logger = console) {
    const logLevel = errorReport.severity === 'HIGH' ? 'error' : 
                    errorReport.severity === 'MEDIUM' ? 'warn' : 'info';
    
    const logMessage = `[SUBTITLE_ERROR] ${errorReport.errorType}: ${errorReport.errorMessage}`;
    const logDetails = {
        guid: errorReport.context.guid,
        stage: errorReport.context.stage,
        timestamp: errorReport.timestamp,
        retryable: errorReport.retryable,
        userActionRequired: errorReport.userActionRequired,
        context: errorReport.context
    };

    logger[logLevel](logMessage, logDetails);
}

/**
 * Determines if an error should trigger workflow failure or just subtitle processing failure
 * @param {string} errorType - Type of error from SUBTITLE_ERROR_TYPES
 * @param {Object} context - Error context
 * @returns {boolean} True if error should fail the entire workflow
 */
function shouldFailWorkflow(errorType, context = {}) {
    // Only configuration errors that prevent the workflow from continuing should fail the workflow
    if (errorType === SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR) {
        // Check if it's a critical configuration error
        const criticalErrors = [
            'missing required parameters',
            'invalid workflow configuration',
            'permission denied'
        ];
        
        const errorMessage = (context.errorMessage || '').toLowerCase();
        return criticalErrors.some(critical => errorMessage.includes(critical));
    }

    // All other errors should not fail the main workflow
    return false;
}

/**
 * Creates retry configuration based on error type
 * @param {string} errorType - Type of error from SUBTITLE_ERROR_TYPES
 * @returns {Object} Retry configuration with attempts, delay, and backoff
 */
function getRetryConfig(errorType) {
    const baseConfig = {
        maxAttempts: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 30000
    };

    switch (errorType) {
        case SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR:
            return {
                ...baseConfig,
                maxAttempts: 2, // Transcription jobs are expensive
                initialDelayMs: 5000,
                maxDelayMs: 60000
            };
        case SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR:
            return {
                ...baseConfig,
                maxAttempts: 3,
                initialDelayMs: 2000
            };
        case SUBTITLE_ERROR_TYPES.STORAGE_ERROR:
            return {
                ...baseConfig,
                maxAttempts: 5, // Storage errors are often transient
                initialDelayMs: 500
            };
        case SUBTITLE_ERROR_TYPES.TIMEOUT_ERROR:
            return {
                ...baseConfig,
                maxAttempts: 1, // Don't retry timeouts
                initialDelayMs: 0
            };
        case SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR:
            return {
                ...baseConfig,
                maxAttempts: 0, // Don't retry configuration errors
                initialDelayMs: 0
            };
        default:
            return baseConfig;
    }
}

/**
 * Calculates appropriate timeout for transcription based on estimated video duration
 * @param {number} estimatedDurationMinutes - Estimated video duration in minutes
 * @returns {number} Timeout in milliseconds
 */
function calculateTranscriptionTimeout(estimatedDurationMinutes = 60) {
    const config = PERFORMANCE_CONFIG.TRANSCRIPTION_TIMEOUTS;
    
    // Convert minutes to hours for calculation
    const durationHours = estimatedDurationMinutes / 60;
    
    // Calculate timeout: base + (hours * per-hour timeout)
    const calculatedTimeout = config.BASE_TIMEOUT_MS + (durationHours * config.TIMEOUT_PER_HOUR_MS);
    
    // Apply min/max constraints
    return Math.max(
        config.MIN_TIMEOUT_MS,
        Math.min(calculatedTimeout, config.MAX_TIMEOUT_MS)
    );
}

/**
 * Optimizes translation batch size based on content characteristics
 * @param {number} totalSegments - Total number of text segments
 * @param {number} averageSegmentLength - Average length of text segments
 * @returns {Object} Optimized batch configuration
 */
function optimizeTranslationBatching(totalSegments, averageSegmentLength = 50) {
    const config = PERFORMANCE_CONFIG.TRANSLATION_BATCH;
    
    // Adjust batch size based on segment characteristics
    let batchSize = config.SEGMENTS_PER_BATCH;
    
    // Reduce batch size for very long segments to avoid API limits
    if (averageSegmentLength > 200) {
        batchSize = Math.max(5, Math.floor(batchSize * 0.5));
    } else if (averageSegmentLength > 100) {
        batchSize = Math.max(10, Math.floor(batchSize * 0.75));
    }
    
    // Increase batch size for very short segments
    if (averageSegmentLength < 20) {
        batchSize = Math.min(50, Math.floor(batchSize * 1.5));
    }
    
    // Calculate optimal delay based on total workload
    let batchDelay = config.BATCH_DELAY_MS;
    const totalBatches = Math.ceil(totalSegments / batchSize);
    
    // Reduce delay for small workloads, increase for large ones
    if (totalBatches < 5) {
        batchDelay = Math.max(50, Math.floor(batchDelay * 0.5));
    } else if (totalBatches > 20) {
        batchDelay = Math.min(1000, Math.floor(batchDelay * 1.5));
    }
    
    return {
        batchSize,
        batchDelay,
        totalBatches,
        maxConcurrent: Math.min(config.MAX_CONCURRENT_REQUESTS, totalBatches)
    };
}

/**
 * Checks if WebVTT generation should use memory-optimized processing
 * @param {number} segmentCount - Number of text segments
 * @param {number} averageSegmentLength - Average segment length
 * @returns {boolean} True if memory optimization is needed
 */
function shouldUseMemoryOptimization(segmentCount, averageSegmentLength = 50) {
    const config = PERFORMANCE_CONFIG.WEBVTT_GENERATION;
    
    // Estimate memory usage: segments * average length * 2 (for processing overhead)
    const estimatedMemoryBytes = segmentCount * averageSegmentLength * 2;
    
    return estimatedMemoryBytes > config.MEMORY_THRESHOLD_BYTES || 
           segmentCount > config.MAX_SEGMENTS_PER_YIELD;
}

/**
 * Determines optimal S3 upload strategy based on file characteristics
 * @param {number} fileSizeBytes - Size of file to upload
 * @param {number} fileCount - Number of files to upload
 * @returns {Object} Upload strategy configuration
 */
function getOptimalUploadStrategy(fileSizeBytes, fileCount = 1) {
    const config = PERFORMANCE_CONFIG.S3_UPLOAD;
    
    const strategy = {
        useMultipart: fileSizeBytes > config.MULTIPART_THRESHOLD_BYTES,
        partSize: config.PART_SIZE_BYTES,
        maxConcurrent: Math.min(config.MAX_CONCURRENT_UPLOADS, fileCount),
        retryConfig: config.RETRY_CONFIG
    };
    
    // Adjust concurrency based on total workload
    if (fileCount > 10) {
        strategy.maxConcurrent = Math.min(3, strategy.maxConcurrent);
    }
    
    // Adjust part size for very large files
    if (fileSizeBytes > 100 * 1024 * 1024) { // 100MB
        strategy.partSize = 10 * 1024 * 1024; // 10MB parts
    }
    
    return strategy;
}

/**
 * Estimates video duration from file size and format (rough approximation)
 * @param {number} fileSizeBytes - Video file size in bytes
 * @param {string} format - Video format/extension
 * @returns {number} Estimated duration in minutes
 */
function estimateVideoDuration(fileSizeBytes, format = 'mp4') {
    // Rough bitrate estimates by format (bits per second)
    const bitrateEstimates = {
        'mp4': 2000000,    // 2 Mbps average
        'mov': 5000000,    // 5 Mbps average (often higher quality)
        'm4v': 2000000,    // 2 Mbps average
        'mpg': 1500000,    // 1.5 Mbps average (older format)
        'm2ts': 8000000    // 8 Mbps average (broadcast quality)
    };
    
    const estimatedBitrate = bitrateEstimates[format.toLowerCase()] || bitrateEstimates['mp4'];
    
    // Convert file size to bits and calculate duration
    const fileSizeBits = fileSizeBytes * 8;
    const durationSeconds = fileSizeBits / estimatedBitrate;
    const durationMinutes = durationSeconds / 60;
    
    // Apply reasonable bounds (1 minute to 4 hours)
    return Math.max(1, Math.min(240, durationMinutes));
}

/**
 * Creates performance-optimized retry configuration
 * @param {string} operationType - Type of operation (transcription, translation, etc.)
 * @param {Object} context - Additional context for optimization
 * @returns {Object} Optimized retry configuration
 */
function createOptimizedRetryConfig(operationType, context = {}) {
    const baseConfig = getRetryConfig(SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR);
    
    switch (operationType) {
        case 'transcription':
            return {
                ...baseConfig,
                maxAttempts: 2, // Expensive operations
                initialDelayMs: 10000, // 10 seconds
                backoffMultiplier: 1.5, // Gentler backoff
                maxDelayMs: 120000, // 2 minutes max
                timeoutMs: calculateTranscriptionTimeout(context.estimatedDurationMinutes)
            };
            
        case 'translation':
            const batchConfig = optimizeTranslationBatching(
                context.segmentCount || 10,
                context.averageSegmentLength || 50
            );
            return {
                ...baseConfig,
                maxAttempts: 3,
                initialDelayMs: batchConfig.batchDelay,
                backoffMultiplier: 2,
                maxDelayMs: 30000,
                batchSize: batchConfig.batchSize,
                maxConcurrent: batchConfig.maxConcurrent
            };
            
        case 'webvtt':
            return {
                ...baseConfig,
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                maxDelayMs: 15000,
                useMemoryOptimization: shouldUseMemoryOptimization(
                    context.segmentCount || 100,
                    context.averageSegmentLength || 50
                )
            };
            
        case 's3Upload':
            const uploadStrategy = getOptimalUploadStrategy(
                context.fileSizeBytes || 1024 * 1024,
                context.fileCount || 1
            );
            return {
                ...uploadStrategy.retryConfig,
                uploadStrategy
            };
            
        default:
            return baseConfig;
    }
}

module.exports = {
    SUPPORTED_VIDEO_FORMATS,
    SUPPORTED_LANGUAGES,
    DEFAULT_SUBTITLE_CONFIG,
    CONFIGURABLE_SUBTITLE_KEYS,
    SUBTITLE_STATUS,
    WEBVTT_STATUS,
    SUBTITLE_ERROR_TYPES,
    PERFORMANCE_CONFIG,
    isVideoFormatSupported,
    isLanguageSupported,
    generateTranscriptionJobName,
    generateWebVTTFilename,
    validateSubtitleConfig,
    buildSubtitleConfig,
    validateAndNormalizeSubtitleConfig,
    formatWebVTTTimestamp,
    createWebVTTHeader,
    generateCloudFrontUrl,
    generateSubtitleS3Key,
    createSubtitleStatusUpdate,
    createTranscriptionStatusUpdate,
    createTranslationStatusUpdate,
    createWebVTTStatusUpdate,
    createSubtitleErrorReport,
    logSubtitleError,
    shouldFailWorkflow,
    getRetryConfig,
    calculateTranscriptionTimeout,
    optimizeTranslationBatching,
    shouldUseMemoryOptimization,
    getOptimalUploadStrategy,
    estimateVideoDuration,
    createOptimizedRetryConfig
};
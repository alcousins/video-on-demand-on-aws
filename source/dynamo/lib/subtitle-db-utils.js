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
 * DynamoDB utilities for subtitle processing status tracking and schema extensions
 * This module provides comprehensive database operations for the subtitle processing pipeline
 */

const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

/**
 * Subtitle processing field names in DynamoDB
 * These follow the design document schema extensions
 */
const SUBTITLE_DB_FIELDS = {
    // Main processing status and control
    PROCESSING_STATUS: 'subtitleProcessingStatus',
    PROCESSING_ENABLED: 'subtitleProcessingEnabled',
    PROCESSING_START_TIME: 'subtitleProcessingStartTime',
    PROCESSING_END_TIME: 'subtitleProcessingEndTime',
    PROCESSING_LAST_UPDATED: 'subtitleProcessingLastUpdated',
    
    // Configuration fields
    PRIMARY_LANGUAGE: 'subtitlePrimaryLanguage',
    TARGET_LANGUAGES: 'subtitleTargetLanguages',
    CONFIG: 'subtitleConfig',
    
    // Transcription fields
    TRANSCRIPTION_JOB_ID: 'subtitleTranscriptionJobId',
    TRANSCRIPTION_STATUS: 'subtitleTranscriptionStatus',
    DETECTED_LANGUAGE: 'subtitleDetectedLanguage',
    TRANSCRIPTION_OUTPUT_LOCATION: 'subtitleTranscriptionOutputLocation',
    
    // Translation fields
    TRANSLATION_STATUS: 'subtitleTranslationStatus',
    TRANSLATION_TASKS: 'subtitleTranslationTasks',
    TRANSLATION_RESULTS: 'subtitleTranslationResults',
    TRANSLATION_LANGUAGES_COMPLETED: 'subtitleTranslationLanguagesCompleted',
    TRANSLATION_LANGUAGES_FAILED: 'subtitleTranslationLanguagesFailed',
    
    // WebVTT generation fields
    WEBVTT_STATUS: 'subtitleWebvttStatus',
    WEBVTT_FILES_GENERATED: 'subtitleWebvttFilesGenerated',
    WEBVTT_GENERATION_TIMESTAMP: 'subtitleWebvttGenerationTimestamp',
    
    // File storage fields
    TEMP_SUBTITLE_FILES: 'subtitleTempFiles',
    FINAL_SUBTITLE_FILES: 'subtitleFinalFiles',
    VTT_FILES: 'subtitleVttFiles', // New simplified field for .vtt file S3 URLs
    CLOUDFRONT_URLS: 'subtitleCloudFrontUrls',
    FILE_COUNT: 'subtitleFileCount',
    SUPPORTED_LANGUAGES: 'subtitleSupportedLanguages',
    
    // Error handling and monitoring
    ERROR_DETAILS: 'subtitleErrorDetails',
    ERROR_COUNT: 'subtitleErrorCount',
    LAST_ERROR_TIMESTAMP: 'subtitleLastErrorTimestamp',
    CORRELATION_ID: 'subtitleCorrelationId',
    
    // Performance and monitoring
    PROCESSING_DURATION_SECONDS: 'subtitleProcessingDurationSeconds',
    TRANSCRIPTION_DURATION_SECONDS: 'subtitleTranscriptionDurationSeconds',
    TRANSLATION_DURATION_SECONDS: 'subtitleTranslationDurationSeconds',
    WEBVTT_GENERATION_DURATION_SECONDS: 'subtitleWebvttGenerationDurationSeconds'
};

/**
 * Creates a comprehensive DynamoDB update expression for subtitle processing status
 * @param {string} guid - Video processing job GUID
 * @param {string} status - Overall subtitle processing status
 * @param {Object} options - Update options
 * @param {string} options.errorDetails - Error details if status is failed
 * @param {Object} options.additionalFields - Additional fields to update
 * @param {boolean} options.setTimestamps - Whether to set start/end timestamps (default: true)
 * @returns {Object} DynamoDB update parameters
 */
function createSubtitleProcessingUpdate(guid, status, options = {}) {
    const {
        errorDetails = null,
        additionalFields = {},
        setTimestamps = true
    } = options;

    const updateExpression = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    // Set main processing status
    updateExpression.push(`${SUBTITLE_DB_FIELDS.PROCESSING_STATUS} = :status`);
    expressionAttributeValues[':status'] = status;

    // Always update last updated timestamp
    if (setTimestamps) {
        updateExpression.push(`${SUBTITLE_DB_FIELDS.PROCESSING_LAST_UPDATED} = :lastUpdated`);
        expressionAttributeValues[':lastUpdated'] = new Date().toISOString();

        // Set start time for initial statuses
        if (status === 'pending' || status === 'transcribing') {
            updateExpression.push(`${SUBTITLE_DB_FIELDS.PROCESSING_START_TIME} = :startTime`);
            expressionAttributeValues[':startTime'] = new Date().toISOString();
        }

        // Set end time for final statuses
        if (status === 'completed' || status === 'failed') {
            updateExpression.push(`${SUBTITLE_DB_FIELDS.PROCESSING_END_TIME} = :endTime`);
            expressionAttributeValues[':endTime'] = new Date().toISOString();
        }
    }

    // Add error details if provided
    if (errorDetails) {
        updateExpression.push(`${SUBTITLE_DB_FIELDS.ERROR_DETAILS} = :errorDetails`);
        expressionAttributeValues[':errorDetails'] = errorDetails;
        
        updateExpression.push(`${SUBTITLE_DB_FIELDS.LAST_ERROR_TIMESTAMP} = :errorTimestamp`);
        expressionAttributeValues[':errorTimestamp'] = new Date().toISOString();
        
        // Increment error count
        updateExpression.push(`${SUBTITLE_DB_FIELDS.ERROR_COUNT} = if_not_exists(${SUBTITLE_DB_FIELDS.ERROR_COUNT}, :zero) + :one`);
        expressionAttributeValues[':zero'] = 0;
        expressionAttributeValues[':one'] = 1;
    }

    // Add additional fields
    Object.keys(additionalFields).forEach((key, index) => {
        const valueName = `:additionalValue${index}`;
        let fieldName = key;
        
        // Auto-prefix with subtitle if not already prefixed
        if (!key.startsWith('subtitle')) {
            fieldName = `subtitle${key.charAt(0).toUpperCase() + key.slice(1)}`;
        }
        
        updateExpression.push(`${fieldName} = ${valueName}`);
        expressionAttributeValues[valueName] = additionalFields[key];
    });

    const params = {
        TableName: process.env.DynamoDBTable,
        Key: { guid },
        UpdateExpression: 'SET ' + updateExpression.join(', '),
        ExpressionAttributeValues: expressionAttributeValues
    };

    // Only include ExpressionAttributeNames if we have any
    if (Object.keys(expressionAttributeNames).length > 0) {
        params.ExpressionAttributeNames = expressionAttributeNames;
    }

    return params;
}

/**
 * Updates transcription status and related fields in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} transcriptionStatus - Transcription job status
 * @param {Object} transcriptionData - Additional transcription data
 * @returns {Promise<void>}
 */
async function updateTranscriptionStatus(docClient, guid, transcriptionStatus, transcriptionData = {}) {
    const additionalFields = {
        [SUBTITLE_DB_FIELDS.TRANSCRIPTION_STATUS]: transcriptionStatus,
        ...transcriptionData
    };

    // Determine overall processing status based on transcription status
    let overallStatus = 'transcribing';
    if (transcriptionStatus === 'COMPLETED') {
        overallStatus = 'completed';
    } else if (transcriptionStatus === 'FAILED') {
        overallStatus = 'failed';
    }

    const params = createSubtitleProcessingUpdate(guid, overallStatus, {
        additionalFields,
        errorDetails: transcriptionData.failureReason || null
    });

    await docClient.send(new UpdateCommand(params));
    console.log(`Updated transcription status for ${guid}: ${transcriptionStatus}`);
}

/**
 * Updates translation status and progress in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} translationStatus - Translation status
 * @param {Object} translationData - Translation progress data
 * @returns {Promise<void>}
 */
async function updateTranslationStatus(docClient, guid, translationStatus, translationData = {}) {
    const additionalFields = {
        [SUBTITLE_DB_FIELDS.TRANSLATION_STATUS]: translationStatus,
        ...translationData
    };

    // Always set overall status to translating unless explicitly failed
    const overallStatus = translationStatus === 'FAILED' ? 'failed' : 'translating';

    const params = createSubtitleProcessingUpdate(guid, overallStatus, {
        additionalFields,
        errorDetails: translationData.errorDetails || null
    });

    await docClient.send(new UpdateCommand(params));
    console.log(`Updated translation status for ${guid}: ${translationStatus}`);
}

/**
 * Updates WebVTT generation status and file information in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} webvttStatus - WebVTT generation status
 * @param {Array} uploadedFiles - Array of uploaded file information
 * @param {string} errorDetails - Error details if failed
 * @returns {Promise<void>}
 */
async function updateWebVTTStatus(docClient, guid, webvttStatus, uploadedFiles = null, errorDetails = null) {
    const additionalFields = {
        [SUBTITLE_DB_FIELDS.WEBVTT_STATUS]: webvttStatus,
        [SUBTITLE_DB_FIELDS.WEBVTT_GENERATION_TIMESTAMP]: new Date().toISOString()
    };

    // Process uploaded files information
    if (uploadedFiles && Array.isArray(uploadedFiles)) {
        const finalFiles = {};
        const cloudFrontUrls = {};
        const supportedLanguages = [];

        uploadedFiles.forEach(file => {
            if (file.language) {
                supportedLanguages.push(file.language);
                
                // For WebVTT generator, files are uploaded directly to final location
                if (file.s3Location) {
                    finalFiles[file.language] = file.s3Location;
                }
                
                if (file.cloudFrontUrl) {
                    cloudFrontUrls[file.language] = file.cloudFrontUrl;
                }
            }
        });

        // Only set temp files if they exist (for backward compatibility)
        if (uploadedFiles.some(file => file.tempS3Location)) {
            const tempFiles = {};
            uploadedFiles.forEach(file => {
                if (file.language && file.tempS3Location) {
                    tempFiles[file.language] = file.tempS3Location;
                }
            });
            additionalFields[SUBTITLE_DB_FIELDS.TEMP_SUBTITLE_FILES] = tempFiles;
        }

        additionalFields[SUBTITLE_DB_FIELDS.FINAL_SUBTITLE_FILES] = finalFiles;
        additionalFields[SUBTITLE_DB_FIELDS.CLOUDFRONT_URLS] = cloudFrontUrls;
        additionalFields[SUBTITLE_DB_FIELDS.FILE_COUNT] = uploadedFiles.length;
        additionalFields[SUBTITLE_DB_FIELDS.SUPPORTED_LANGUAGES] = supportedLanguages;
        additionalFields[SUBTITLE_DB_FIELDS.WEBVTT_FILES_GENERATED] = uploadedFiles.length;
    }

    // Determine overall processing status
    let overallStatus = 'generating';
    if (webvttStatus === 'COMPLETED') {
        overallStatus = 'completed';
    } else if (webvttStatus === 'FAILED') {
        overallStatus = 'failed';
    }

    const params = createSubtitleProcessingUpdate(guid, overallStatus, {
        additionalFields,
        errorDetails
    });

    await docClient.send(new UpdateCommand(params));
    console.log(`Updated WebVTT status for ${guid}: ${webvttStatus}`);
}

/**
 * Updates subtitle configuration in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {Object} config - Subtitle configuration
 * @returns {Promise<void>}
 */
async function updateSubtitleConfiguration(docClient, guid, config) {
    const additionalFields = {
        [SUBTITLE_DB_FIELDS.PROCESSING_ENABLED]: config.enabled,
        [SUBTITLE_DB_FIELDS.PRIMARY_LANGUAGE]: config.primaryLanguage,
        [SUBTITLE_DB_FIELDS.TARGET_LANGUAGES]: config.targetLanguages,
        [SUBTITLE_DB_FIELDS.CONFIG]: config
    };

    const params = createSubtitleProcessingUpdate(guid, 'pending', {
        additionalFields,
        setTimestamps: true
    });

    await docClient.send(new UpdateCommand(params));
    console.log(`Updated subtitle configuration for ${guid}`);
}

/**
 * Updates MediaConvert completion status with final file locations
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {Object} mediaConvertData - MediaConvert job completion data
 * @returns {Promise<void>}
 */
async function updateMediaConvertCompletion(docClient, guid, mediaConvertData) {
    const additionalFields = {};

    // Update final file locations if subtitle files were processed by MediaConvert
    if (mediaConvertData.subtitleFiles) {
        additionalFields[SUBTITLE_DB_FIELDS.FINAL_SUBTITLE_FILES] = mediaConvertData.subtitleFiles;
    }

    // Update CloudFront URLs if available
    if (mediaConvertData.cloudFrontUrls) {
        additionalFields[SUBTITLE_DB_FIELDS.CLOUDFRONT_URLS] = mediaConvertData.cloudFrontUrls;
    }

    // Calculate total processing duration
    if (mediaConvertData.processingStartTime) {
        const startTime = new Date(mediaConvertData.processingStartTime);
        const endTime = new Date();
        const durationSeconds = Math.floor((endTime - startTime) / 1000);
        additionalFields[SUBTITLE_DB_FIELDS.PROCESSING_DURATION_SECONDS] = durationSeconds;
    }

    const params = createSubtitleProcessingUpdate(guid, 'completed', {
        additionalFields,
        setTimestamps: true
    });

    await docClient.send(new UpdateCommand(params));
    console.log(`Updated MediaConvert completion for ${guid}`);
}

/**
 * Retrieves current subtitle processing status from DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @returns {Promise<Object>} Current subtitle processing status and data
 */
async function getSubtitleProcessingStatus(docClient, guid) {
    try {
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            ProjectionExpression: Object.values(SUBTITLE_DB_FIELDS).join(', ')
        };

        const result = await docClient.send(new GetCommand(params));
        
        if (!result.Item) {
            return null;
        }

        // Extract subtitle-related fields
        const subtitleData = {};
        Object.entries(SUBTITLE_DB_FIELDS).forEach(([key, fieldName]) => {
            if (result.Item[fieldName] !== undefined) {
                subtitleData[key] = result.Item[fieldName];
            }
        });

        return subtitleData;
    } catch (err) {
        console.error(`Failed to get subtitle processing status for ${guid}:`, err);
        throw err;
    }
}

/**
 * Updates error details and increments error count
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} errorDetails - Error details
 * @param {string} correlationId - Error correlation ID
 * @returns {Promise<void>}
 */
async function updateSubtitleError(docClient, guid, errorDetails, correlationId = null) {
    const additionalFields = {
        [SUBTITLE_DB_FIELDS.ERROR_DETAILS]: errorDetails,
        [SUBTITLE_DB_FIELDS.LAST_ERROR_TIMESTAMP]: new Date().toISOString()
    };

    if (correlationId) {
        additionalFields[SUBTITLE_DB_FIELDS.CORRELATION_ID] = correlationId;
    }

    const params = createSubtitleProcessingUpdate(guid, 'failed', {
        additionalFields,
        errorDetails,
        setTimestamps: true
    });

    await docClient.send(new UpdateCommand(params));
    console.log(`Updated subtitle error for ${guid}: ${errorDetails}`);
}

/**
 * Updates performance metrics for subtitle processing stages
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {Object} performanceMetrics - Performance metrics by stage
 * @returns {Promise<void>}
 */
async function updatePerformanceMetrics(docClient, guid, performanceMetrics) {
    const additionalFields = {};

    if (performanceMetrics.transcriptionDurationSeconds) {
        additionalFields[SUBTITLE_DB_FIELDS.TRANSCRIPTION_DURATION_SECONDS] = performanceMetrics.transcriptionDurationSeconds;
    }

    if (performanceMetrics.translationDurationSeconds) {
        additionalFields[SUBTITLE_DB_FIELDS.TRANSLATION_DURATION_SECONDS] = performanceMetrics.translationDurationSeconds;
    }

    if (performanceMetrics.webvttGenerationDurationSeconds) {
        additionalFields[SUBTITLE_DB_FIELDS.WEBVTT_GENERATION_DURATION_SECONDS] = performanceMetrics.webvttGenerationDurationSeconds;
    }

    if (performanceMetrics.totalProcessingDurationSeconds) {
        additionalFields[SUBTITLE_DB_FIELDS.PROCESSING_DURATION_SECONDS] = performanceMetrics.totalProcessingDurationSeconds;
    }

    const updateExpression = [];
    const expressionAttributeValues = {};

    Object.keys(additionalFields).forEach((fieldName, index) => {
        const valueName = `:perfValue${index}`;
        updateExpression.push(`${fieldName} = ${valueName}`);
        expressionAttributeValues[valueName] = additionalFields[fieldName];
    });

    if (updateExpression.length > 0) {
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            UpdateExpression: 'SET ' + updateExpression.join(', '),
            ExpressionAttributeValues: expressionAttributeValues
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated performance metrics for ${guid}`);
    }
}

/**
 * Batch update multiple subtitle processing records
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {Array} updates - Array of update operations
 * @returns {Promise<void>}
 */
async function batchUpdateSubtitleStatus(docClient, updates) {
    const promises = updates.map(update => {
        const { guid, status, options } = update;
        const params = createSubtitleProcessingUpdate(guid, status, options);
        return docClient.send(new UpdateCommand(params));
    });

    await Promise.all(promises);
    console.log(`Batch updated ${updates.length} subtitle processing records`);
}

module.exports = {
    SUBTITLE_DB_FIELDS,
    createSubtitleProcessingUpdate,
    updateTranscriptionStatus,
    updateTranslationStatus,
    updateWebVTTStatus,
    updateSubtitleConfiguration,
    updateMediaConvertCompletion,
    getSubtitleProcessingStatus,
    updateSubtitleError,
    updatePerformanceMetrics,
    batchUpdateSubtitleStatus
};
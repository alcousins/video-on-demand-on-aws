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

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const error = require('./lib/error.js');
const { 
    isLanguageSupported, 
    validateAndNormalizeSubtitleConfig, 
    createTranslationStatusUpdate, 
    createSubtitleErrorReport,
    logSubtitleError,
    SUBTITLE_STATUS,
    SUBTITLE_ERROR_TYPES
} = require('./subtitle-utils.js');

/**
 * Subtitle processing status constants are imported from shared utilities
 */

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    const s3Client = new S3Client({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    const dynamoClient = new DynamoDBClient({
        region: process.env.AWS_REGION
    });
    const docClient = DynamoDBDocumentClient.from(dynamoClient);

    try {
        // Validate input parameters
        if (!event.guid || !event.transcriptionJobName || !event.transcriptionOutputLocation) {
            throw new Error('Missing required parameters: guid, transcriptionJobName, or transcriptionOutputLocation');
        }

        // Check if subtitle processing is enabled and validate configuration
        const subtitleConfig = event.subtitleConfig || { enabled: false };
        
        // Enhanced validation with detailed error reporting
        const configResult = validateAndNormalizeSubtitleConfig(subtitleConfig);
        
        if (!configResult.isValid) {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
                `Invalid subtitle configuration: ${configResult.errors.join(', ')}`,
                {
                    guid: event.guid,
                    stage: 'translation-coordination',
                    configErrors: configResult.errors
                }
            );
            
            logSubtitleError(errorReport);
            throw new Error(errorReport.errorMessage);
        }

        if (!configResult.config.enabled) {
            console.log('Subtitle processing is disabled, skipping translation coordination');
            return event;
        }

        // Validate target languages exist
        if (!configResult.config.targetLanguages || configResult.config.targetLanguages.length === 0) {
            console.log('No target languages configured, skipping translation');
            return event;
        }

        // Update DynamoDB with translation start status
        await updateSubtitleProcessingStatus(docClient, event.guid, SUBTITLE_STATUS.TRANSLATING, null, {
            translationStatus: 'STARTING'
        });

        // Parse transcription output location to get S3 bucket and key
        const transcriptionS3Location = parseS3Location(event.transcriptionOutputLocation);
        
        // Download and parse transcription JSON
        console.log(`Downloading transcription results from: ${transcriptionS3Location.bucket}/${transcriptionS3Location.key}`);
        const transcriptionData = await downloadTranscriptionResults(s3Client, transcriptionS3Location.bucket, transcriptionS3Location.key, event.transcriptionJobName);
        
        // Extract text segments with timing information
        const textSegments = extractTextSegments(transcriptionData);
        console.log(`Extracted ${textSegments.length} text segments from transcription`);

        if (textSegments.length === 0) {
            console.log('No text segments found in transcription, skipping translation');
            await updateSubtitleProcessingStatus(docClient, event.guid, SUBTITLE_STATUS.COMPLETED, null, {
                translationStatus: 'SKIPPED_NO_TEXT'
            });
            return event;
        }

        // Determine source language
        const sourceLanguage = determineSourceLanguage(event.detectedLanguage, configResult.config.primaryLanguage);
        console.log(`Source language determined as: ${sourceLanguage}`);

        // Store text segments in S3 to avoid Step Functions output size limits
        const transcriptionS3Key = await storeTranscriptionSegments(s3Client, event, textSegments, sourceLanguage);

        // Generate parallel translation tasks for target languages (without text segments)
        const translationTasks = generateTranslationTasks(
            sourceLanguage,
            configResult.config.targetLanguages,
            transcriptionS3Key, // Pass S3 reference instead of segments
            event.guid
        );

        console.log(`Generated ${translationTasks.length} translation tasks for languages: ${configResult.config.targetLanguages.join(', ')}`);

        // Prepare output for Step Functions parallel execution (minimal data)
        const result = {
            ...event,
            sourceLanguage,
            transcriptionS3Key, // Reference to S3 location instead of full segments
            segmentCount: textSegments.length,
            translationTasks,
            parallelTranslationInput: translationTasks.map(task => ({
                ...event,
                translationTask: task
            }))
        };

        // Update DynamoDB with translation coordination completion
        await updateSubtitleProcessingStatus(docClient, event.guid, SUBTITLE_STATUS.TRANSLATING, null, {
            translationStatus: 'COORDINATED',
            sourceLanguage,
            targetLanguages: configResult.config.targetLanguages,
            textSegmentCount: textSegments.length
        });

        console.log('Translation coordination completed successfully');
        return result;

    } catch (err) {
        console.error('Translation Coordinator Lambda error:', err);
        
        // Create structured error report
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR,
            err.message,
            {
                guid: event.guid,
                stage: 'translation-coordination',
                errorMessage: err.message,
                stack: err.stack
            }
        );
        
        logSubtitleError(errorReport);
        
        // Update DynamoDB with error status
        try {
            await updateSubtitleProcessingStatus(docClient, event.guid, SUBTITLE_STATUS.FAILED, err.message, {
                translationStatus: 'FAILED'
            });
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }
        
        await error.handler(event, err);
        throw err;
    }
};

/**
 * Stores transcription segments in S3 to avoid Step Functions output size limits
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {Array} textSegments - Array of text segments with timing
 * @param {string} sourceLanguage - Source language code
 * @returns {Promise<string>} S3 key where segments were stored
 */
async function storeTranscriptionSegments(s3Client, event, textSegments, sourceLanguage) {
    try {
        // Generate S3 key for transcription segments
        const s3Key = `transcriptions/${event.guid}/segments.json`;
        
        // Prepare the data to store
        const transcriptionData = {
            guid: event.guid,
            sourceLanguage: sourceLanguage,
            segmentCount: textSegments.length,
            textSegments: textSegments,
            transcriptionJobName: event.transcriptionJobName,
            detectedLanguage: event.detectedLanguage,
            timestamp: new Date().toISOString(),
            version: '1.0'
        };

        const jsonContent = JSON.stringify(transcriptionData, null, 2);
        
        console.log(`Storing ${textSegments.length} transcription segments in S3: ${s3Key}`);

        // Use the destination bucket directly (where we have permissions)
        const bucket = event.destBucket;
        
        if (!bucket) {
            throw new Error('Destination bucket not available in event');
        }

        const putObjectCommand = new PutObjectCommand({
            Bucket: bucket, // Use destination bucket where we have permissions
            Key: s3Key,
            Body: jsonContent,
            ContentType: 'application/json',
            ContentEncoding: 'utf-8',
            Metadata: {
                'guid': event.guid,
                'source-language': sourceLanguage,
                'segment-count': textSegments.length.toString(),
                'generated-by': 'translation-coordinator',
                'timestamp': new Date().toISOString()
            }
        });

        await s3Client.send(putObjectCommand);
        
        console.log(`Successfully stored transcription segments in S3: s3://${bucket}/${s3Key}`);
        
        return s3Key;
    } catch (err) {
        console.error(`Failed to store transcription segments in S3:`, err);
        throw new Error(`Failed to store transcription segments: ${err.message}`);
    }
}

/**
 * Parses S3 location string to extract bucket and key
 * @param {string} s3Location - S3 location string (s3://bucket/key)
 * @returns {Object} Object with bucket and key properties
 */
function parseS3Location(s3Location) {
    if (!s3Location || !s3Location.startsWith('s3://')) {
        throw new Error(`Invalid S3 location format: ${s3Location}`);
    }
    
    const locationParts = s3Location.replace('s3://', '').split('/');
    const bucket = locationParts[0];
    const key = locationParts.slice(1).join('/');
    
    if (!bucket || !key) {
        throw new Error(`Invalid S3 location format: ${s3Location}`);
    }
    
    return { bucket, key };
}

/**
 * Downloads transcription results from S3
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key (directory path)
 * @param {string} transcriptionJobName - AWS Transcribe job name (used as filename)
 * @returns {Promise<Object>} Parsed transcription JSON data
 */
async function downloadTranscriptionResults(s3Client, bucket, key, transcriptionJobName) {
    try {
        // AWS Transcribe outputs files with the job name as the filename
        // The key parameter is the directory path, we need to append the job name + .json
        const jsonKey = key.endsWith('/') ? `${key}${transcriptionJobName}.json` : `${key}/${transcriptionJobName}.json`;
        
        console.log(`Downloading transcription JSON from: ${bucket}/${jsonKey}`);
        
        const getObjectCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: jsonKey
        });
        
        const response = await s3Client.send(getObjectCommand);
        const transcriptionText = await streamToString(response.Body);
        
        return JSON.parse(transcriptionText);
    } catch (err) {
        console.error(`Failed to download transcription results from ${bucket}/${key}:`, err);
        throw new Error(`Failed to download transcription results: ${err.message}`);
    }
}

/**
 * Converts a readable stream to string
 * @param {ReadableStream} stream - Readable stream
 * @returns {Promise<string>} String content
 */
async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        // Handle both Buffer and string chunks
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Extracts text segments with timing information from transcription data
 * @param {Object} transcriptionData - AWS Transcribe JSON output
 * @returns {Array} Array of text segments with startTime, endTime, and text
 */
function extractTextSegments(transcriptionData) {
    if (!transcriptionData || !transcriptionData.results) {
        throw new Error('Invalid transcription data format');
    }
    
    const segments = [];
    const items = transcriptionData.results.items || [];
    
    // Group items into segments based on punctuation or natural breaks
    let currentSegment = {
        startTime: null,
        endTime: null,
        words: []
    };
    
    for (const item of items) {
        if (item.type === 'pronunciation' && item.start_time && item.end_time) {
            // Initialize segment start time if not set
            if (currentSegment.startTime === null) {
                currentSegment.startTime = parseFloat(item.start_time) * 1000; // Convert to milliseconds
            }
            
            // Update segment end time
            currentSegment.endTime = parseFloat(item.end_time) * 1000; // Convert to milliseconds
            
            // Add word to current segment
            currentSegment.words.push(item.alternatives[0].content);
            
            // Check if this word ends a sentence (contains punctuation)
            const content = item.alternatives[0].content;
            if (content.match(/[.!?]$/)) {
                // End current segment
                if (currentSegment.words.length > 0) {
                    segments.push({
                        startTime: currentSegment.startTime,
                        endTime: currentSegment.endTime,
                        text: currentSegment.words.join(' ')
                    });
                }
                
                // Start new segment
                currentSegment = {
                    startTime: null,
                    endTime: null,
                    words: []
                };
            }
        } else if (item.type === 'punctuation' && currentSegment.words.length > 0) {
            // Add punctuation to the last word
            const lastWordIndex = currentSegment.words.length - 1;
            currentSegment.words[lastWordIndex] += item.alternatives[0].content;
        }
    }
    
    // Add any remaining segment
    if (currentSegment.words.length > 0 && currentSegment.startTime !== null) {
        segments.push({
            startTime: currentSegment.startTime,
            endTime: currentSegment.endTime,
            text: currentSegment.words.join(' ')
        });
    }
    
    // If no segments were created (no punctuation), create segments based on word count
    if (segments.length === 0 && items.length > 0) {
        const wordsPerSegment = 10; // Reasonable segment size
        let segmentWords = [];
        let segmentStartTime = null;
        let segmentEndTime = null;
        
        for (const item of items) {
            if (item.type === 'pronunciation' && item.start_time && item.end_time) {
                if (segmentStartTime === null) {
                    segmentStartTime = parseFloat(item.start_time) * 1000;
                }
                segmentEndTime = parseFloat(item.end_time) * 1000;
                segmentWords.push(item.alternatives[0].content);
                
                if (segmentWords.length >= wordsPerSegment) {
                    segments.push({
                        startTime: segmentStartTime,
                        endTime: segmentEndTime,
                        text: segmentWords.join(' ')
                    });
                    
                    segmentWords = [];
                    segmentStartTime = null;
                }
            }
        }
        
        // Add remaining words as final segment
        if (segmentWords.length > 0 && segmentStartTime !== null) {
            segments.push({
                startTime: segmentStartTime,
                endTime: segmentEndTime,
                text: segmentWords.join(' ')
            });
        }
    }
    
    return segments;
}

/**
 * Determines the source language for translation
 * @param {string} detectedLanguage - Language detected by AWS Transcribe
 * @param {string} configuredLanguage - Language configured in subtitle config
 * @returns {string} Source language code
 */
function determineSourceLanguage(detectedLanguage, configuredLanguage) {
    // If a specific language was configured, use it
    if (configuredLanguage && configuredLanguage !== 'auto') {
        return configuredLanguage;
    }
    
    // Use detected language, but map AWS Transcribe codes to our standard codes
    if (detectedLanguage) {
        const languageMapping = {
            'en-US': 'en',
            'en-GB': 'en',
            'es-US': 'es',
            'es-ES': 'es',
            'fr-FR': 'fr',
            'fr-CA': 'fr',
            'de-DE': 'de',
            'it-IT': 'it',
            'pt-BR': 'pt-BR',
            'pt-PT': 'pt',
            'ja-JP': 'ja',
            'ko-KR': 'ko',
            'zh-CN': 'zh',
            'ar-SA': 'ar'
        };
        
        return languageMapping[detectedLanguage] || detectedLanguage.split('-')[0];
    }
    
    // Default to English if no language information is available
    return 'en';
}

/**
 * Generates parallel translation tasks for target languages
 * @param {string} sourceLanguage - Source language code
 * @param {Array} targetLanguages - Array of target language codes
 * @param {string} transcriptionS3Key - S3 key where text segments are stored
 * @param {string} jobId - Job identifier
 * @returns {Array} Array of translation tasks
 */
function generateTranslationTasks(sourceLanguage, targetLanguages, transcriptionS3Key, jobId) {
    const tasks = [];
    
    for (const targetLanguage of targetLanguages) {
        // Skip if target language is the same as source language
        if (targetLanguage === sourceLanguage) {
            console.log(`Skipping translation for ${targetLanguage} as it matches source language`);
            continue;
        }
        
        // Validate target language is supported
        if (!isLanguageSupported(targetLanguage)) {
            console.warn(`Target language ${targetLanguage} is not supported, skipping`);
            continue;
        }
        
        // Create translation task with S3 reference instead of full segments
        const task = {
            sourceLanguage,
            targetLanguage,
            transcriptionS3Key, // Reference to S3 location instead of full segments
            jobId: `${jobId}-${sourceLanguage}-to-${targetLanguage}`
        };
        
        tasks.push(task);
    }
    
    return tasks;
}

/**
 * Updates subtitle processing status in DynamoDB using shared utilities
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} status - Processing status
 * @param {string} errorDetails - Error details (optional)
 * @param {Object} additionalFields - Additional fields to update (optional)
 */
async function updateSubtitleProcessingStatus(docClient, guid, status, errorDetails = null, additionalFields = {}) {
    try {
        const fieldsToUpdate = { ...additionalFields };
        if (errorDetails) {
            fieldsToUpdate.errorDetails = errorDetails;
        }
        
        // Extract translationStatus from additionalFields to avoid duplication
        const { translationStatus, ...otherFields } = fieldsToUpdate;
        const translationStatusValue = translationStatus || status;
        
        const updateParams = createTranslationStatusUpdate(translationStatusValue, otherFields);
        
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            ...updateParams
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated subtitle processing status for ${guid}: ${status}`);
    } catch (err) {
        console.error(`Failed to update subtitle processing status for ${guid}:`, err);
        throw err;
    }
}
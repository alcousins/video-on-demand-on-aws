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

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const error = require('./lib/error.js');
const { 
    validateAndNormalizeSubtitleConfig,
    createSubtitleErrorReport,
    logSubtitleError,
    optimizeTranslationBatching,
    SUBTITLE_STATUS,
    SUBTITLE_ERROR_TYPES,
    SUPPORTED_LANGUAGES
} = require('./subtitle-utils.js');
const { 
    createTranslationTask,
    createTextSegment,
    isValidTextSegment
} = require('./subtitle-types.js');
const {
    createOptimizedTranslationBatchConfig,
    monitorResourceUsage,
    NOTIFICATION_CONFIG
} = require('./performance-optimizer.js');
const {
    sendSubtitleNotification,
    sendProgressNotification
} = require('./notification-integration.js');
const {
    createOptimizedS3Client,
    getJsonDataFromS3,
    storeJsonDataInS3,
    generateTranslationTaskKey
} = require('./s3-storage-utils.js');

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
        if (!event.guid) {
            throw new Error('Missing required parameter: guid');
        }

        // Check if we have S3 reference for transcription results
        let fullTranscriptionData;
        if (event.transcriptionResultsS3Location) {
            // Load full transcription data from S3
            console.log(`Loading transcription results from S3: ${event.transcriptionResultsS3Location}`);
            const s3Client = createOptimizedS3Client(process.env.AWS_REGION, process.env.SOLUTION_IDENTIFIER);
            
            fullTranscriptionData = await getJsonDataFromS3(
                s3Client,
                event.transcriptionResultsBucket,
                event.transcriptionResultsKey
            );
            
            console.log(`Successfully loaded transcription data from S3 for guid: ${event.guid}`);
        } else {
            // Fallback to inline data (for backward compatibility)
            if (!event.transcriptionJobName || !event.transcriptionOutputLocation) {
                throw new Error('Missing required parameters: transcriptionJobName, transcriptionOutputLocation, or transcriptionResultsS3Location');
            }
            fullTranscriptionData = event;
        }

        // Use the full transcription data for processing
        const transcriptionJobName = fullTranscriptionData.transcriptionJobName;
        const transcriptionOutputLocation = fullTranscriptionData.transcriptionOutputLocation;
        const detectedLanguage = fullTranscriptionData.detectedLanguage;
        const subtitleConfig = fullTranscriptionData.subtitleConfig || { enabled: false };
        const configResult = validateAndNormalizeSubtitleConfig(subtitleConfig);
        
        if (!configResult.isValid) {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
                `Invalid subtitle configuration: ${configResult.errors.join(', ')}`,
                {
                    guid: event.guid,
                    stage: 'translation-coordinator',
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

        // Check if we have target languages for translation
        const targetLanguages = configResult.config.targetLanguages || [];
        const sourceLanguage = detectedLanguage || configResult.config.primaryLanguage || 'en';
        
        // Filter out the source language from target languages to avoid translating to the same language
        const languagesToTranslate = targetLanguages.filter(lang => {
            // Handle language code variations (e.g., en-US vs en)
            const normalizedSource = sourceLanguage.split('-')[0].toLowerCase();
            const normalizedTarget = lang.split('-')[0].toLowerCase();
            return normalizedSource !== normalizedTarget;
        });

        if (languagesToTranslate.length === 0) {
            console.log('No target languages for translation (source language matches all targets), skipping translation');
            // Update status to indicate translation was skipped
            await updateTranslationStatus(docClient, event.guid, 'SKIPPED', {
                reason: 'No target languages different from source language',
                sourceLanguage: sourceLanguage,
                targetLanguages: targetLanguages
            });
            
            // Set empty translation tasks array
            event.translationTasks = [];
            return event;
        }

        console.log(`Source language: ${sourceLanguage}, Target languages: ${languagesToTranslate.join(', ')}`);

        // Update DynamoDB with translation coordination start status
        await updateTranslationStatus(docClient, event.guid, 'STARTING', {
            sourceLanguage: sourceLanguage,
            targetLanguages: languagesToTranslate,
            transcriptionJobName: transcriptionJobName
        });

        // Parse transcription output to extract text segments
        const textSegments = await parseTranscriptionOutput(s3Client, transcriptionOutputLocation, transcriptionJobName);
        
        if (!textSegments || textSegments.length === 0) {
            const errorMessage = 'No text segments found in transcription output';
            console.error(errorMessage);
            
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR,
                errorMessage,
                {
                    guid: event.guid,
                    stage: 'translation-coordinator',
                    transcriptionJobName: event.transcriptionJobName,
                    outputLocation: event.transcriptionOutputLocation
                }
            );
            
            logSubtitleError(errorReport);
            
            await updateTranslationStatus(docClient, event.guid, 'FAILED', {
                errorMessage: errorMessage
            });
            
            throw new Error(errorMessage);
        }

        console.log(`Extracted ${textSegments.length} text segments from transcription`);

        // Enhanced performance optimization with 4-hour video support
        const estimatedDurationMinutes = event.estimatedDurationMinutes || 60;
        const averageSegmentLength = textSegments.reduce((sum, segment) => sum + segment.text.length, 0) / textSegments.length;
        
        // Use enhanced optimization for better 4-hour video support
        const optimizedBatchConfig = createOptimizedTranslationBatchConfig(textSegments.length, estimatedDurationMinutes);
        
        console.log(`Enhanced translation optimization: ${textSegments.length} segments, avg length: ${Math.round(averageSegmentLength)}, optimized batch size: ${optimizedBatchConfig.batchSize}, concurrent limit: ${optimizedBatchConfig.maxConcurrentRequests}`);

        // Send processing start notification
        await sendSubtitleNotification(
            NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
            {
                guid: event.guid,
                stage: 'translation-coordinator',
                correlationId: event.correlationId,
                languageCount: languagesToTranslate.length,
                segmentCount: textSegments.length,
                estimatedDuration: estimatedDurationMinutes
            }
        );

        // Generate parallel translation tasks for each target language
        const translationTasks = [];
        
        for (const targetLanguage of languagesToTranslate) {
            // Validate that the target language is supported
            if (!SUPPORTED_LANGUAGES[targetLanguage]) {
                console.warn(`Unsupported target language: ${targetLanguage}, skipping`);
                continue;
            }

            // Create translation task with optimized batching
            const taskId = `${event.guid}-${sourceLanguage}-to-${targetLanguage}-${Date.now()}`;
            
            const translationTask = createTranslationTask(
                sourceLanguage,
                targetLanguage,
                textSegments,
                taskId,
                {
                    guid: event.guid,
                    transcriptionJobName: event.transcriptionJobName,
                    batchConfig: optimizedBatchConfig, // Use optimized config
                    segmentCount: textSegments.length,
                    averageSegmentLength: averageSegmentLength,
                    estimatedDurationMinutes: estimatedDurationMinutes,
                    correlationId: event.correlationId
                }
            );

            translationTasks.push(translationTask);
            console.log(`Created translation task: ${taskId} (${sourceLanguage} -> ${targetLanguage})`);
        }

        if (translationTasks.length === 0) {
            const errorMessage = 'No valid translation tasks could be created';
            console.error(errorMessage);
            
            await updateTranslationStatus(docClient, event.guid, 'FAILED', {
                errorMessage: errorMessage,
                reason: 'All target languages were unsupported'
            });
            
            throw new Error(errorMessage);
        }

        // Update DynamoDB with translation tasks ready status
        await updateTranslationStatus(docClient, event.guid, 'TASKS_READY', {
            taskCount: translationTasks.length,
            sourceLanguage: sourceLanguage,
            targetLanguages: languagesToTranslate,
            segmentCount: textSegments.length,
            batchConfig: optimizedBatchConfig, // Use optimized config
            estimatedDurationMinutes: estimatedDurationMinutes
        });

        // Store translation tasks in S3 to avoid Step Functions payload limits
        const tempBucket = fullTranscriptionData.subtitleConfig?.tempBucket || fullTranscriptionData.srcBucket;
        const parallelTranslationInput = [];
        
        for (const translationTask of translationTasks) {
            // Store each task in S3
            const taskKey = generateTranslationTaskKey(event.guid, translationTask.taskId);
            
            const s3StorageResult = await storeJsonDataInS3(
                s3Client,
                tempBucket,
                taskKey,
                translationTask,
                {
                    dataType: 'translation-task',
                    guid: event.guid,
                    stage: 'translation-coordinator'
                }
            );
            
            // Create minimal reference for Step Functions
            parallelTranslationInput.push({
                taskId: translationTask.taskId,
                sourceLanguage: translationTask.sourceLanguage,
                targetLanguage: translationTask.targetLanguage,
                s3Location: s3StorageResult.s3Location,
                s3Bucket: tempBucket,
                s3Key: taskKey,
                segmentCount: translationTask.textSegments?.length || 0
            });
            
            console.log(`Stored translation task in S3: ${s3StorageResult.s3Location}`);
        }

        // Send coordination complete notification
        await sendSubtitleNotification(
            NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_COMPLETE,
            {
                guid: event.guid,
                stage: 'translation-coordinator',
                correlationId: fullTranscriptionData.correlationId,
                languageCount: translationTasks.length,
                segmentCount: textSegments.length,
                processingTime: Math.floor((Date.now() - (fullTranscriptionData.startTime || Date.now())) / 1000)
            }
        );

        // Return minimal data with S3 references for parallel execution
        const result = {
            guid: event.guid,
            sourceLanguage: sourceLanguage,
            segmentCount: textSegments.length,
            batchConfig: optimizedBatchConfig,
            estimatedDurationMinutes: estimatedDurationMinutes,
            parallelTranslationInput: parallelTranslationInput,
            translationTasksCount: translationTasks.length
        };

        console.log(`Translation coordination completed: ${translationTasks.length} tasks stored in S3 for parallel execution`);
        return result;

    } catch (err) {
        console.error('Translation Coordinator Lambda error:', err);
        
        // Create structured error report
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR,
            err.message,
            {
                guid: event.guid,
                stage: 'translation-coordinator',
                errorMessage: err.message,
                stack: err.stack
            }
        );
        
        logSubtitleError(errorReport);
        
        // Update DynamoDB with error status
        try {
            await updateTranslationStatus(docClient, event.guid, 'FAILED', {
                errorMessage: err.message
            });
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }
        
        await error.handler(event, err);
        throw err;
    }

    return event;
};

/**
 * Parses AWS Transcribe output to extract text segments with timing information
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} outputLocation - S3 location of transcription output
 * @param {string} jobName - Transcription job name
 * @returns {Promise<Array>} Array of text segments with timing information
 */
async function parseTranscriptionOutput(s3Client, outputLocation, jobName) {
    try {
        // AWS Transcribe stores the JSON output with the job name
        const transcriptKey = `${outputLocation.replace('s3://', '').split('/').slice(1).join('/')}${jobName}.json`;
        const bucketName = outputLocation.replace('s3://', '').split('/')[0];
        
        console.log(`Fetching transcription output from s3://${bucketName}/${transcriptKey}`);

        const getObjectCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: transcriptKey
        });

        const response = await s3Client.send(getObjectCommand);
        const transcriptData = JSON.parse(await streamToString(response.Body));

        console.log(`Transcription data structure: ${Object.keys(transcriptData).join(', ')}`);

        // Extract segments from AWS Transcribe JSON format
        const textSegments = [];
        
        if (transcriptData.results && transcriptData.results.items) {
            // Group words into segments based on punctuation and pauses
            let currentSegment = {
                startTime: null,
                endTime: null,
                words: []
            };

            for (const item of transcriptData.results.items) {
                if (item.type === 'pronunciation' && item.start_time && item.end_time) {
                    // Initialize segment start time
                    if (currentSegment.startTime === null) {
                        currentSegment.startTime = parseFloat(item.start_time) * 1000; // Convert to milliseconds
                    }
                    
                    // Update segment end time
                    currentSegment.endTime = parseFloat(item.end_time) * 1000; // Convert to milliseconds
                    currentSegment.words.push(item.alternatives[0].content);

                    // Check if this word ends a sentence (contains punctuation)
                    const content = item.alternatives[0].content;
                    const endsSegment = /[.!?]$/.test(content) || currentSegment.words.length >= 15; // Max 15 words per segment

                    if (endsSegment) {
                        // Create text segment
                        const text = currentSegment.words.join(' ');
                        if (text.trim().length > 0) {
                            const segment = createTextSegment(
                                currentSegment.startTime,
                                currentSegment.endTime,
                                text.trim(),
                                {
                                    confidence: item.alternatives[0].confidence || 1.0
                                }
                            );

                            if (isValidTextSegment(segment)) {
                                textSegments.push(segment);
                            }
                        }

                        // Reset for next segment
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

            // Handle any remaining words in the last segment
            if (currentSegment.words.length > 0 && currentSegment.startTime !== null) {
                const text = currentSegment.words.join(' ');
                if (text.trim().length > 0) {
                    const segment = createTextSegment(
                        currentSegment.startTime,
                        currentSegment.endTime,
                        text.trim()
                    );

                    if (isValidTextSegment(segment)) {
                        textSegments.push(segment);
                    }
                }
            }
        }

        // If no segments were created from items, try to use the transcript text with estimated timing
        if (textSegments.length === 0 && transcriptData.results && transcriptData.results.transcripts) {
            console.log('No timed segments found, creating segments from full transcript');
            
            const fullTranscript = transcriptData.results.transcripts[0]?.transcript || '';
            if (fullTranscript.trim().length > 0) {
                // Split transcript into sentences and create estimated timing
                const sentences = fullTranscript.split(/[.!?]+/).filter(s => s.trim().length > 0);
                const estimatedDurationPerChar = 100; // 100ms per character (rough estimate)
                
                let currentTime = 0;
                for (const sentence of sentences) {
                    const text = sentence.trim();
                    if (text.length > 0) {
                        const duration = text.length * estimatedDurationPerChar;
                        const segment = createTextSegment(
                            currentTime,
                            currentTime + duration,
                            text
                        );

                        if (isValidTextSegment(segment)) {
                            textSegments.push(segment);
                        }
                        
                        currentTime += duration + 500; // Add 500ms pause between sentences
                    }
                }
            }
        }

        console.log(`Parsed ${textSegments.length} text segments from transcription output`);
        return textSegments;

    } catch (err) {
        console.error('Error parsing transcription output:', err);
        throw new Error(`Failed to parse transcription output: ${err.message}`);
    }
}

/**
 * Updates translation coordination status in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} status - Translation coordination status
 * @param {Object} additionalFields - Additional fields to update
 */
async function updateTranslationStatus(docClient, guid, status, additionalFields = {}) {
    try {
        const updateExpression = ['SET subtitleTranslationStatus = :status'];
        const expressionAttributeValues = { ':status': status };

        // Add timestamp
        updateExpression.push('subtitleTranslationLastUpdated = :timestamp');
        expressionAttributeValues[':timestamp'] = new Date().toISOString();

        // Update overall subtitle processing status
        if (status === 'STARTING' || status === 'TASKS_READY') {
            updateExpression.push('subtitleProcessingStatus = :processingStatus');
            expressionAttributeValues[':processingStatus'] = SUBTITLE_STATUS.TRANSLATING;
        } else if (status === 'FAILED') {
            updateExpression.push('subtitleProcessingStatus = :processingStatus');
            expressionAttributeValues[':processingStatus'] = SUBTITLE_STATUS.FAILED;
        }

        // Add additional fields
        Object.keys(additionalFields).forEach((key, index) => {
            const valueName = `:value${index}`;
            const fieldName = `subtitleTranslation${key.charAt(0).toUpperCase() + key.slice(1)}`;
            
            updateExpression.push(`${fieldName} = ${valueName}`);
            expressionAttributeValues[valueName] = additionalFields[key];
        });

        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            UpdateExpression: updateExpression.join(', '),
            ExpressionAttributeValues: expressionAttributeValues
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated translation status for ${guid}: ${status}`);

    } catch (err) {
        console.error(`Failed to update translation status for ${guid}:`, err);
        throw err;
    }
}

/**
 * Converts a readable stream to string
 * @param {ReadableStream} stream - The readable stream
 * @returns {Promise<string>} The stream content as string
 */
async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}
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

const { TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const error = require('./lib/error.js');
const { 
    isLanguageSupported, 
    createTranslationStatusUpdate, 
    createSubtitleErrorReport,
    logSubtitleError,
    getRetryConfig,
    optimizeTranslationBatching,
    createOptimizedRetryConfig,
    SUBTITLE_STATUS,
    SUBTITLE_ERROR_TYPES,
    PERFORMANCE_CONFIG
} = require('./subtitle-utils.js');

/**
 * Translation status constants
 */
const TRANSLATION_STATUS = {
    STARTING: 'STARTING',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
};

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    const translateClient = new TranslateClient({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

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
        if (!event.translationTask) {
            throw new Error('Missing required parameter: translationTask');
        }

        // Validate bucket information is available
        if (!event.destBucket) {
            throw new Error('Missing required bucket information: destBucket not provided');
        }

        const task = event.translationTask;
        
        // Validate translation task structure
        validateTranslationTask(task);

        console.log(`Starting translation from ${task.sourceLanguage} to ${task.targetLanguage}`);
        console.log(`Using bucket: ${event.destBucket}`);

        // Retrieve text segments from S3 instead of receiving them directly
        const textSegments = await retrieveTranscriptionSegments(s3Client, event, task.transcriptionS3Key);
        
        console.log(`Retrieved ${textSegments.length} text segments for translation`);

        // Update DynamoDB with translation start status
        await updateTranslationStatus(docClient, event.guid, task.targetLanguage, TRANSLATION_STATUS.STARTING);

        // Translate text segments while preserving timing information
        const translatedSegments = await translateTextSegments(
            translateClient,
            task.sourceLanguage,
            task.targetLanguage,
            textSegments
        );

        console.log(`Successfully translated ${translatedSegments.length} segments to ${task.targetLanguage}`);

        // Store translated segments in S3 instead of returning them in the output
        const s3Key = await storeTranslatedSegments(s3Client, event, task.targetLanguage, translatedSegments);

        // Update DynamoDB with translation completion status
        await updateTranslationStatus(docClient, event.guid, task.targetLanguage, TRANSLATION_STATUS.COMPLETED);

        // Return minimal result with S3 reference instead of full translated content
        const result = {
            guid: event.guid,
            translationResult: {
                sourceLanguage: task.sourceLanguage,
                targetLanguage: task.targetLanguage,
                segmentCount: translatedSegments.length,
                status: TRANSLATION_STATUS.COMPLETED,
                s3Location: s3Key // Reference to S3 location instead of full content
            }
        };

        return result;

    } catch (err) {
        console.error('Translation Worker Lambda error:', err);
        
        // Create structured error report
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR,
            err.message,
            {
                guid: event.guid,
                stage: 'translation-worker',
                targetLanguage: event.translationTask?.targetLanguage || 'unknown',
                errorMessage: err.message,
                stack: err.stack
            }
        );
        
        logSubtitleError(errorReport);
        
        // Update DynamoDB with error status
        try {
            const targetLanguage = event.translationTask?.targetLanguage || 'unknown';
            await updateTranslationStatus(docClient, event.guid, targetLanguage, TRANSLATION_STATUS.FAILED, err.message);
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }
        
        await error.handler(event, err);
        throw err;
    }
};

/**
 * Retrieves transcription segments from S3
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {string} transcriptionS3Key - S3 key where transcription segments are stored
 * @returns {Promise<Array>} Array of text segments
 */
async function retrieveTranscriptionSegments(s3Client, event, transcriptionS3Key) {
    try {
        const bucket = event.destBucket;
        if (!bucket) {
            throw new Error('Destination bucket not available in event');
        }
        
        console.log(`Retrieving transcription segments from S3: s3://${bucket}/${transcriptionS3Key}`);
        
        const getObjectCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: transcriptionS3Key
        });
        
        const response = await s3Client.send(getObjectCommand);
        const jsonContent = await streamToString(response.Body);
        
        const transcriptionData = JSON.parse(jsonContent);
        
        if (!transcriptionData.textSegments || !Array.isArray(transcriptionData.textSegments)) {
            throw new Error('Invalid transcription data format: missing textSegments array');
        }
        
        console.log(`Retrieved ${transcriptionData.textSegments.length} text segments for translation`);
        
        return transcriptionData.textSegments;
    } catch (err) {
        console.error(`Failed to retrieve transcription segments from S3 (${transcriptionS3Key}):`, err);
        throw new Error(`Failed to retrieve transcription segments: ${err.message}`);
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
 * Validates the structure of a translation task
 * @param {Object} task - Translation task object
 * @throws {Error} If task structure is invalid
 */
function validateTranslationTask(task) {
    if (!task.sourceLanguage || typeof task.sourceLanguage !== 'string') {
        throw new Error('Invalid translation task: sourceLanguage is required and must be a string');
    }

    if (!task.targetLanguage || typeof task.targetLanguage !== 'string') {
        throw new Error('Invalid translation task: targetLanguage is required and must be a string');
    }

    if (!task.transcriptionS3Key || typeof task.transcriptionS3Key !== 'string') {
        throw new Error('Invalid translation task: transcriptionS3Key is required and must be a string');
    }

    // Validate that source and target languages are supported
    if (!isLanguageSupported(task.sourceLanguage)) {
        throw new Error(`Unsupported source language: ${task.sourceLanguage}`);
    }

    if (!isLanguageSupported(task.targetLanguage)) {
        throw new Error(`Unsupported target language: ${task.targetLanguage}`);
    }
}

/**
 * Translates text segments while preserving timing information with performance optimizations
 * @param {TranslateClient} translateClient - AWS Translate client
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @param {Array} textSegments - Array of text segments with timing
 * @returns {Promise<Array>} Array of translated segments with preserved timing
 */
async function translateTextSegments(translateClient, sourceLanguage, targetLanguage, textSegments) {
    const translatedSegments = [];
    
    // Calculate average segment length for optimization
    const totalLength = textSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    const averageSegmentLength = totalLength / textSegments.length;
    
    // Get optimized batch configuration
    const batchConfig = optimizeTranslationBatching(textSegments.length, averageSegmentLength);
    
    console.log(`Using optimized translation batching:`, {
        totalSegments: textSegments.length,
        averageLength: Math.round(averageSegmentLength),
        batchSize: batchConfig.batchSize,
        totalBatches: batchConfig.totalBatches,
        batchDelay: batchConfig.batchDelay,
        maxConcurrent: batchConfig.maxConcurrent
    });
    
    // Process segments in optimized batches
    for (let i = 0; i < textSegments.length; i += batchConfig.batchSize) {
        const batch = textSegments.slice(i, i + batchConfig.batchSize);
        const batchNumber = Math.floor(i / batchConfig.batchSize) + 1;
        
        console.log(`Processing translation batch ${batchNumber}/${batchConfig.totalBatches} (${batch.length} segments)`);
        
        // Create promises for concurrent processing within the batch
        const batchPromises = batch.map(async (segment, index) => {
            const segmentIndex = i + index;
            
            try {
                // Add small stagger to avoid overwhelming the API
                if (index > 0) {
                    await new Promise(resolve => setTimeout(resolve, index * 50)); // 50ms stagger
                }
                
                const translatedText = await translateTextWithRetry(
                    translateClient,
                    segment.text,
                    sourceLanguage,
                    targetLanguage,
                    segmentIndex
                );

                return {
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    text: translatedText,
                    originalText: segment.text
                };
            } catch (err) {
                console.error(`Failed to translate segment ${segmentIndex}:`, err);
                
                // For individual segment failures, preserve the original text
                // This allows the process to continue with partial translations
                console.warn(`Using original text for segment ${segmentIndex} due to translation failure`);
                return {
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    text: segment.text, // Keep original text
                    originalText: segment.text,
                    translationError: err.message
                };
            }
        });

        // Process batch with controlled concurrency
        const batchResults = await Promise.all(batchPromises);
        translatedSegments.push(...batchResults);

        // Add optimized delay between batches to avoid rate limiting
        if (i + batchConfig.batchSize < textSegments.length) {
            console.log(`Waiting ${batchConfig.batchDelay}ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, batchConfig.batchDelay));
        }
        
        // Progress reporting for long operations
        if (batchConfig.totalBatches > 5) {
            const progress = Math.round((batchNumber / batchConfig.totalBatches) * 100);
            console.log(`Translation progress: ${progress}% (${translatedSegments.length}/${textSegments.length} segments)`);
        }
    }

    // Log performance metrics
    const errorCount = translatedSegments.filter(s => s.translationError).length;
    const successRate = ((translatedSegments.length - errorCount) / translatedSegments.length * 100).toFixed(1);
    
    console.log(`Translation completed: ${translatedSegments.length} segments, ${successRate}% success rate`);
    
    if (errorCount > 0) {
        console.warn(`${errorCount} segments failed translation and retained original text`);
    }

    return translatedSegments;
}

/**
 * Translates a single text string using AWS Translate with retry logic
 * @param {TranslateClient} translateClient - AWS Translate client
 * @param {string} text - Text to translate
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @param {number} segmentIndex - Segment index for logging
 * @returns {Promise<string>} Translated text
 */
async function translateTextWithRetry(translateClient, text, sourceLanguage, targetLanguage, segmentIndex = 0) {
    const retryConfig = createOptimizedRetryConfig('translation', {
        segmentCount: 1,
        averageSegmentLength: text.length
    });
    
    let lastError;
    
    for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
        try {
            return await translateText(translateClient, text, sourceLanguage, targetLanguage);
        } catch (err) {
            lastError = err;
            
            // Don't retry certain types of errors
            if (err.name === 'UnsupportedLanguagePairException' || 
                err.name === 'TextSizeLimitExceededException') {
                throw err;
            }
            
            // For throttling, use longer delay
            let delay = retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt);
            if (err.name === 'TooManyRequestsException' || err.name === 'ThrottlingException') {
                delay *= 3; // Triple the delay for throttling
            }
            
            delay = Math.min(delay, retryConfig.maxDelayMs);
            
            if (attempt < retryConfig.maxAttempts - 1) {
                console.warn(`Translation attempt ${attempt + 1} failed for segment ${segmentIndex}, retrying in ${delay}ms:`, err.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

/**
 * Translates a single text string using AWS Translate
 * @param {TranslateClient} translateClient - AWS Translate client
 * @param {string} text - Text to translate
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @returns {Promise<string>} Translated text
 */
async function translateText(translateClient, text, sourceLanguage, targetLanguage) {
    // Skip translation if source and target languages are the same
    if (sourceLanguage === targetLanguage) {
        return text;
    }

    // Performance optimization: Skip very short or empty text
    if (!text || text.trim().length === 0) {
        return text;
    }
    
    // Performance optimization: Check text length limits early
    const maxTextLength = 5000; // AWS Translate limit
    if (text.length > maxTextLength) {
        console.warn(`Text segment too long (${text.length} chars), truncating to ${maxTextLength} chars`);
        text = text.substring(0, maxTextLength - 3) + '...';
    }

    // Prepare translation parameters
    const params = {
        Text: text,
        SourceLanguageCode: mapLanguageCodeForTranslate(sourceLanguage),
        TargetLanguageCode: mapLanguageCodeForTranslate(targetLanguage)
    };

    try {
        const command = new TranslateTextCommand(params);
        const response = await translateClient.send(command);
        
        if (!response.TranslatedText) {
            throw new Error('AWS Translate returned empty translation');
        }

        return response.TranslatedText;
    } catch (err) {
        console.error(`AWS Translate error for "${text.substring(0, 50)}...":`, err);
        
        // Handle specific AWS Translate errors with better error messages
        if (err.name === 'UnsupportedLanguagePairException') {
            throw new Error(`Unsupported language pair: ${sourceLanguage} to ${targetLanguage}`);
        } else if (err.name === 'TextSizeLimitExceededException') {
            throw new Error(`Text too long for translation: ${text.length} characters (max: ${maxTextLength})`);
        } else if (err.name === 'TooManyRequestsException') {
            throw new Error('Translation rate limit exceeded, please retry later');
        } else if (err.name === 'ThrottlingException') {
            throw new Error('Translation service throttled, please retry later');
        } else {
            throw new Error(`Translation failed: ${err.message}`);
        }
    }
}

/**
 * Maps internal language codes to AWS Translate language codes
 * @param {string} languageCode - Internal language code
 * @returns {string} AWS Translate language code
 */
function mapLanguageCodeForTranslate(languageCode) {
    // AWS Translate uses slightly different language codes
    const languageMapping = {
        'en': 'en',
        'es': 'es',
        'fr': 'fr',
        'de': 'de',
        'it': 'it',
        'pt': 'pt',
        'pt-BR': 'pt', // AWS Translate uses 'pt' for both Portuguese variants
        'ja': 'ja',
        'ko': 'ko',
        'zh': 'zh', // AWS Translate uses 'zh' for Chinese
        'ar': 'ar'
    };

    return languageMapping[languageCode] || languageCode;
}

/**
 * Stores translated segments in S3 to avoid Step Functions output size limits
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {string} targetLanguage - Target language code
 * @param {Array} translatedSegments - Array of translated segments
 * @returns {Promise<string>} S3 key where segments were stored
 */
async function storeTranslatedSegments(s3Client, event, targetLanguage, translatedSegments) {
    try {
        // Generate S3 key for translated segments
        const s3Key = `translations/${event.guid}/${targetLanguage}/segments.json`;
        
        // Prepare the data to store
        const translationData = {
            guid: event.guid,
            sourceLanguage: event.translationTask.sourceLanguage,
            targetLanguage: targetLanguage,
            segmentCount: translatedSegments.length,
            translatedSegments: translatedSegments,
            timestamp: new Date().toISOString(),
            version: '1.0'
        };

        const jsonContent = JSON.stringify(translationData, null, 2);
        
        console.log(`Storing ${translatedSegments.length} translated segments for ${targetLanguage} in S3: ${s3Key}`);

        const bucket = event.destBucket;
        if (!bucket) {
            throw new Error('Destination bucket not available in event');
        }

        const putObjectCommand = new PutObjectCommand({
            Bucket: bucket, // Use destination bucket consistently
            Key: s3Key,
            Body: jsonContent,
            ContentType: 'application/json',
            ContentEncoding: 'utf-8',
            Metadata: {
                'guid': event.guid,
                'target-language': targetLanguage,
                'segment-count': translatedSegments.length.toString(),
                'generated-by': 'translation-worker',
                'timestamp': new Date().toISOString()
            }
        });

        await s3Client.send(putObjectCommand);
        
        console.log(`Successfully stored translated segments in S3: s3://${bucket}/${s3Key}`);
        
        return s3Key;
    } catch (err) {
        console.error(`Failed to store translated segments in S3:`, err);
        throw new Error(`Failed to store translated segments: ${err.message}`);
    }
}

/**
 * Updates translation status in DynamoDB using shared utilities
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} targetLanguage - Target language being translated
 * @param {string} status - Translation status
 * @param {string} errorDetails - Error details (optional)
 */
async function updateTranslationStatus(docClient, guid, targetLanguage, status, errorDetails = null) {
    if (!guid) {
        console.warn('Cannot update translation status: missing GUID');
        return;
    }

    try {
        const additionalFields = {
            [`languageStatus.${targetLanguage}`]: status
        };

        if (errorDetails) {
            additionalFields[`languageErrors.${targetLanguage}`] = errorDetails;
        }

        // Don't add translationStatus to additionalFields since createTranslationStatusUpdate will add it
        const updateParams = createTranslationStatusUpdate(status, additionalFields);
        
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            ...updateParams
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated translation status for ${guid} (${targetLanguage}): ${status}`);
    } catch (err) {
        console.error(`Failed to update translation status for ${guid} (${targetLanguage}):`, err);
        // Don't throw here - translation status update failure shouldn't fail the translation
    }
}
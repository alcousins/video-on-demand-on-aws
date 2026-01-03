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
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
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
    SUPPORTED_LANGUAGES,
    PERFORMANCE_CONFIG
} = require('./subtitle-utils.js');
const { 
    createTextSegment,
    isValidTextSegment,
    isValidTranslationTask
} = require('./subtitle-types.js');
const { 
    SubtitleErrorHandler,
    handleSubtitleError,
    createRetryWrapper
} = require('./subtitle-error-handler.js');
const {
    createOptimizedS3Client,
    getJsonDataFromS3,
    storeJsonDataInS3,
    generateTranslationResultsKey
} = require('./s3-storage-utils.js');

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    // Create correlation ID for error tracking
    const correlationId = SubtitleErrorHandler.getOrCreateCorrelationId(event, 'translation-worker');
    console.log(`Processing translation worker with correlation ID: ${correlationId}`);

    const translateClient = new TranslateClient({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    const dynamoClient = new DynamoDBClient({
        region: process.env.AWS_REGION
    });
    const docClient = DynamoDBDocumentClient.from(dynamoClient);

    const startTime = Date.now();

    try {
        // Check if we have S3 reference for translation task
        let translationTask;
        if (event.s3Location) {
            // Load translation task from S3
            console.log(`Loading translation task from S3: ${event.s3Location}`);
            const s3Client = createOptimizedS3Client(process.env.AWS_REGION, process.env.SOLUTION_IDENTIFIER);
            
            translationTask = await getJsonDataFromS3(
                s3Client,
                event.s3Bucket,
                event.s3Key
            );
            
            console.log(`Successfully loaded translation task from S3 for taskId: ${event.taskId}`);
        } else {
            // Fallback to inline data (for backward compatibility)
            if (!isValidTranslationTask(event)) {
                throw new Error('Invalid translation task input');
            }
            translationTask = event;
        }

        const { sourceLanguage, targetLanguage, textSegments, taskId, metadata } = translationTask;
        const guid = metadata?.guid || event.taskId?.split('-')[0] || 'unknown';

        console.log(`Starting translation: ${sourceLanguage} -> ${targetLanguage} (${textSegments.length} segments)`);

        // Normalize language codes to handle region codes (e.g., en-US -> en)
        const normalizeLanguageCode = (langCode) => {
            if (!langCode || typeof langCode !== 'string') return null;
            // Extract base language code (e.g., en-US -> en, zh-CN -> zh)
            return langCode.toLowerCase().split('-')[0];
        };

        const normalizedSourceLang = normalizeLanguageCode(sourceLanguage);
        const normalizedTargetLang = normalizeLanguageCode(targetLanguage);

        // Validate language support using normalized codes
        if (!SUPPORTED_LANGUAGES[normalizedSourceLang] || !SUPPORTED_LANGUAGES[normalizedTargetLang]) {
            const errorMessage = `Unsupported language pair: ${sourceLanguage} -> ${targetLanguage} (normalized: ${normalizedSourceLang} -> ${normalizedTargetLang})`;
            console.error(errorMessage);
            
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR,
                errorMessage,
                {
                    guid: guid,
                    stage: 'translation-worker',
                    correlationId,
                    sourceLanguage: sourceLanguage,
                    targetLanguage: targetLanguage,
                    taskId: taskId
                }
            );
            
            logSubtitleError(errorReport);
            
            return {
                targetLanguage: targetLanguage,
                translatedSegments: [],
                status: 'failed',
                errorMessage: errorMessage,
                processingTimeMs: Date.now() - startTime,
                correlationId
            };
        }

        // Update DynamoDB with translation start status (non-blocking)
        try {
            await updateTranslationWorkerStatus(docClient, guid, targetLanguage, 'STARTING', {
                sourceLanguage: sourceLanguage,
                segmentCount: textSegments.length,
                taskId: taskId,
                correlationId
            });
        } catch (dbError) {
            console.warn(`Failed to update DynamoDB status (non-blocking): ${dbError.message}`);
            // Continue processing even if DynamoDB update fails
        }

        // Process translation in batches to handle rate limits and memory efficiently
        const batchSize = metadata?.batchConfig?.batchSize || 10;
        const batchDelay = metadata?.batchConfig?.batchDelay || 100; // ms between batches
        const translatedSegments = [];
        
        console.log(`Processing ${textSegments.length} segments in batches of ${batchSize}`);

        // Create retry wrapper for translation operations
        const retryTranslationOperation = createRetryWrapper('translation', {
            correlationId,
            segmentCount: textSegments.length,
            averageSegmentLength: textSegments.reduce((sum, seg) => sum + (seg.text?.length || 0), 0) / textSegments.length,
            operationName: 'translateBatch'
        });

        for (let i = 0; i < textSegments.length; i += batchSize) {
            const batch = textSegments.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(textSegments.length / batchSize)} (${batch.length} segments)`);

            // Process batch with enhanced retry logic
            const batchResults = await retryTranslationOperation(async () => {
                return await processBatchWithRetry(
                    translateClient,
                    batch,
                    sourceLanguage,
                    targetLanguage,
                    PERFORMANCE_CONFIG.S3_UPLOAD.RETRY_CONFIG,
                    correlationId
                );
            });

            translatedSegments.push(...batchResults);

            // Add delay between batches to avoid rate limiting
            if (i + batchSize < textSegments.length && batchDelay > 0) {
                await sleep(batchDelay);
            }

            // Update progress (non-blocking)
            const progress = Math.min(100, Math.round(((i + batch.length) / textSegments.length) * 100));
            try {
                await updateTranslationWorkerStatus(docClient, guid, targetLanguage, 'IN_PROGRESS', {
                    progress: progress,
                    processedSegments: i + batch.length,
                    totalSegments: textSegments.length,
                    correlationId
                });
            } catch (dbError) {
                console.warn(`Failed to update DynamoDB progress (non-blocking): ${dbError.message}`);
                // Continue processing even if DynamoDB update fails
            }
        }

        // Validate all segments were translated successfully
        const successfulTranslations = translatedSegments.filter(segment => 
            segment && segment.text && segment.text.trim().length > 0 && !segment.translationFailed
        );
        const failedCount = textSegments.length - successfulTranslations.length;

        if (failedCount > 0) {
            console.warn(`${failedCount} segments failed translation out of ${textSegments.length} total`);
        }

        // Update final status (non-blocking)
        const processingTimeMs = Date.now() - startTime;
        const finalStatus = failedCount === 0 ? 'COMPLETED' : 'PARTIAL_SUCCESS';
        
        try {
            await updateTranslationWorkerStatus(docClient, guid, targetLanguage, finalStatus, {
                successfulSegments: successfulTranslations.length,
                failedSegments: failedCount,
                processingTimeMs: processingTimeMs,
                correlationId
            });
        } catch (dbError) {
            console.warn(`Failed to update DynamoDB final status (non-blocking): ${dbError.message}`);
            // Continue processing even if DynamoDB update fails
        }

        console.log(`Translation completed: ${sourceLanguage} -> ${targetLanguage} (${successfulTranslations.length}/${textSegments.length} successful, ${processingTimeMs}ms)`);

        // Store translation results in S3 to avoid Step Functions payload limits
        const s3Client = createOptimizedS3Client(process.env.AWS_REGION, process.env.SOLUTION_IDENTIFIER);
        const tempBucket = process.env.SubtitleTempBucket;
        const resultsKey = generateTranslationResultsKey(guid, taskId);
        
        const translationResults = {
            taskId: taskId,
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            translatedSegments: translatedSegments,
            status: failedCount === 0 ? 'completed' : 'partial_success',
            errorMessage: failedCount > 0 ? `${failedCount} segments failed translation` : undefined,
            processingTimeMs: processingTimeMs,
            correlationId,
            metadata: {
                taskId: taskId,
                sourceLanguage: sourceLanguage,
                totalSegments: textSegments.length,
                successfulSegments: successfulTranslations.length,
                failedSegments: failedCount
            }
        };
        
        const s3StorageResult = await storeJsonDataInS3(
            s3Client,
            tempBucket,
            resultsKey,
            translationResults,
            {
                dataType: 'translation-results',
                guid: guid,
                stage: 'translation-worker'
            }
        );
        
        console.log(`Stored translation results in S3: ${s3StorageResult.s3Location}`);

        // Return minimal result with S3 reference
        return {
            taskId: taskId,
            targetLanguage: targetLanguage,
            status: failedCount === 0 ? 'completed' : 'partial_success',
            errorMessage: failedCount > 0 ? `${failedCount} segments failed translation` : undefined,
            processingTimeMs: processingTimeMs,
            correlationId,
            // S3 reference for full results
            resultsS3Location: s3StorageResult.s3Location,
            resultsBucket: tempBucket,
            resultsKey: resultsKey,
            segmentCount: successfulTranslations.length,
            failedSegments: failedCount
        };

    } catch (err) {
        console.error('Translation Worker Lambda error:', err);
        
        const processingTimeMs = Date.now() - startTime;
        const guid = event?.metadata?.guid || 'unknown';
        const targetLanguage = event?.targetLanguage || 'unknown';
        
        // Use the new centralized error handling system
        const errorHandlingResult = await handleSubtitleError(event, err, {
            stage: 'translation-worker',
            correlationId,
            functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
            targetLanguage,
            processingTimeMs
        });
        
        // Update DynamoDB with error status (non-blocking)
        try {
            await updateTranslationWorkerStatus(docClient, guid, targetLanguage, 'FAILED', {
                errorMessage: err.message,
                processingTimeMs: processingTimeMs,
                correlationId: errorHandlingResult.correlationId
            });
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status (non-blocking):', dbErr);
            // Continue processing even if DynamoDB update fails
        }
        
        // Return error result instead of throwing to allow other translations to continue
        // This implements error isolation as required
        return {
            taskId: event?.taskId || 'unknown',
            targetLanguage: targetLanguage,
            status: 'failed',
            errorMessage: err.message,
            processingTimeMs: processingTimeMs,
            correlationId: errorHandlingResult.correlationId,
            segmentCount: 0,
            failedSegments: event?.textSegments?.length || 0
        };
    }
};

/**
 * Processes a batch of text segments with retry logic
 * @param {TranslateClient} translateClient - AWS Translate client
 * @param {Array} textSegments - Array of text segments to translate
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @param {Object} retryConfig - Retry configuration
 * @param {string} correlationId - Correlation ID for error tracking
 * @returns {Promise<Array>} Array of translated text segments
 */
async function processBatchWithRetry(translateClient, textSegments, sourceLanguage, targetLanguage, retryConfig, correlationId) {
    const translatedSegments = [];

    for (const segment of textSegments) {
        if (!isValidTextSegment(segment)) {
            console.warn('Invalid text segment, creating fallback:', segment);
            
            // Create a fallback segment for invalid segments to preserve timing
            const fallbackSegment = createTextSegment(
                segment.startTime || 0,
                segment.endTime || 1000,
                segment.text || '', // Keep original text even if empty
                {
                    confidence: 0, // Mark as low confidence
                    speaker: segment.speaker,
                    translationFailed: true,
                    originalText: segment.text || '',
                    sourceLanguage: sourceLanguage,
                    targetLanguage: targetLanguage,
                    errorMessage: 'Invalid text segment',
                    correlationId
                }
            );
            
            translatedSegments.push(fallbackSegment);
            continue;
        }

        let translatedSegment = null;
        let lastError = null;

        // Retry logic with exponential backoff
        for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
            try {
                const translatedText = await translateTextWithTimeout(
                    translateClient,
                    segment.text,
                    sourceLanguage,
                    targetLanguage,
                    retryConfig.timeoutMs
                );

                // Create translated segment preserving timing information
                translatedSegment = createTextSegment(
                    segment.startTime,
                    segment.endTime,
                    translatedText,
                    {
                        confidence: segment.confidence,
                        speaker: segment.speaker,
                        originalText: segment.text,
                        sourceLanguage: sourceLanguage,
                        targetLanguage: targetLanguage,
                        correlationId
                    }
                );

                break; // Success, exit retry loop

            } catch (err) {
                lastError = err;
                console.warn(`Translation attempt ${attempt}/${retryConfig.maxAttempts} failed for segment (${correlationId}): ${err.message}`);

                // Check if error is retryable
                if (!isRetryableError(err) || attempt === retryConfig.maxAttempts) {
                    break;
                }

                // Calculate delay with exponential backoff
                const delay = Math.min(
                    retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt - 1),
                    retryConfig.maxDelayMs
                );

                console.log(`Retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }

        if (translatedSegment) {
            translatedSegments.push(translatedSegment);
        } else {
            console.error(`Failed to translate segment after ${retryConfig.maxAttempts} attempts (${correlationId}):`, lastError?.message);
            
            // Create a fallback segment with original text to preserve timing
            const fallbackSegment = createTextSegment(
                segment.startTime,
                segment.endTime,
                segment.text, // Keep original text as fallback
                {
                    confidence: 0, // Mark as low confidence
                    speaker: segment.speaker,
                    translationFailed: true,
                    originalText: segment.text,
                    sourceLanguage: sourceLanguage,
                    targetLanguage: targetLanguage,
                    errorMessage: lastError?.message,
                    correlationId
                }
            );
            
            translatedSegments.push(fallbackSegment);
        }
    }

    return translatedSegments;
}

/**
 * Translates text using AWS Translate with timeout
 * @param {TranslateClient} translateClient - AWS Translate client
 * @param {string} text - Text to translate
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<string>} Translated text
 */
async function translateTextWithTimeout(translateClient, text, sourceLanguage, targetLanguage, timeoutMs = 30000) {
    // Clean and validate input text
    const cleanText = text.trim();
    if (!cleanText) {
        throw new Error('Empty text provided for translation');
    }

    // AWS Translate has a 5000 byte limit per request
    if (Buffer.byteLength(cleanText, 'utf8') > 5000) {
        throw new Error('Text segment too large for translation (>5000 bytes)');
    }

    const command = new TranslateTextCommand({
        Text: cleanText,
        SourceLanguageCode: sourceLanguage,
        TargetLanguageCode: targetLanguage
    });

    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Translation timeout')), timeoutMs);
    });

    try {
        const result = await Promise.race([
            translateClient.send(command),
            timeoutPromise
        ]);

        if (!result.TranslatedText) {
            throw new Error('No translated text returned from AWS Translate');
        }

        return result.TranslatedText.trim();

    } catch (err) {
        // Enhance error message with context
        const errorMessage = `Translation failed (${sourceLanguage}->${targetLanguage}): ${err.message}`;
        throw new Error(errorMessage);
    }
}

/**
 * Checks if an error is retryable
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableError(error) {
    const retryableErrors = [
        'ThrottlingException',
        'ServiceUnavailableException',
        'InternalServerError',
        'RequestTimeout',
        'NetworkingError',
        'Translation timeout'
    ];

    return retryableErrors.some(retryableError => 
        error.name === retryableError || 
        error.message.includes(retryableError) ||
        error.code === retryableError
    );
}

/**
 * Updates translation worker status in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} targetLanguage - Target language being processed
 * @param {string} status - Translation worker status
 * @param {Object} additionalFields - Additional fields to update
 */
async function updateTranslationWorkerStatus(docClient, guid, targetLanguage, status, additionalFields = {}) {
    try {
        const updateExpression = [];
        const expressionAttributeValues = {};

        // Add status
        updateExpression.push(`subtitleTranslationWorker_${targetLanguage}_status = :status`);
        expressionAttributeValues[':status'] = status;

        // Add timestamp
        updateExpression.push(`subtitleTranslationWorker_${targetLanguage}_lastUpdated = :timestamp`);
        expressionAttributeValues[':timestamp'] = new Date().toISOString();

        // Add additional fields with language-specific prefixes
        const additionalFieldKeys = Object.keys(additionalFields);
        console.log(`Updating ${additionalFieldKeys.length} additional fields for ${targetLanguage}:`, additionalFieldKeys);
        
        let valueIndex = 0;
        additionalFieldKeys.forEach((key) => {
            const fieldValue = additionalFields[key];
            
            // Skip undefined values to avoid DynamoDB errors
            if (fieldValue !== undefined && fieldValue !== null) {
                const valueName = `:additionalValue${valueIndex}`;
                const fieldName = `subtitleTranslationWorker_${targetLanguage}_${key}`;
                
                updateExpression.push(`${fieldName} = ${valueName}`);
                expressionAttributeValues[valueName] = fieldValue;
                
                console.log(`  ${fieldName} = ${valueName} (${typeof fieldValue}: ${fieldValue})`);
                valueIndex++; // Only increment for values we actually use
            } else {
                console.log(`  Skipping ${fieldName} because value is ${fieldValue}`);
            }
        });

        const finalUpdateExpression = 'SET ' + updateExpression.join(', ');
        
        console.log(`DynamoDB UpdateExpression: ${finalUpdateExpression}`);
        console.log(`DynamoDB ExpressionAttributeValues:`, JSON.stringify(expressionAttributeValues, null, 2));

        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            UpdateExpression: finalUpdateExpression,
            ExpressionAttributeValues: expressionAttributeValues
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated translation worker status for ${guid} (${targetLanguage}): ${status}`);

    } catch (err) {
        console.error(`Failed to update translation worker status for ${guid} (${targetLanguage}):`, err);
        console.error(`Error details:`, {
            guid,
            targetLanguage,
            status,
            additionalFields,
            errorMessage: err.message
        });
        throw err;
    }
}

/**
 * Sleep utility function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after the specified time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
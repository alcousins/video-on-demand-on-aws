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
 *                                                                                                                    *
 *********************************************************************************************************************/

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require('crypto');
const error = require('./lib/error.js');
const { 
    formatWebVTTTimestamp,
    createWebVTTHeader,
    generateWebVTTFilename,
    generateSubtitleS3Key,
    generateCloudFrontUrl,
    createWebVTTStatusUpdate,
    createSubtitleErrorReport,
    logSubtitleError,
    shouldUseMemoryOptimization,
    getOptimalUploadStrategy,
    WEBVTT_STATUS,
    SUBTITLE_ERROR_TYPES,
    SUPPORTED_LANGUAGES,
    PERFORMANCE_CONFIG
} = require('./subtitle-utils.js');
const { 
    createWebVTTFile,
    isValidTextSegment,
    isValidWebVTTFile
} = require('./subtitle-types.js');
const { 
    createOptimizedS3Client,
    getJsonDataFromS3,
    STORAGE_CONFIG
} = require('./s3-storage-utils.js');

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    // Use optimized S3 client for subtitle file operations
    const s3Client = createOptimizedS3Client(
        process.env.AWS_REGION,
        process.env.SOLUTION_IDENTIFIER
    );

    const dynamoClient = new DynamoDBClient({
        region: process.env.AWS_REGION
    });
    const docClient = DynamoDBDocumentClient.from(dynamoClient);

    const startTime = Date.now();

    try {
        // Validate input parameters
        if (!event.guid) {
            throw new Error('Missing required parameter: guid');
        }

        const { guid, srcVideo, destBucket, cloudFrontDomain } = event;
        const tempBucket = process.env.TEMP_BUCKET || destBucket;

        // Load translation results from S3 references
        let translationResults = {};
        
        if (event.translationReferences && Array.isArray(event.translationReferences)) {
            console.log(`Loading ${event.translationReferences.length} translation results from S3`);
            const s3Client = createOptimizedS3Client(process.env.AWS_REGION, process.env.SOLUTION_IDENTIFIER);
            
            for (const translationRef of event.translationReferences) {
                // Handle Step Functions Lambda response format
                const payload = translationRef.Payload || translationRef;
                
                if (payload.resultsS3Location && payload.targetLanguage) {
                    try {
                        const translationData = await getJsonDataFromS3(
                            s3Client,
                            payload.resultsBucket,
                            payload.resultsKey
                        );
                        
                        // Extract translated segments from the stored data
                        if (translationData.translatedSegments) {
                            translationResults[payload.targetLanguage] = translationData.translatedSegments;
                            console.log(`Loaded ${translationData.translatedSegments.length} segments for ${payload.targetLanguage}`);
                        }
                    } catch (err) {
                        console.error(`Failed to load translation results for ${payload.targetLanguage}:`, err);
                        // Continue with other languages
                    }
                }
            }
        } else if (event.translationResults) {
            // Fallback to inline data (for backward compatibility)
            translationResults = event.translationResults;
        } else {
            throw new Error('Missing required parameters: translationReferences or translationResults');
        }

        if (Object.keys(translationResults).length === 0) {
            throw new Error('No valid translation results found');
        }

        console.log(`Starting WebVTT generation for ${guid} with ${Object.keys(translationResults).length} languages`);

        // Update DynamoDB with WebVTT generation start status
        await updateWebVTTStatusSimplified(docClient, guid, WEBVTT_STATUS.STARTING, [], {
            languageCount: Object.keys(translationResults).length,
            languages: Object.keys(translationResults)
        });

        // Validate translation results structure
        const validationResult = validateTranslationResults(translationResults);
        if (!validationResult.isValid) {
            throw new Error(`Invalid translation results: ${validationResult.errors.join(', ')}`);
        }

        // Generate WebVTT files for each language
        const webvttFiles = [];
        const uploadPromises = [];
        
        for (const [language, translatedSegments] of Object.entries(translationResults)) {
            try {
                console.log(`Generating WebVTT for language: ${language} (${translatedSegments.length} segments)`);

                // Validate language support
                if (!SUPPORTED_LANGUAGES[language]) {
                    console.warn(`Unsupported language: ${language}, skipping WebVTT generation`);
                    continue;
                }

                // Generate WebVTT content
                const webvttContent = await generateWebVTTContent(language, translatedSegments);
                
                // Validate WebVTT syntax
                const syntaxValidation = validateWebVTTSyntax(webvttContent);
                if (!syntaxValidation.isValid) {
                    throw new Error(`WebVTT syntax validation failed for ${language}: ${syntaxValidation.errors.join(', ')}`);
                }

                // Generate filename and create WebVTT file object
                const filename = generateWebVTTFilename(srcVideo, language);
                const contentSize = Buffer.byteLength(webvttContent, 'utf8');
                const checksum = crypto.createHash('md5').update(webvttContent).digest('hex');

                // Create WebVTT file object for upload
                const webvttFile = {
                    language: language,
                    filename: filename,
                    s3Location: '', // Will be updated after upload
                    content: webvttContent,
                    size: contentSize,
                    checksum: checksum
                };

                // Validate WebVTT file object
                if (!isValidWebVTTFile(webvttFile)) {
                    throw new Error(`Invalid WebVTT file object created for language: ${language}`);
                }

                webvttFiles.push(webvttFile);

                // Upload WebVTT file directly to final destination bucket
                const s3Key = generateSubtitleS3Key(guid, filename);
                const uploadPromise = uploadWebVTTToS3(
                    s3Client,
                    destBucket,
                    s3Key,
                    webvttFile
                ).then(uploadResult => {
                    console.log(`Successfully uploaded WebVTT for ${language} to S3: ${uploadResult.s3Location}`);
                    // Update the webvttFile with the S3 location from upload result
                    webvttFile.s3Location = uploadResult.s3Location;
                    return {
                        ...webvttFile,
                        ...uploadResult,
                        success: true
                    };
                }).catch(err => {
                    console.error(`Failed to upload WebVTT file for ${language}:`, err);
                    return { 
                        language: language, 
                        filename: filename,
                        error: err.message, 
                        success: false 
                    };
                });

                uploadPromises.push(uploadPromise);

                console.log(`WebVTT generated for ${language}: ${contentSize} bytes, ${translatedSegments.length} segments`);

            } catch (err) {
                console.error(`Error generating WebVTT for language ${language}:`, err);
                
                // Create error report for this specific language
                const errorReport = createSubtitleErrorReport(
                    SUBTITLE_ERROR_TYPES.WEBVTT_ERROR,
                    `WebVTT generation failed for ${language}: ${err.message}`,
                    {
                        guid: guid,
                        stage: 'webvtt-generator',
                        language: language,
                        segmentCount: translatedSegments?.length || 0
                    }
                );
                
                logSubtitleError(errorReport);
                
                // Continue with other languages instead of failing completely
                uploadPromises.push(Promise.resolve({ 
                    language, 
                    error: err.message, 
                    success: false 
                }));
            }
        }

        if (webvttFiles.length === 0) {
            throw new Error('No valid WebVTT files could be generated');
        }

        // Update status to uploading
        await updateWebVTTStatusSimplified(docClient, guid, WEBVTT_STATUS.UPLOADING, [], {
            generatedFiles: webvttFiles.length,
            totalSize: webvttFiles.reduce((sum, file) => sum + file.size, 0)
        });

        // Wait for all uploads to complete
        console.log(`Uploading ${uploadPromises.length} WebVTT files to temporary S3 storage...`);
        const uploadResults = await Promise.all(uploadPromises);

        // Process upload results
        const successfulUploads = uploadResults.filter(result => result.success !== false);
        const failedUploads = uploadResults.filter(result => result.success === false);

        if (failedUploads.length > 0) {
            console.warn(`${failedUploads.length} WebVTT uploads failed:`, failedUploads.map(f => `${f.language}: ${f.error}`));
        }

        if (successfulUploads.length === 0) {
            throw new Error('All WebVTT file uploads failed');
        }

        // Update final status with simplified metadata (only S3 URLs)
        const processingTimeMs = Date.now() - startTime;
        await updateWebVTTStatusSimplified(docClient, guid, WEBVTT_STATUS.COMPLETED, successfulUploads, {
            uploadedFiles: successfulUploads.length,
            failedUploads: failedUploads.length,
            processingTimeMs: processingTimeMs,
            totalSize: successfulUploads.reduce((sum, file) => sum + (file.size || 0), 0)
        });

        // Return simplified event with WebVTT file information
        event.webvttFiles = successfulUploads.map(result => ({
            language: result.language,
            filename: result.filename,
            s3Location: result.s3Location,
            size: result.size
        }));
        event.subtitleProcessingStatus = 'completed';
        event.processingTimeMs = processingTimeMs;

        console.log(`WebVTT generation completed: ${successfulUploads.length} .vtt files uploaded to S3 (${processingTimeMs}ms)`);

        return event;

    } catch (err) {
        console.error('WebVTT Generator Lambda error:', err);
        
        const processingTimeMs = Date.now() - startTime;
        
        // Create structured error report
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.WEBVTT_ERROR,
            err.message,
            {
                guid: event.guid,
                stage: 'webvtt-generator',
                errorMessage: err.message,
                stack: err.stack,
                processingTimeMs: processingTimeMs
            }
        );
        
        logSubtitleError(errorReport);
        
        // Update DynamoDB with error status
        try {
            await updateWebVTTStatusSimplified(docClient, event.guid, WEBVTT_STATUS.FAILED, [], {
                errorMessage: err.message,
                processingTimeMs: processingTimeMs
            });
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }
        
        await error.handler(event, err);
        throw err;
    }
};

/**
 * Validates translation results structure
 * @param {Object} translationResults - Translation results by language
 * @returns {Object} Validation result with isValid boolean and errors array
 */
function validateTranslationResults(translationResults) {
    const errors = [];
    
    if (!translationResults || typeof translationResults !== 'object') {
        return { isValid: false, errors: ['Translation results must be an object'] };
    }
    
    const languages = Object.keys(translationResults);
    if (languages.length === 0) {
        return { isValid: false, errors: ['No translation results provided'] };
    }
    
    for (const language of languages) {
        const segments = translationResults[language];
        
        if (!Array.isArray(segments)) {
            errors.push(`Translation results for ${language} must be an array`);
            continue;
        }
        
        if (segments.length === 0) {
            errors.push(`No segments found for language: ${language}`);
            continue;
        }
        
        // Validate a sample of segments (first 5) for performance
        const sampleSegments = segments.slice(0, 5);
        for (let i = 0; i < sampleSegments.length; i++) {
            const segment = sampleSegments[i];
            if (!isValidTextSegment(segment)) {
                errors.push(`Invalid text segment at index ${i} for language ${language}`);
                break; // Don't check all segments to avoid too many errors
            }
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Generates WebVTT content from translated text segments
 * @param {string} language - Language code
 * @param {Array} translatedSegments - Array of translated text segments
 * @returns {Promise<string>} WebVTT formatted content
 */
async function generateWebVTTContent(language, translatedSegments) {
    if (!translatedSegments || translatedSegments.length === 0) {
        throw new Error('No translated segments provided for WebVTT generation');
    }

    // Start with WebVTT header
    let webvttContent = createWebVTTHeader(language);
    
    // Check if we should use memory optimization for large files
    const useMemoryOptimization = shouldUseMemoryOptimization(
        translatedSegments.length,
        translatedSegments.reduce((sum, seg) => sum + (seg.text?.length || 0), 0) / translatedSegments.length
    );
    
    if (useMemoryOptimization) {
        console.log(`Using memory optimization for ${language} (${translatedSegments.length} segments)`);
    }

    // Sort segments by start time to ensure proper order
    const sortedSegments = [...translatedSegments].sort((a, b) => a.startTime - b.startTime);
    
    // Generate WebVTT cues
    let cueNumber = 1;
    const maxSegmentsPerYield = PERFORMANCE_CONFIG.WEBVTT_GENERATION.MAX_SEGMENTS_PER_YIELD;
    
    for (let i = 0; i < sortedSegments.length; i++) {
        const segment = sortedSegments[i];
        
        // Skip invalid segments but log them
        if (!isValidTextSegment(segment)) {
            console.warn(`Skipping invalid segment at index ${i} for language ${language}:`, segment);
            continue;
        }
        
        // Skip segments with empty text (but preserve timing structure)
        if (!segment.text || segment.text.trim().length === 0) {
            console.warn(`Skipping empty text segment at index ${i} for language ${language}`);
            continue;
        }
        
        // Format timestamps with input validation
        const startTime = typeof segment.startTime === 'number' ? segment.startTime : parseFloat(segment.startTime) || 0;
        const endTime = typeof segment.endTime === 'number' ? segment.endTime : parseFloat(segment.endTime) || 0;
        
        const startTimestamp = formatWebVTTTimestamp(startTime);
        const endTimestamp = formatWebVTTTimestamp(endTime);
        
        // Clean and validate text content
        const cleanText = cleanWebVTTText(segment.text);
        if (!cleanText || cleanText.length === 0) {
            console.warn(`Skipping segment with no clean text at index ${i} for language ${language}`);
            continue;
        }
        
        // Generate WebVTT cue
        webvttContent += `${cueNumber}\n`;
        webvttContent += `${startTimestamp} --> ${endTimestamp}\n`;
        webvttContent += `${cleanText}\n\n`;
        
        cueNumber++;
        
        // Yield control periodically for memory optimization
        if (useMemoryOptimization && i > 0 && i % maxSegmentsPerYield === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    
    // Validate that we generated at least some content
    if (cueNumber === 1) {
        throw new Error(`No valid WebVTT cues generated for language: ${language}`);
    }
    
    // Check file size limits
    const contentSize = Buffer.byteLength(webvttContent, 'utf8');
    const maxFileSize = PERFORMANCE_CONFIG.WEBVTT_GENERATION.MAX_FILE_SIZE_BYTES;
    
    if (contentSize > maxFileSize) {
        throw new Error(`WebVTT file too large for ${language}: ${contentSize} bytes (max: ${maxFileSize})`);
    }
    
    console.log(`Generated WebVTT for ${language}: ${cueNumber - 1} cues, ${contentSize} bytes`);
    return webvttContent;
}

/**
 * Cleans text content for WebVTT format
 * @param {string} text - Raw text content
 * @returns {string} Cleaned text suitable for WebVTT
 */
function cleanWebVTTText(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }
    
    return text
        // Remove or replace problematic characters
        .replace(/[\r\n]+/g, ' ') // Replace line breaks with spaces
        .replace(/\s+/g, ' ') // Normalize whitespace
        .replace(/[<>&]/g, (match) => {
            // Escape HTML-like characters that could interfere with WebVTT
            switch (match) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                default: return match;
            }
        })
        .trim();
}

/**
 * Validates WebVTT syntax
 * @param {string} webvttContent - WebVTT content to validate
 * @returns {Object} Validation result with isValid boolean and errors array
 */
function validateWebVTTSyntax(webvttContent) {
    const errors = [];
    
    if (!webvttContent || typeof webvttContent !== 'string') {
        return { isValid: false, errors: ['WebVTT content must be a non-empty string'] };
    }
    
    // Check for required WebVTT header
    if (!webvttContent.startsWith('WEBVTT')) {
        errors.push('WebVTT content must start with "WEBVTT" header');
    }
    
    // Split into lines for detailed validation
    const lines = webvttContent.split('\n');
    let inCue = false;
    let cueCount = 0;
    let lineIndex = 0;
    
    for (const line of lines) {
        lineIndex++;
        
        // Skip empty lines and header
        if (line.trim() === '' || line.startsWith('WEBVTT') || line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('NOTE')) {
            continue;
        }
        
        // Check for timestamp line (indicates start of cue)
        if (line.includes('-->')) {
            inCue = true;
            cueCount++;
            
            // Validate timestamp format
            const timestampMatch = line.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
            if (!timestampMatch) {
                errors.push(`Invalid timestamp format at line ${lineIndex}: ${line}`);
            } else {
                // Validate that start time is before end time
                const startTime = parseWebVTTTimestamp(timestampMatch[1]);
                const endTime = parseWebVTTTimestamp(timestampMatch[2]);
                
                if (startTime >= endTime) {
                    errors.push(`Start time must be before end time at line ${lineIndex}: ${line}`);
                }
            }
        } else if (inCue && line.trim() !== '') {
            // This is cue text - validate it's not empty and doesn't contain invalid characters
            if (line.includes('-->')) {
                errors.push(`Unexpected timestamp in cue text at line ${lineIndex}: ${line}`);
            }
        }
        
        // Reset cue state on empty line
        if (line.trim() === '') {
            inCue = false;
        }
    }
    
    // Check that we found at least one cue
    if (cueCount === 0) {
        errors.push('No valid WebVTT cues found');
    }
    
    // Check file size
    const contentSize = Buffer.byteLength(webvttContent, 'utf8');
    if (contentSize === 0) {
        errors.push('WebVTT content is empty');
    }
    
    return {
        isValid: errors.length === 0,
        errors,
        cueCount,
        contentSize
    };
}

/**
 * Parses WebVTT timestamp to milliseconds
 * @param {string} timestamp - WebVTT timestamp (HH:MM:SS.mmm)
 * @returns {number} Time in milliseconds
 */
function parseWebVTTTimestamp(timestamp) {
    const parts = timestamp.split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const secondsParts = parts[2].split('.');
    const seconds = parseInt(secondsParts[0], 10);
    const milliseconds = parseInt(secondsParts[1], 10);
    
    return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
}

/**
 * Uploads WebVTT file directly to S3 destination bucket
 * @param {S3Client} s3Client - S3 client instance
 * @param {string} bucket - Destination S3 bucket
 * @param {string} s3Key - S3 key for the file
 * @param {Object} webvttFile - WebVTT file object
 * @returns {Promise<Object>} Upload result with S3 location
 */
async function uploadWebVTTToS3(s3Client, bucket, s3Key, webvttFile) {
    try {
        const uploadParams = {
            Bucket: bucket,
            Key: s3Key,
            Body: webvttFile.content,
            ContentType: 'text/vtt',
            ContentDisposition: `attachment; filename="${webvttFile.filename}"`,
            Metadata: {
                language: webvttFile.language,
                checksum: webvttFile.checksum,
                generatedAt: new Date().toISOString()
            }
        };

        await s3Client.send(new PutObjectCommand(uploadParams));
        
        const s3Location = `s3://${bucket}/${s3Key}`;
        
        return {
            s3Location,
            s3Key,
            bucket,
            size: webvttFile.size,
            checksum: webvttFile.checksum,
            uploadedAt: new Date().toISOString()
        };
    } catch (err) {
        console.error(`Failed to upload WebVTT file to S3:`, err);
        throw err;
    }
}

/**
 * Updates WebVTT generation status in DynamoDB with simplified metadata
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} status - WebVTT generation status
 * @param {Array} uploadedFiles - Array of uploaded file information
 * @param {Object} additionalFields - Additional fields to update
 */
async function updateWebVTTStatusSimplified(docClient, guid, status, uploadedFiles = [], additionalFields = {}) {
    try {
        const updateExpression = ['SET subtitleWebvttStatus = :status'];
        const expressionAttributeValues = { ':status': status };

        // Add timestamp
        updateExpression.push('subtitleWebvttTimestamp = :timestamp');
        expressionAttributeValues[':timestamp'] = new Date().toISOString();

        // Store only the S3 URLs of the .vtt files (simplified metadata)
        if (uploadedFiles && uploadedFiles.length > 0) {
            const vttFileUrls = {};
            uploadedFiles.forEach(file => {
                if (file.language && file.s3Location) {
                    vttFileUrls[file.language] = file.s3Location;
                }
            });
            
            if (Object.keys(vttFileUrls).length > 0) {
                updateExpression.push('subtitleVttFiles = :vttFiles');
                expressionAttributeValues[':vttFiles'] = vttFileUrls;
            }
        }

        // Add additional fields
        Object.keys(additionalFields).forEach((key, index) => {
            const valueName = `:webvttValue${index}`;
            const fieldName = `subtitleWebvtt${key.charAt(0).toUpperCase() + key.slice(1)}`;
            
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
        console.log(`Updated WebVTT status for ${guid}: ${status}`);
        
    } catch (err) {
        console.error(`Failed to update WebVTT status for ${guid}:`, err);
        throw err;
    }
}
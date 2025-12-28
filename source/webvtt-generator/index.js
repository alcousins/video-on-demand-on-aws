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

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require('crypto');
const error = require('./lib/error.js');
const { 
    generateWebVTTFilename, 
    formatWebVTTTimestamp, 
    createWebVTTHeader,
    isLanguageSupported,
    SUPPORTED_LANGUAGES,
    generateCloudFrontUrl,
    generateSubtitleS3Key,
    WEBVTT_STATUS,
    createWebVTTStatusUpdate,
    createSubtitleErrorReport,
    logSubtitleError,
    shouldUseMemoryOptimization,
    getOptimalUploadStrategy,
    createOptimizedRetryConfig,
    SUBTITLE_ERROR_TYPES,
    PERFORMANCE_CONFIG
} = require('./subtitle-utils.js');

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
        validateInput(event);

        console.log(`Starting WebVTT generation for ${event.guid}`);

        // Update DynamoDB with generation start status
        await updateWebVTTStatus(docClient, event.guid, WEBVTT_STATUS.STARTING);

        // Generate WebVTT files for all translated languages
        const webvttFiles = await generateWebVTTFiles(event);

        if (webvttFiles.length === 0) {
            console.warn('No WebVTT files generated due to translation failures');
            
            // Update DynamoDB with completion status but no files
            await updateWebVTTStatus(docClient, event.guid, WEBVTT_STATUS.COMPLETED, []);

            // Return result indicating no files were generated
            const result = {
                ...event,
                webvttFiles: [],
                webvttGeneration: {
                    status: WEBVTT_STATUS.COMPLETED,
                    fileCount: 0,
                    languages: [],
                    message: 'No WebVTT files generated due to translation failures'
                }
            };

            return result;
        }

        console.log(`Generated ${webvttFiles.length} WebVTT files`);

        // Update status to uploading
        await updateWebVTTStatus(docClient, event.guid, WEBVTT_STATUS.UPLOADING);

        // Upload WebVTT files to S3
        const uploadedFiles = await uploadWebVTTFiles(s3Client, event, webvttFiles);

        console.log(`Successfully uploaded ${uploadedFiles.length} WebVTT files to S3`);

        // Update DynamoDB with file locations and completion status
        await updateWebVTTStatus(docClient, event.guid, WEBVTT_STATUS.COMPLETED, uploadedFiles);

        // Return the result with WebVTT file information
        const result = {
            ...event,
            webvttFiles: uploadedFiles,
            webvttGeneration: {
                status: WEBVTT_STATUS.COMPLETED,
                fileCount: uploadedFiles.length,
                languages: uploadedFiles.map(file => file.language)
            }
        };

        return result;

    } catch (err) {
        console.error('WebVTT Generator Lambda error:', err);
        
        // Create structured error report
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.WEBVTT_ERROR,
            err.message,
            {
                guid: event.guid,
                stage: 'webvtt-generation',
                errorMessage: err.message,
                stack: err.stack
            }
        );
        
        logSubtitleError(errorReport);
        
        // Update DynamoDB with error status
        try {
            await updateWebVTTStatus(docClient, event.guid, WEBVTT_STATUS.FAILED, null, err.message);
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }
        
        await error.handler(event, err);
        throw err;
    }
};

/**
 * Validates the input event structure
 * @param {Object} event - Lambda event object
 * @throws {Error} If input is invalid
 */
function validateInput(event) {
    if (!event.guid || typeof event.guid !== 'string') {
        throw new Error('Missing or invalid required parameter: guid');
    }

    if (!event.srcVideo || typeof event.srcVideo !== 'string') {
        throw new Error('Missing or invalid required parameter: srcVideo');
    }

    if (!event.destBucket || typeof event.destBucket !== 'string') {
        throw new Error('Missing or invalid required parameter: destBucket');
    }

    if (!event.translationReferences || !Array.isArray(event.translationReferences)) {
        throw new Error('Missing or invalid required parameter: translationReferences must be an array');
    }

    if (event.translationReferences.length === 0) {
        throw new Error('translationReferences array cannot be empty');
    }

    // Check if we have any successful translation references
    const hasValidReferences = event.translationReferences.some(ref => 
        ref.translationResult && 
        ref.translationResult.s3Location && 
        ref.translationResult.status === 'COMPLETED'
    );

    // If all translations failed, we should still continue but log a warning
    if (!hasValidReferences) {
        const failedCount = event.translationReferences.filter(ref => 
            ref.status === 'failed' || ref.error
        ).length;
        
        console.warn(`All ${failedCount} translation tasks failed. No WebVTT files will be generated.`);
        
        // Don't throw an error - let the function continue and return empty results
        // This allows the workflow to complete even if translations fail
    }
}

/**
 * Generates WebVTT files for all translated languages
 * @param {Object} event - Lambda event containing translation references
 * @returns {Promise<Array>} Array of WebVTT file objects
 */
async function generateWebVTTFiles(event) {
    const webvttFiles = [];
    const s3Client = new S3Client({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    // Count successful and failed translations
    const successfulRefs = event.translationReferences.filter(ref => 
        ref.translationResult && 
        ref.translationResult.s3Location && 
        ref.translationResult.status === 'COMPLETED'
    );
    
    const failedRefs = event.translationReferences.filter(ref => 
        ref.status === 'failed' || ref.error || !ref.translationResult
    );

    console.log(`Processing ${successfulRefs.length} successful translations, ${failedRefs.length} failed translations`);

    // Log failed translations for debugging
    if (failedRefs.length > 0) {
        console.warn('Failed translation references:', JSON.stringify(failedRefs, null, 2));
    }

    // Process each successful translation reference
    for (const translationRef of successfulRefs) {
        const targetLanguage = translationRef.translationResult.targetLanguage;
        
        if (!isLanguageSupported(targetLanguage)) {
            console.warn(`Skipping unsupported language: ${targetLanguage}`);
            continue;
        }

        console.log(`Retrieving translated segments for language: ${targetLanguage} from S3: ${translationRef.translationResult.s3Location}`);

        try {
            // Retrieve translated segments from S3
            const translatedSegments = await retrieveTranslatedSegments(s3Client, event, translationRef.translationResult.s3Location);
            
            const webvttContent = generateWebVTTContent(targetLanguage, translatedSegments);
            const filename = generateWebVTTFilename(event.srcVideo, targetLanguage);
            
            // Validate the generated WebVTT content
            validateWebVTTContent(webvttContent);

            const webvttFile = {
                language: targetLanguage,
                filename: filename,
                content: webvttContent,
                size: Buffer.byteLength(webvttContent, 'utf8'),
                checksum: crypto.createHash('md5').update(webvttContent, 'utf8').digest('hex')
            };

            webvttFiles.push(webvttFile);
            console.log(`Generated WebVTT file for ${targetLanguage}: ${filename} (${webvttFile.size} bytes)`);

        } catch (err) {
            console.error(`Failed to generate WebVTT for language ${targetLanguage}:`, err);
            // Continue with other languages instead of failing completely
        }
    }

    // Return empty array if no WebVTT files were generated (instead of throwing error)
    if (webvttFiles.length === 0) {
        console.warn('No WebVTT files were generated due to translation failures');
        return [];
    }

    return webvttFiles;
}

/**
 * Retrieves translated segments from S3
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {string} s3Key - S3 key where translated segments are stored
 * @returns {Promise<Array>} Array of translated segments
 */
async function retrieveTranslatedSegments(s3Client, event, s3Key) {
    try {
        console.log(`Retrieving translated segments from S3: s3://${event.destBucket}/${s3Key}`);
        
        const getObjectCommand = new GetObjectCommand({
            Bucket: event.destBucket,
            Key: s3Key
        });
        
        const response = await s3Client.send(getObjectCommand);
        const jsonContent = await streamToString(response.Body);
        
        const translationData = JSON.parse(jsonContent);
        
        if (!translationData.translatedSegments || !Array.isArray(translationData.translatedSegments)) {
            throw new Error('Invalid translation data format: missing translatedSegments array');
        }
        
        console.log(`Retrieved ${translationData.translatedSegments.length} translated segments for ${translationData.targetLanguage}`);
        
        return translationData.translatedSegments;
    } catch (err) {
        console.error(`Failed to retrieve translated segments from S3 (${s3Key}):`, err);
        throw new Error(`Failed to retrieve translated segments: ${err.message}`);
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
 * Generates WebVTT content for a specific language with memory optimization
 * @param {string} languageCode - Language code
 * @param {Array} translatedSegments - Array of translated text segments
 * @returns {string} WebVTT formatted content
 */
function generateWebVTTContent(languageCode, translatedSegments) {
    if (!translatedSegments || translatedSegments.length === 0) {
        throw new Error(`No translated segments provided for language: ${languageCode}`);
    }

    // Check if memory optimization is needed
    const totalLength = translatedSegments.reduce((sum, segment) => sum + (segment.text?.length || 0), 0);
    const averageLength = totalLength / translatedSegments.length;
    const useMemoryOptimization = shouldUseMemoryOptimization(translatedSegments.length, averageLength);
    
    console.log(`Generating WebVTT for ${languageCode}: ${translatedSegments.length} segments, avg length: ${Math.round(averageLength)}, memory optimization: ${useMemoryOptimization}`);

    if (useMemoryOptimization) {
        return generateWebVTTContentOptimized(languageCode, translatedSegments);
    } else {
        return generateWebVTTContentStandard(languageCode, translatedSegments);
    }
}

/**
 * Generates WebVTT content using standard approach for smaller files
 * @param {string} languageCode - Language code
 * @param {Array} translatedSegments - Array of translated text segments
 * @returns {string} WebVTT formatted content
 */
function generateWebVTTContentStandard(languageCode, translatedSegments) {
    // Start with WebVTT header
    let webvttContent = createWebVTTHeader(languageCode);

    // Add each text segment as a WebVTT cue
    translatedSegments.forEach((segment, index) => {
        // Validate segment structure
        if (typeof segment.startTime !== 'number' || typeof segment.endTime !== 'number') {
            throw new Error(`Invalid timing information in segment ${index} for language ${languageCode}`);
        }

        if (!segment.text || typeof segment.text !== 'string') {
            throw new Error(`Invalid text content in segment ${index} for language ${languageCode}`);
        }

        // Format timestamps
        const startTimestamp = formatWebVTTTimestamp(segment.startTime);
        const endTimestamp = formatWebVTTTimestamp(segment.endTime);

        // Clean and escape text content for WebVTT
        const cleanText = cleanTextForWebVTT(segment.text);

        // Add the cue to the WebVTT content
        webvttContent += `${index + 1}\n`;
        webvttContent += `${startTimestamp} --> ${endTimestamp}\n`;
        webvttContent += `${cleanText}\n\n`;
    });

    return webvttContent;
}

/**
 * Generates WebVTT content using memory-optimized approach for large files
 * @param {string} languageCode - Language code
 * @param {Array} translatedSegments - Array of translated text segments
 * @returns {string} WebVTT formatted content
 */
function generateWebVTTContentOptimized(languageCode, translatedSegments) {
    console.log(`Using memory-optimized WebVTT generation for ${translatedSegments.length} segments`);
    
    // Use array of strings and join at the end to reduce memory pressure
    const webvttParts = [];
    
    // Start with WebVTT header
    webvttParts.push(createWebVTTHeader(languageCode));

    const config = PERFORMANCE_CONFIG.WEBVTT_GENERATION;
    const yieldThreshold = config.MAX_SEGMENTS_PER_YIELD;
    
    // Process segments in chunks to avoid blocking the event loop
    for (let i = 0; i < translatedSegments.length; i += yieldThreshold) {
        const chunk = translatedSegments.slice(i, i + yieldThreshold);
        
        for (let j = 0; j < chunk.length; j++) {
            const segment = chunk[j];
            const segmentIndex = i + j;
            
            // Validate segment structure
            if (typeof segment.startTime !== 'number' || typeof segment.endTime !== 'number') {
                throw new Error(`Invalid timing information in segment ${segmentIndex} for language ${languageCode}`);
            }

            if (!segment.text || typeof segment.text !== 'string') {
                throw new Error(`Invalid text content in segment ${segmentIndex} for language ${languageCode}`);
            }

            // Format timestamps
            const startTimestamp = formatWebVTTTimestamp(segment.startTime);
            const endTimestamp = formatWebVTTTimestamp(segment.endTime);

            // Clean and escape text content for WebVTT
            const cleanText = cleanTextForWebVTT(segment.text);

            // Add the cue parts
            webvttParts.push(`${segmentIndex + 1}\n`);
            webvttParts.push(`${startTimestamp} --> ${endTimestamp}\n`);
            webvttParts.push(`${cleanText}\n\n`);
        }
        
        // Progress reporting for large files
        if (translatedSegments.length > yieldThreshold * 2) {
            const progress = Math.round(((i + chunk.length) / translatedSegments.length) * 100);
            console.log(`WebVTT generation progress: ${progress}% (${i + chunk.length}/${translatedSegments.length} segments)`);
        }
    }

    // Join all parts efficiently
    const webvttContent = webvttParts.join('');
    
    // Check final file size
    const fileSizeBytes = Buffer.byteLength(webvttContent, 'utf8');
    if (fileSizeBytes > config.MAX_FILE_SIZE_BYTES) {
        console.warn(`Generated WebVTT file is very large: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
    }
    
    console.log(`WebVTT generation completed: ${Math.round(fileSizeBytes / 1024)}KB for ${translatedSegments.length} segments`);
    
    return webvttContent;
}

/**
 * Cleans and escapes text content for WebVTT format
 * @param {string} text - Raw text content
 * @returns {string} Cleaned text suitable for WebVTT
 */
function cleanTextForWebVTT(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }

    // Remove or replace characters that could break WebVTT format
    let cleanText = text
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
        // Remove control characters except newlines and tabs
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Escape WebVTT special characters
        .replace(/-->/g, '→')  // Replace WebVTT timestamp separator
        .replace(/^NOTE\s/gm, 'Note: ')  // Escape NOTE keyword at line start
        .replace(/^WEBVTT/gm, 'WebVTT')  // Escape WEBVTT keyword at line start
        // Handle line breaks - WebVTT supports line breaks within cues
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

    // Ensure text doesn't exceed reasonable length for a single cue
    if (cleanText.length > 500) {
        console.warn(`Text segment is very long (${cleanText.length} characters), truncating`);
        cleanText = cleanText.substring(0, 497) + '...';
    }

    return cleanText;
}

/**
 * Validates WebVTT content format
 * @param {string} webvttContent - WebVTT content to validate
 * @throws {Error} If content is invalid
 */
function validateWebVTTContent(webvttContent) {
    if (!webvttContent || typeof webvttContent !== 'string') {
        throw new Error('WebVTT content must be a non-empty string');
    }

    // Check that content starts with WEBVTT header
    if (!webvttContent.startsWith('WEBVTT')) {
        throw new Error('WebVTT content must start with WEBVTT header');
    }

    // Check for basic WebVTT structure
    const lines = webvttContent.split('\n');
    let hasCues = false;
    let inCue = false;
    let cueCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip empty lines and header
        if (line === '' || line.startsWith('WEBVTT') || line.startsWith('Kind:') || 
            line.startsWith('Language:') || line.startsWith('NOTE')) {
            continue;
        }

        // Check for timestamp line (cue timing)
        if (line.includes('-->')) {
            const timestampRegex = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}$/;
            if (!timestampRegex.test(line)) {
                throw new Error(`Invalid timestamp format at line ${i + 1}: ${line}`);
            }
            inCue = true;
            hasCues = true;
            continue;
        }

        // Check for cue identifier (optional number before timestamp)
        if (/^\d+$/.test(line) && i + 1 < lines.length && lines[i + 1].includes('-->')) {
            cueCount++;
            continue;
        }

        // If we're in a cue, this should be cue text
        if (inCue && line !== '') {
            // Validate that cue text doesn't contain forbidden patterns
            if (line.includes('-->') && !line.includes('→')) {
                throw new Error(`Cue text contains forbidden timestamp separator at line ${i + 1}`);
            }
            inCue = false; // End of cue text
        }
    }

    if (!hasCues) {
        throw new Error('WebVTT content must contain at least one cue');
    }

    // Validate UTF-8 encoding by checking for replacement characters
    if (webvttContent.includes('\uFFFD')) {
        throw new Error('WebVTT content contains invalid UTF-8 characters');
    }

    console.log(`WebVTT validation passed: ${cueCount} cues found`);
}

/**
 * Uploads WebVTT files to S3 with performance optimizations
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {Array} webvttFiles - Array of WebVTT file objects
 * @returns {Promise<Array>} Array of uploaded file information
 */
async function uploadWebVTTFiles(s3Client, event, webvttFiles) {
    const uploadedFiles = [];
    
    // Calculate total file size for upload strategy optimization
    const totalSize = webvttFiles.reduce((sum, file) => sum + file.size, 0);
    const uploadStrategy = getOptimalUploadStrategy(totalSize, webvttFiles.length);
    
    console.log(`Uploading ${webvttFiles.length} WebVTT files (${Math.round(totalSize / 1024)}KB total) with strategy:`, {
        useMultipart: uploadStrategy.useMultipart,
        maxConcurrent: uploadStrategy.maxConcurrent,
        retryConfig: uploadStrategy.retryConfig
    });

    // Process uploads with controlled concurrency
    const uploadPromises = webvttFiles.map(async (webvttFile, index) => {
        // Add stagger to avoid overwhelming S3
        if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, index * 100)); // 100ms stagger
        }
        
        return uploadSingleFileWithRetry(s3Client, event, webvttFile, uploadStrategy);
    });

    // Execute uploads with controlled concurrency
    const results = await Promise.allSettled(uploadPromises);
    
    // Process results and collect successful uploads
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            uploadedFiles.push(result.value);
        } else {
            console.error(`Failed to upload WebVTT file for ${webvttFiles[index].language}:`, result.reason);
        }
    });

    if (uploadedFiles.length === 0) {
        throw new Error('Failed to upload any WebVTT files to S3');
    }

    // Log upload performance metrics
    const successRate = (uploadedFiles.length / webvttFiles.length * 100).toFixed(1);
    console.log(`Upload completed: ${uploadedFiles.length}/${webvttFiles.length} files (${successRate}% success rate)`);

    return uploadedFiles;
}

/**
 * Uploads a single WebVTT file with retry logic and performance optimization
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {Object} webvttFile - WebVTT file object
 * @param {Object} uploadStrategy - Upload strategy configuration
 * @returns {Promise<Object>} Uploaded file information
 */
async function uploadSingleFileWithRetry(s3Client, event, webvttFile, uploadStrategy) {
    const retryConfig = uploadStrategy.retryConfig;
    let lastError;
    
    for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
        try {
            return await uploadSingleFile(s3Client, event, webvttFile, uploadStrategy);
        } catch (err) {
            lastError = err;
            
            // Don't retry certain types of errors
            if (err.name === 'NoSuchBucket' || err.name === 'AccessDenied') {
                throw err;
            }
            
            const delay = Math.min(
                retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt),
                retryConfig.maxDelayMs
            );
            
            if (attempt < retryConfig.maxAttempts - 1) {
                console.warn(`Upload attempt ${attempt + 1} failed for ${webvttFile.language}, retrying in ${delay}ms:`, err.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

/**
 * Uploads a single WebVTT file to S3
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @param {Object} webvttFile - WebVTT file object
 * @param {Object} uploadStrategy - Upload strategy configuration
 * @returns {Promise<Object>} Uploaded file information
 */
async function uploadSingleFile(s3Client, event, webvttFile, uploadStrategy) {
    // Generate S3 key following the same pattern as video files
    const s3Key = generateS3Key(event.guid, webvttFile.filename);
    
    console.log(`Uploading WebVTT file: ${webvttFile.filename} to s3://${event.destBucket}/${s3Key} (${Math.round(webvttFile.size / 1024)}KB)`);

    const uploadParams = {
        Bucket: event.destBucket,
        Key: s3Key,
        Body: webvttFile.content,
        ContentType: 'text/vtt',
        ContentEncoding: 'utf-8',
        CacheControl: 'public, max-age=31536000', // 1 year cache for subtitle files
        Metadata: {
            'language': webvttFile.language,
            'guid': event.guid,
            'checksum': webvttFile.checksum,
            'generated-by': 'video-on-demand-webvtt-generator',
            'file-size': webvttFile.size.toString(),
            'generation-timestamp': new Date().toISOString()
        }
    };

    // Use multipart upload for large files if strategy recommends it
    if (uploadStrategy.useMultipart && webvttFile.size > uploadStrategy.partSize) {
        console.log(`Using multipart upload for large file: ${webvttFile.filename}`);
        // Note: For simplicity, we'll use the standard PutObject for now
        // In production, you might want to implement multipart upload for very large subtitle files
    }

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    const s3Location = `s3://${event.destBucket}/${s3Key}`;
    
    // Generate CloudFront URL if CloudFront domain is available
    let cloudFrontUrl = null;
    if (process.env.CloudFront) {
        try {
            cloudFrontUrl = generateCloudFrontUrl(process.env.CloudFront, s3Key);
        } catch (err) {
            console.warn(`Failed to generate CloudFront URL for ${s3Key}:`, err.message);
        }
    }
    
    const uploadedFile = {
        language: webvttFile.language,
        filename: webvttFile.filename,
        s3Location: s3Location,
        s3Key: s3Key,
        cloudFrontUrl: cloudFrontUrl,
        size: webvttFile.size,
        checksum: webvttFile.checksum
    };

    console.log(`Successfully uploaded WebVTT file for ${webvttFile.language}: ${s3Location}`);
    return uploadedFile;
}

/**
 * Generates S3 key for WebVTT file following the same pattern as video files
 * @param {string} guid - Video processing job GUID
 * @param {string} filename - WebVTT filename
 * @returns {string} S3 key
 */
function generateS3Key(guid, filename) {
    return generateSubtitleS3Key(guid, filename);
}

/**
 * Updates WebVTT generation status in DynamoDB using shared utilities
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} status - WebVTT generation status
 * @param {Array} uploadedFiles - Array of uploaded file information (optional)
 * @param {string} errorDetails - Error details (optional)
 */
async function updateWebVTTStatus(docClient, guid, status, uploadedFiles = null, errorDetails = null) {
    if (!guid) {
        console.warn('Cannot update WebVTT status: missing GUID');
        return;
    }

    try {
        const updateParams = createWebVTTStatusUpdate(status, uploadedFiles, errorDetails);
        
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            ...updateParams
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated WebVTT status for ${guid}: ${status}`);
    } catch (err) {
        console.error(`Failed to update WebVTT status for ${guid}:`, err);
        // Don't throw here - status update failure shouldn't fail the generation
    }
}
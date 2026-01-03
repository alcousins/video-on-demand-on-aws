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
 * S3 storage utilities for subtitle file pipeline and MediaConvert integration
 */

const { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { 
    generateSubtitleS3Key,
    generateCloudFrontUrl,
    getOptimalUploadStrategy,
    PERFORMANCE_CONFIG,
    SUBTITLE_ERROR_TYPES,
    createSubtitleErrorReport,
    logSubtitleError
} = require('./subtitle-utils.js');

/**
 * S3 storage configuration for subtitle files
 */
const STORAGE_CONFIG = {
    // Temporary storage configuration
    TEMP_STORAGE: {
        PREFIX: 'temp/subtitles',
        RETENTION_HOURS: 24, // Clean up temp files after 24 hours
        CONTENT_TYPE: 'text/vtt',
        CONTENT_ENCODING: 'utf-8'
    },
    
    // Final storage configuration (follows existing video file patterns)
    FINAL_STORAGE: {
        PREFIX: 'subtitles', // Will be under {guid}/subtitles/
        CONTENT_TYPE: 'text/vtt',
        CONTENT_ENCODING: 'utf-8'
    },
    
    // File naming patterns
    NAMING: {
        TEMP_PATTERN: '{guid}/temp/{filename}',
        FINAL_PATTERN: '{guid}/subtitles/{filename}',
        BACKUP_PATTERN: '{guid}/subtitles/backup/{filename}'
    },
    
    // Storage classes and lifecycle
    LIFECYCLE: {
        TEMP_STORAGE_CLASS: 'STANDARD',
        FINAL_STORAGE_CLASS: 'STANDARD_IA', // Infrequent access for subtitle files
        ARCHIVE_AFTER_DAYS: 90
    }
};

/**
 * Creates S3 client with optimized configuration for subtitle processing
 * @param {string} region - AWS region
 * @param {string} solutionIdentifier - Solution identifier for user agent
 * @returns {S3Client} Configured S3 client
 */
function createOptimizedS3Client(region, solutionIdentifier) {
    return new S3Client({
        region: region,
        customUserAgent: solutionIdentifier,
        maxAttempts: 5,
        retryMode: 'adaptive'
    });
}

/**
 * Generates temporary S3 key for subtitle file during processing
 * @param {string} guid - Video processing job GUID
 * @param {string} filename - Subtitle filename
 * @returns {string} Temporary S3 key
 */
function generateTempSubtitleKey(guid, filename) {
    if (!guid || !filename) {
        throw new Error('GUID and filename are required for temporary S3 key generation');
    }
    
    // Sanitize filename for S3 compatibility
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    return `${STORAGE_CONFIG.TEMP_STORAGE.PREFIX}/${guid}/${sanitizedFilename}`;
}

/**
 * Generates final S3 key for subtitle file in destination bucket
 * @param {string} guid - Video processing job GUID
 * @param {string} filename - Subtitle filename
 * @returns {string} Final S3 key
 */
function generateFinalSubtitleKey(guid, filename) {
    if (!guid || !filename) {
        throw new Error('GUID and filename are required for final S3 key generation');
    }
    
    // Use the existing generateSubtitleS3Key function for consistency
    return generateSubtitleS3Key(guid, filename);
}

/**
 * Uploads subtitle file to temporary S3 location with optimized settings
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} bucket - S3 bucket name
 * @param {string} guid - Video processing job GUID
 * @param {Object} subtitleFile - Subtitle file object with content and metadata
 * @returns {Promise<Object>} Upload result with S3 location and metadata
 */
async function uploadSubtitleToTempStorage(s3Client, bucket, guid, subtitleFile) {
    try {
        if (!subtitleFile || !subtitleFile.content || !subtitleFile.filename) {
            throw new Error('Invalid subtitle file object: missing content or filename');
        }

        const tempKey = generateTempSubtitleKey(guid, subtitleFile.filename);
        const uploadStrategy = getOptimalUploadStrategy(subtitleFile.size || Buffer.byteLength(subtitleFile.content, 'utf8'), 1);
        
        console.log(`Uploading subtitle file to temporary storage: s3://${bucket}/${tempKey}`);

        // Prepare upload parameters with metadata
        const uploadParams = {
            Bucket: bucket,
            Key: tempKey,
            Body: Buffer.from(subtitleFile.content, 'utf8'),
            ContentType: STORAGE_CONFIG.TEMP_STORAGE.CONTENT_TYPE,
            ContentEncoding: STORAGE_CONFIG.TEMP_STORAGE.CONTENT_ENCODING,
            ContentLanguage: subtitleFile.language,
            StorageClass: STORAGE_CONFIG.LIFECYCLE.TEMP_STORAGE_CLASS,
            Metadata: {
                'original-filename': subtitleFile.filename,
                'language': subtitleFile.language,
                'guid': guid,
                'processing-stage': 'temporary',
                'upload-timestamp': new Date().toISOString(),
                'content-checksum': subtitleFile.checksum || 'unknown',
                'generated-by': 'video-on-demand-subtitle-processor'
            },
            // Add lifecycle tags for automatic cleanup
            Tagging: `guid=${guid}&stage=temporary&language=${subtitleFile.language}&cleanup-after=${new Date(Date.now() + STORAGE_CONFIG.TEMP_STORAGE.RETENTION_HOURS * 60 * 60 * 1000).toISOString()}`
        };

        // Execute upload with retry logic
        await executeS3OperationWithRetry(
            s3Client,
            new PutObjectCommand(uploadParams),
            uploadStrategy.retryConfig,
            `upload temp subtitle ${subtitleFile.language}`
        );

        const s3Location = `s3://${bucket}/${tempKey}`;
        
        console.log(`Successfully uploaded subtitle file for ${subtitleFile.language} to temporary storage: ${s3Location}`);

        return {
            language: subtitleFile.language,
            filename: subtitleFile.filename,
            tempS3Key: tempKey,
            tempS3Location: s3Location,
            size: subtitleFile.size || Buffer.byteLength(subtitleFile.content, 'utf8'),
            checksum: subtitleFile.checksum,
            uploadTimestamp: new Date().toISOString()
        };

    } catch (err) {
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.STORAGE_ERROR,
            `Failed to upload subtitle file to temporary storage: ${err.message}`,
            {
                guid: guid,
                stage: 'temp-upload',
                language: subtitleFile.language,
                filename: subtitleFile.filename,
                bucket: bucket
            }
        );
        
        logSubtitleError(errorReport);
        throw err;
    }
}

/**
 * Copies subtitle files from temporary to final destination during MediaConvert processing
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} sourceBucket - Source bucket (temporary storage)
 * @param {string} destBucket - Destination bucket (final storage)
 * @param {string} guid - Video processing job GUID
 * @param {Array} tempSubtitleFiles - Array of temporary subtitle file objects
 * @returns {Promise<Array>} Array of final subtitle file locations
 */
async function copySubtitlesToFinalDestination(s3Client, sourceBucket, destBucket, guid, tempSubtitleFiles) {
    try {
        if (!tempSubtitleFiles || tempSubtitleFiles.length === 0) {
            console.log('No temporary subtitle files to copy to final destination');
            return [];
        }

        console.log(`Copying ${tempSubtitleFiles.length} subtitle files from temporary to final destination`);

        const copyPromises = tempSubtitleFiles.map(async (tempFile) => {
            try {
                const finalKey = generateFinalSubtitleKey(guid, tempFile.filename);
                const copySource = `${sourceBucket}/${tempFile.tempS3Key}`;
                
                console.log(`Copying subtitle file: ${copySource} -> s3://${destBucket}/${finalKey}`);

                // Copy with updated metadata for final storage
                const copyParams = {
                    Bucket: destBucket,
                    Key: finalKey,
                    CopySource: copySource,
                    StorageClass: STORAGE_CONFIG.LIFECYCLE.FINAL_STORAGE_CLASS,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'original-filename': tempFile.filename,
                        'language': tempFile.language,
                        'guid': guid,
                        'processing-stage': 'final',
                        'temp-upload-timestamp': tempFile.uploadTimestamp,
                        'final-copy-timestamp': new Date().toISOString(),
                        'content-checksum': tempFile.checksum || 'unknown',
                        'generated-by': 'video-on-demand-subtitle-processor'
                    },
                    ContentType: STORAGE_CONFIG.FINAL_STORAGE.CONTENT_TYPE,
                    ContentEncoding: STORAGE_CONFIG.FINAL_STORAGE.CONTENT_ENCODING,
                    ContentLanguage: tempFile.language,
                    // Add lifecycle tags for final storage
                    TaggingDirective: 'REPLACE',
                    Tagging: `guid=${guid}&stage=final&language=${tempFile.language}&video-processing=completed`
                };

                await executeS3OperationWithRetry(
                    s3Client,
                    new CopyObjectCommand(copyParams),
                    PERFORMANCE_CONFIG.S3_UPLOAD.RETRY_CONFIG,
                    `copy subtitle ${tempFile.language} to final destination`
                );

                const finalS3Location = `s3://${destBucket}/${finalKey}`;
                
                console.log(`Successfully copied subtitle file for ${tempFile.language} to final destination: ${finalS3Location}`);

                return {
                    language: tempFile.language,
                    filename: tempFile.filename,
                    finalS3Key: finalKey,
                    finalS3Location: finalS3Location,
                    tempS3Location: tempFile.tempS3Location,
                    size: tempFile.size,
                    checksum: tempFile.checksum,
                    copyTimestamp: new Date().toISOString()
                };

            } catch (err) {
                console.error(`Failed to copy subtitle file for ${tempFile.language}:`, err);
                
                const errorReport = createSubtitleErrorReport(
                    SUBTITLE_ERROR_TYPES.STORAGE_ERROR,
                    `Failed to copy subtitle file to final destination: ${err.message}`,
                    {
                        guid: guid,
                        stage: 'final-copy',
                        language: tempFile.language,
                        filename: tempFile.filename,
                        sourceBucket: sourceBucket,
                        destBucket: destBucket
                    }
                );
                
                logSubtitleError(errorReport);
                
                // Return error result instead of throwing to allow other files to continue
                return {
                    language: tempFile.language,
                    filename: tempFile.filename,
                    error: err.message,
                    copyFailed: true
                };
            }
        });

        const copyResults = await Promise.all(copyPromises);
        
        // Separate successful and failed copies
        const successfulCopies = copyResults.filter(result => !result.copyFailed);
        const failedCopies = copyResults.filter(result => result.copyFailed);

        if (failedCopies.length > 0) {
            console.warn(`${failedCopies.length} subtitle files failed to copy to final destination:`, 
                failedCopies.map(f => `${f.language}: ${f.error}`));
        }

        console.log(`Successfully copied ${successfulCopies.length} subtitle files to final destination`);
        
        return successfulCopies;

    } catch (err) {
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.STORAGE_ERROR,
            `Failed to copy subtitle files to final destination: ${err.message}`,
            {
                guid: guid,
                stage: 'final-copy-batch',
                fileCount: tempSubtitleFiles.length,
                sourceBucket: sourceBucket,
                destBucket: destBucket
            }
        );
        
        logSubtitleError(errorReport);
        throw err;
    }
}

/**
 * Generates CloudFront URLs for subtitle files to ensure accessibility
 * @param {string} cloudFrontDomain - CloudFront distribution domain
 * @param {Array} finalSubtitleFiles - Array of final subtitle file objects
 * @returns {Array} Array of subtitle files with CloudFront URLs
 */
function generateSubtitleCloudFrontUrls(cloudFrontDomain, finalSubtitleFiles) {
    try {
        if (!cloudFrontDomain || !finalSubtitleFiles || finalSubtitleFiles.length === 0) {
            console.log('No CloudFront domain or subtitle files provided for URL generation');
            return finalSubtitleFiles || [];
        }

        console.log(`Generating CloudFront URLs for ${finalSubtitleFiles.length} subtitle files`);

        return finalSubtitleFiles.map(file => {
            try {
                // Extract S3 key from S3 location
                const s3Key = file.finalS3Key || file.finalS3Location?.replace(/^s3:\/\/[^\/]+\//, '');
                
                if (!s3Key) {
                    console.warn(`No S3 key found for subtitle file: ${file.language}`);
                    return file;
                }

                const cloudFrontUrl = generateCloudFrontUrl(cloudFrontDomain, s3Key);
                
                console.log(`Generated CloudFront URL for ${file.language}: ${cloudFrontUrl}`);

                return {
                    ...file,
                    cloudFrontUrl: cloudFrontUrl,
                    publicUrl: cloudFrontUrl // Alias for compatibility
                };

            } catch (err) {
                console.error(`Failed to generate CloudFront URL for ${file.language}:`, err);
                return file; // Return original file without CloudFront URL
            }
        });

    } catch (err) {
        console.error('Failed to generate CloudFront URLs for subtitle files:', err);
        return finalSubtitleFiles; // Return original files without CloudFront URLs
    }
}

/**
 * Cleans up temporary subtitle files after successful processing
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} bucket - S3 bucket containing temporary files
 * @param {Array} tempSubtitleFiles - Array of temporary subtitle file objects
 * @returns {Promise<Object>} Cleanup result summary
 */
async function cleanupTempSubtitleFiles(s3Client, bucket, tempSubtitleFiles) {
    try {
        if (!tempSubtitleFiles || tempSubtitleFiles.length === 0) {
            console.log('No temporary subtitle files to clean up');
            return { deletedCount: 0, failedCount: 0 };
        }

        console.log(`Cleaning up ${tempSubtitleFiles.length} temporary subtitle files`);

        const deletePromises = tempSubtitleFiles.map(async (tempFile) => {
            try {
                const deleteParams = {
                    Bucket: bucket,
                    Key: tempFile.tempS3Key
                };

                await executeS3OperationWithRetry(
                    s3Client,
                    new DeleteObjectCommand(deleteParams),
                    { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2 },
                    `delete temp subtitle ${tempFile.language}`
                );

                console.log(`Deleted temporary subtitle file: s3://${bucket}/${tempFile.tempS3Key}`);
                return { language: tempFile.language, deleted: true };

            } catch (err) {
                console.warn(`Failed to delete temporary subtitle file for ${tempFile.language}:`, err);
                return { language: tempFile.language, deleted: false, error: err.message };
            }
        });

        const deleteResults = await Promise.all(deletePromises);
        
        const deletedCount = deleteResults.filter(result => result.deleted).length;
        const failedCount = deleteResults.filter(result => !result.deleted).length;

        console.log(`Cleanup completed: ${deletedCount} files deleted, ${failedCount} files failed to delete`);

        return {
            deletedCount,
            failedCount,
            results: deleteResults
        };

    } catch (err) {
        console.error('Failed to clean up temporary subtitle files:', err);
        return { deletedCount: 0, failedCount: tempSubtitleFiles.length, error: err.message };
    }
}

/**
 * Validates that subtitle files exist and are accessible in S3
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} bucket - S3 bucket name
 * @param {Array} subtitleFiles - Array of subtitle file objects to validate
 * @returns {Promise<Object>} Validation result with accessible and inaccessible files
 */
async function validateSubtitleFileAccess(s3Client, bucket, subtitleFiles) {
    try {
        if (!subtitleFiles || subtitleFiles.length === 0) {
            return { accessibleFiles: [], inaccessibleFiles: [], totalChecked: 0 };
        }

        console.log(`Validating access to ${subtitleFiles.length} subtitle files in S3`);

        const validationPromises = subtitleFiles.map(async (file) => {
            try {
                const s3Key = file.finalS3Key || file.tempS3Key;
                if (!s3Key) {
                    return { ...file, accessible: false, error: 'No S3 key found' };
                }

                const headParams = {
                    Bucket: bucket,
                    Key: s3Key
                };

                const headResult = await s3Client.send(new HeadObjectCommand(headParams));
                
                console.log(`Subtitle file accessible: s3://${bucket}/${s3Key} (${headResult.ContentLength} bytes)`);

                return {
                    ...file,
                    accessible: true,
                    contentLength: headResult.ContentLength,
                    lastModified: headResult.LastModified,
                    contentType: headResult.ContentType
                };

            } catch (err) {
                console.warn(`Subtitle file not accessible: ${file.language} - ${err.message}`);
                return { ...file, accessible: false, error: err.message };
            }
        });

        const validationResults = await Promise.all(validationPromises);
        
        const accessibleFiles = validationResults.filter(result => result.accessible);
        const inaccessibleFiles = validationResults.filter(result => !result.accessible);

        console.log(`Validation completed: ${accessibleFiles.length} accessible, ${inaccessibleFiles.length} inaccessible`);

        return {
            accessibleFiles,
            inaccessibleFiles,
            totalChecked: validationResults.length
        };

    } catch (err) {
        console.error('Failed to validate subtitle file access:', err);
        throw err;
    }
}

/**
 * Executes S3 operation with retry logic and error handling
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} command - AWS SDK command to execute
 * @param {Object} retryConfig - Retry configuration
 * @param {string} operationName - Name of operation for logging
 * @returns {Promise<Object>} Operation result
 */
async function executeS3OperationWithRetry(s3Client, command, retryConfig, operationName) {
    const maxAttempts = retryConfig.maxAttempts || 3;
    const initialDelay = retryConfig.initialDelayMs || 1000;
    const backoffMultiplier = retryConfig.backoffMultiplier || 2;
    const maxDelay = retryConfig.maxDelayMs || 30000;

    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`Executing S3 operation: ${operationName} (attempt ${attempt}/${maxAttempts})`);
            
            const result = await s3Client.send(command);
            
            if (attempt > 1) {
                console.log(`S3 operation succeeded on retry: ${operationName}`);
            }
            
            return result;

        } catch (err) {
            lastError = err;
            console.warn(`S3 operation attempt ${attempt} failed for ${operationName}:`, err.message);

            // Don't retry on certain errors
            if (err.name === 'NoSuchBucket' || err.name === 'AccessDenied' || err.name === 'InvalidBucketName') {
                throw err;
            }

            // Wait before retry (except on last attempt)
            if (attempt < maxAttempts) {
                const delay = Math.min(
                    initialDelay * Math.pow(backoffMultiplier, attempt - 1),
                    maxDelay
                );
                
                console.log(`Retrying S3 operation in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`S3 operation failed after ${maxAttempts} attempts: ${operationName} - ${lastError?.message}`);
}

/**
 * Creates MediaConvert-compatible subtitle file references for job configuration
 * @param {Array} finalSubtitleFiles - Array of final subtitle file objects
 * @returns {Object} MediaConvert subtitle file configuration
 */
function createMediaConvertSubtitleConfig(finalSubtitleFiles) {
    try {
        if (!finalSubtitleFiles || finalSubtitleFiles.length === 0) {
            return {};
        }

        console.log(`Creating MediaConvert subtitle configuration for ${finalSubtitleFiles.length} files`);

        const subtitleConfig = {};
        
        finalSubtitleFiles.forEach(file => {
            if (file.finalS3Location && file.language) {
                subtitleConfig[file.language] = file.finalS3Location;
                console.log(`Added subtitle file to MediaConvert config: ${file.language} -> ${file.finalS3Location}`);
            }
        });

        return subtitleConfig;

    } catch (err) {
        console.error('Failed to create MediaConvert subtitle configuration:', err);
        return {};
    }
}

/**
 * Stores JSON data in S3 for large payload handling
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key
 * @param {Object} data - JSON data to store
 * @param {Object} options - Storage options
 * @returns {Promise<Object>} Storage result with S3 location
 */
async function storeJsonDataInS3(s3Client, bucket, key, data, options = {}) {
    try {
        const jsonContent = JSON.stringify(data, null, 2);
        
        const uploadParams = {
            Bucket: bucket,
            Key: key,
            Body: jsonContent,
            ContentType: 'application/json',
            ContentEncoding: 'utf-8',
            StorageClass: options.storageClass || 'STANDARD',
            Metadata: {
                'data-type': options.dataType || 'subtitle-processing',
                'created-at': new Date().toISOString(),
                'guid': options.guid || 'unknown',
                'stage': options.stage || 'unknown'
            }
        };

        await executeS3OperationWithRetry(
            s3Client,
            new PutObjectCommand(uploadParams),
            { maxAttempts: 3, baseDelay: 1000 },
            `store JSON data ${key}`
        );

        const s3Location = `s3://${bucket}/${key}`;
        console.log(`Successfully stored JSON data in S3: ${s3Location}`);

        return {
            success: true,
            s3Location,
            bucket,
            key,
            size: jsonContent.length,
            contentType: 'application/json'
        };

    } catch (err) {
        console.error(`Failed to store JSON data in S3 (${bucket}/${key}):`, err);
        throw new Error(`S3 JSON storage failed: ${err.message}`);
    }
}

/**
 * Retrieves JSON data from S3
 * @param {S3Client} s3Client - AWS S3 client
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key
 * @returns {Promise<Object>} Retrieved JSON data
 */
async function getJsonDataFromS3(s3Client, bucket, key) {
    try {
        const { GetObjectCommand } = require("@aws-sdk/client-s3");
        
        const getObjectCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: key
        });

        const response = await executeS3OperationWithRetry(
            s3Client,
            getObjectCommand,
            { maxAttempts: 3, baseDelay: 1000 },
            `retrieve JSON data ${key}`
        );

        const jsonContent = await streamToString(response.Body);
        const data = JSON.parse(jsonContent);

        console.log(`Successfully retrieved JSON data from S3: s3://${bucket}/${key}`);
        return data;

    } catch (err) {
        console.error(`Failed to retrieve JSON data from S3 (${bucket}/${key}):`, err);
        throw new Error(`S3 JSON retrieval failed: ${err.message}`);
    }
}

/**
 * Generates S3 key for storing transcription results
 * @param {string} guid - Video processing job GUID
 * @returns {string} S3 key for transcription results
 */
function generateTranscriptionResultsKey(guid) {
    return `${guid}/transcription/results.json`;
}

/**
 * Generates S3 key for storing translation tasks
 * @param {string} guid - Video processing job GUID
 * @param {string} taskId - Translation task ID
 * @returns {string} S3 key for translation task
 */
function generateTranslationTaskKey(guid, taskId) {
    return `${guid}/translation/tasks/${taskId}.json`;
}

/**
 * Generates S3 key for storing translation results
 * @param {string} guid - Video processing job GUID
 * @param {string} taskId - Translation task ID
 * @returns {string} S3 key for translation results
 */
function generateTranslationResultsKey(guid, taskId) {
    return `${guid}/translation/results/${taskId}.json`;
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

module.exports = {
    STORAGE_CONFIG,
    createOptimizedS3Client,
    generateTempSubtitleKey,
    generateFinalSubtitleKey,
    uploadSubtitleToTempStorage,
    copySubtitlesToFinalDestination,
    generateSubtitleCloudFrontUrls,
    cleanupTempSubtitleFiles,
    validateSubtitleFileAccess,
    executeS3OperationWithRetry,
    createMediaConvertSubtitleConfig,
    // New JSON storage functions
    storeJsonDataInS3,
    getJsonDataFromS3,
    generateTranscriptionResultsKey,
    generateTranslationTaskKey,
    generateTranslationResultsKey
};
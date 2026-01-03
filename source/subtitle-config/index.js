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

const { S3 } = require("@aws-sdk/client-s3");
const error = require('./lib/error.js');
const {
    buildSubtitleConfig,
    validateAndNormalizeSubtitleConfig,
    isVideoFormatSupported,
    createSubtitleErrorReport,
    logSubtitleError,
    SUBTITLE_ERROR_TYPES,
    CONFIGURABLE_SUBTITLE_KEYS
} = require('./subtitle-utils.js');
const { 
    SubtitleErrorHandler,
    handleSubtitleError,
    createRetryWrapper
} = require('./subtitle-error-handler.js');

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    // Create correlation ID for error tracking
    const correlationId = SubtitleErrorHandler.getOrCreateCorrelationId(event, 'configuration');
    console.log(`Processing subtitle configuration with correlation ID: ${correlationId}`);

    const s3 = new S3({ customUserAgent: process.env.SOLUTION_IDENTIFIER });

    try {
        // Validate input event
        if (!event.guid) {
            throw new Error('Missing required field: guid');
        }

        if (!event.srcVideo) {
            throw new Error('Missing required field: srcVideo');
        }

        // Check if video format is supported for transcription
        if (!isVideoFormatSupported(event.srcVideo)) {
            console.log(`Video format not supported for transcription: ${event.srcVideo}`);
            // Return event with subtitle processing disabled
            return {
                ...event,
                correlationId,
                subtitleConfig: {
                    enabled: false,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en'],
                    reason: 'unsupported_video_format'
                }
            };
        }

        // Build subtitle configuration from environment variables
        let subtitleConfig = buildSubtitleConfig();

        // Apply metadata file overrides if metadata file exists
        if (event.srcMetadataFile) {
            // Create retry wrapper for S3 operations
            const retryS3Operation = createRetryWrapper('s3Upload', {
                correlationId,
                operationName: 'getMetadataFile'
            });

            try {
                console.log(`Loading metadata overrides from: ${event.srcMetadataFile}`);
                
                const metadata = await retryS3Operation(async () => {
                    return await s3.getObject({ 
                        Bucket: event.srcBucket || process.env.Source, 
                        Key: event.srcMetadataFile 
                    });
                });
                
                const metadataBody = await metadata.Body.transformToString();
                const metadataFile = JSON.parse(metadataBody);

                // Apply metadata overrides for subtitle configuration
                const metadataOverrides = {};
                CONFIGURABLE_SUBTITLE_KEYS.forEach(key => {
                    if (metadataFile[key] !== undefined) {
                        metadataOverrides[key] = metadataFile[key];
                    }
                });

                if (Object.keys(metadataOverrides).length > 0) {
                    console.log(`Applying metadata overrides:`, metadataOverrides);
                    subtitleConfig = buildSubtitleConfig(metadataOverrides);
                }
            } catch (metadataError) {
                console.warn(`Failed to load metadata file ${event.srcMetadataFile}:`, metadataError.message);
                
                // Log the metadata loading error but don't fail the entire process
                const errorReport = createSubtitleErrorReport(
                    SUBTITLE_ERROR_TYPES.STORAGE_ERROR,
                    `Failed to load metadata file: ${metadataError.message}`,
                    { 
                        guid: event.guid,
                        stage: 'configuration',
                        correlationId,
                        metadataFile: event.srcMetadataFile,
                        originalError: metadataError.name
                    }
                );
                
                logSubtitleError(errorReport);
                // Continue with environment-based configuration
            }
        }

        // Apply any direct configuration overrides from the event
        const eventOverrides = {};
        CONFIGURABLE_SUBTITLE_KEYS.forEach(key => {
            if (event[key] !== undefined) {
                eventOverrides[key] = event[key];
            }
        });

        if (Object.keys(eventOverrides).length > 0) {
            console.log(`Applying event overrides:`, eventOverrides);
            subtitleConfig = buildSubtitleConfig(eventOverrides);
        }

        // Validate and normalize the final configuration
        const validationResult = validateAndNormalizeSubtitleConfig(subtitleConfig);

        if (!validationResult.isValid) {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
                `Invalid subtitle configuration: ${validationResult.errors.join(', ')}`,
                { 
                    guid: event.guid,
                    stage: 'configuration',
                    correlationId,
                    configErrors: validationResult.errors,
                    originalConfig: subtitleConfig
                }
            );
            
            logSubtitleError(errorReport);
            
            // Return event with subtitle processing disabled due to configuration errors
            return {
                ...event,
                correlationId,
                subtitleConfig: {
                    enabled: false,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en'],
                    reason: 'configuration_error',
                    errors: validationResult.errors
                }
            };
        }

        // Log any warnings
        if (validationResult.warnings.length > 0) {
            console.warn('Configuration warnings:', validationResult.warnings);
        }

        // Add additional configuration fields needed by downstream processes
        const finalConfig = {
            ...validationResult.config,
            tempBucket: process.env.TEMP_BUCKET || event.srcBucket || process.env.Source,
            tempPrefix: `${event.guid}/subtitles/temp/`,
            finalPrefix: `${event.guid}/subtitles/`,
            cloudFrontDomain: event.cloudFront || process.env.CloudFront,
            correlationId
        };

        console.log(`Final subtitle configuration:`, finalConfig);

        // Return event with validated subtitle configuration
        return {
            ...event,
            correlationId,
            subtitleConfig: finalConfig
        };

    } catch (err) {
        // Use the new centralized error handling system
        const errorHandlingResult = await handleSubtitleError(event, err, {
            stage: 'configuration',
            correlationId,
            functionName: process.env.AWS_LAMBDA_FUNCTION_NAME
        });

        // If this is a critical configuration error that should fail the workflow
        if (errorHandlingResult.shouldFailWorkflow) {
            throw err;
        }

        // For non-critical errors, return event with subtitle processing disabled
        console.log(`Non-critical configuration error, disabling subtitle processing: ${err.message}`);
        return {
            ...event,
            correlationId: errorHandlingResult.correlationId,
            subtitleConfig: {
                enabled: false,
                primaryLanguage: 'auto',
                targetLanguages: ['en'],
                reason: 'configuration_error',
                error: err.message
            }
        };
    }
};
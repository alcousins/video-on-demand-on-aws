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
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const error = require('./lib/error.js');
const { 
    buildSubtitleConfig,
    validateAndNormalizeSubtitleConfig,
    createSubtitleErrorReport,
    logSubtitleError,
    shouldFailWorkflow,
    createSubtitleStatusUpdate,
    SUBTITLE_STATUS,
    SUBTITLE_ERROR_TYPES,
    CONFIGURABLE_SUBTITLE_KEYS
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

    const snsClient = new SNSClient({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    try {
        // Validate input parameters
        if (!event.guid) {
            throw new Error('Missing required parameter: guid');
        }

        console.log(`Processing subtitle configuration for ${event.guid}`);

        // Load metadata overrides if available
        const metadataOverrides = await loadMetadataOverrides(s3Client, event);

        // Build subtitle configuration from environment and metadata
        const rawConfig = buildSubtitleConfig(metadataOverrides);
        console.log(`Raw subtitle configuration: ${JSON.stringify(rawConfig, null, 2)}`);

        // Validate and normalize configuration
        const configResult = validateAndNormalizeSubtitleConfig(rawConfig);
        
        if (!configResult.isValid) {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
                `Invalid subtitle configuration: ${configResult.errors.join(', ')}`,
                {
                    guid: event.guid,
                    stage: 'configuration',
                    configErrors: configResult.errors,
                    configWarnings: configResult.warnings,
                    rawConfig
                }
            );

            logSubtitleError(errorReport);

            // Update DynamoDB with configuration error
            await updateSubtitleConfigurationStatus(docClient, event.guid, 'FAILED', errorReport);

            // Send error notification if it's a critical error
            if (shouldFailWorkflow(SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR, { errorMessage: errorReport.errorMessage })) {
                await sendErrorNotification(snsClient, event.guid, errorReport);
                throw new Error(errorReport.errorMessage);
            } else {
                // Non-critical configuration error - disable subtitle processing and continue
                console.log('Non-critical configuration error, disabling subtitle processing');
                configResult.config.enabled = false;
            }
        }

        // Log configuration warnings if any
        if (configResult.warnings && configResult.warnings.length > 0) {
            console.warn(`Configuration warnings: ${configResult.warnings.join(', ')}`);
        }

        // Update DynamoDB with validated configuration
        await updateSubtitleConfigurationStatus(docClient, event.guid, 'COMPLETED', null, configResult.config);

        // Add configuration to event for downstream processing
        const result = {
            ...event,
            subtitleConfig: configResult.config,
            configurationResult: {
                isValid: configResult.isValid,
                errors: configResult.errors,
                warnings: configResult.warnings,
                metadataOverrides: Object.keys(metadataOverrides).length > 0 ? metadataOverrides : null
            }
        };

        console.log(`Subtitle configuration completed successfully for ${event.guid}`);
        console.log(`Final configuration: ${JSON.stringify(configResult.config, null, 2)}`);

        return result;

    } catch (err) {
        console.error('Subtitle Configuration Lambda error:', err);
        
        // Create error report
        const errorReport = createSubtitleErrorReport(
            SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
            err.message,
            {
                guid: event.guid,
                stage: 'configuration',
                errorMessage: err.message
            }
        );

        logSubtitleError(errorReport);

        // Update DynamoDB with error status
        try {
            await updateSubtitleConfigurationStatus(docClient, event.guid, 'FAILED', errorReport);
        } catch (dbErr) {
            console.error('Failed to update DynamoDB with error status:', dbErr);
        }

        // Send error notification
        try {
            await sendErrorNotification(snsClient, event.guid, errorReport);
        } catch (notificationErr) {
            console.error('Failed to send error notification:', notificationErr);
        }
        
        await error.handler(event, err);
        throw err;
    }
};

/**
 * Loads metadata overrides from S3 if available
 * @param {S3Client} s3Client - AWS S3 client
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} Metadata overrides object
 */
async function loadMetadataOverrides(s3Client, event) {
    const overrides = {};

    // Check if metadata file was provided in the event
    if (event.srcMetadataFile && event.srcBucket) {
        try {
            console.log(`Loading metadata overrides from: ${event.srcBucket}/${event.srcMetadataFile}`);
            
            const getObjectCommand = new GetObjectCommand({
                Bucket: event.srcBucket,
                Key: event.srcMetadataFile
            });
            
            const response = await s3Client.send(getObjectCommand);
            const metadataText = await streamToString(response.Body);
            const metadata = JSON.parse(metadataText);

            // Extract subtitle-related configuration keys
            for (const key of CONFIGURABLE_SUBTITLE_KEYS) {
                if (metadata[key] !== undefined) {
                    // Normalize key names to match our internal configuration structure
                    const normalizedKey = normalizeConfigKey(key);
                    overrides[normalizedKey] = metadata[key];
                }
            }

            // Also check for camelCase variants
            const camelCaseKeys = [
                'subtitleEnabled',
                'subtitlePrimaryLanguage',
                'subtitleTargetLanguages',
                'subtitleProcessingEnabled'
            ];

            for (const key of camelCaseKeys) {
                if (metadata[key] !== undefined) {
                    const normalizedKey = normalizeConfigKey(key);
                    overrides[normalizedKey] = metadata[key];
                }
            }

            console.log(`Loaded metadata overrides: ${JSON.stringify(overrides, null, 2)}`);

        } catch (err) {
            console.warn(`Failed to load metadata overrides: ${err.message}`);
            // Don't fail the entire process for metadata loading errors
        }
    }

    return overrides;
}

/**
 * Converts a readable stream to string
 * @param {ReadableStream} stream - Readable stream
 * @returns {Promise<string>} String content
 */
async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Normalizes configuration key names to internal format
 * @param {string} key - Configuration key from metadata
 * @returns {string} Normalized key name
 */
function normalizeConfigKey(key) {
    const keyMappings = {
        'subtitleEnabled': 'subtitleEnabled',
        'subtitleProcessingEnabled': 'subtitleEnabled',
        'subtitlePrimaryLanguage': 'subtitlePrimaryLanguage',
        'subtitleTargetLanguages': 'subtitleTargetLanguages'
    };

    return keyMappings[key] || key;
}

/**
 * Updates subtitle configuration status in DynamoDB
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @param {string} guid - Video processing job GUID
 * @param {string} status - Configuration status ('COMPLETED', 'FAILED')
 * @param {Object} errorReport - Error report if failed (optional)
 * @param {Object} config - Final configuration if successful (optional)
 */
async function updateSubtitleConfigurationStatus(docClient, guid, status, errorReport = null, config = null) {
    if (!guid) {
        console.warn('Cannot update configuration status: missing GUID');
        return;
    }

    try {
        const additionalFields = {
            configurationStatus: status,
            configurationTimestamp: new Date().toISOString()
        };

        if (config) {
            additionalFields.subtitleConfig = config;
        }

        if (errorReport) {
            additionalFields.configurationError = {
                type: errorReport.errorType,
                message: errorReport.errorMessage,
                severity: errorReport.severity,
                retryable: errorReport.retryable,
                context: errorReport.context
            };
        }

        const updateParams = createSubtitleStatusUpdate(
            status === 'COMPLETED' ? SUBTITLE_STATUS.PENDING : SUBTITLE_STATUS.FAILED,
            additionalFields
        );
        
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: { guid },
            ...updateParams
        };

        await docClient.send(new UpdateCommand(params));
        console.log(`Updated subtitle configuration status for ${guid}: ${status}`);
    } catch (err) {
        console.error(`Failed to update subtitle configuration status for ${guid}:`, err);
        throw err;
    }
}

/**
 * Sends error notification through SNS
 * @param {SNSClient} snsClient - AWS SNS client
 * @param {string} guid - Video processing job GUID
 * @param {Object} errorReport - Error report to send
 */
async function sendErrorNotification(snsClient, guid, errorReport) {
    if (!process.env.SnsTopic) {
        console.warn('SNS topic not configured, skipping error notification');
        return;
    }

    try {
        const message = {
            guid: guid,
            workflowStatus: 'Error',
            workflowErrorAt: 'Subtitle Configuration',
            errorType: errorReport.errorType,
            errorMessage: errorReport.errorMessage,
            severity: errorReport.severity,
            retryable: errorReport.retryable,
            userActionRequired: errorReport.userActionRequired,
            timestamp: errorReport.timestamp,
            context: errorReport.context
        };

        const params = {
            Message: JSON.stringify(message, null, 2),
            Subject: `Subtitle Processing Error: ${guid}`,
            TopicArn: process.env.SnsTopic
        };

        await snsClient.send(new PublishCommand(params));
        console.log(`Sent error notification for ${guid}: ${errorReport.errorType}`);
    } catch (err) {
        console.error(`Failed to send error notification for ${guid}:`, err);
        // Don't throw here - notification failure shouldn't fail the main process
    }
}
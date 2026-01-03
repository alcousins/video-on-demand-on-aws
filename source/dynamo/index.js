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

const { DynamoDBDocument } = require("@aws-sdk/lib-dynamodb");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { S3 } = require("@aws-sdk/client-s3");
const error = require('./lib/error.js');
const { 
    createSubtitleProcessingUpdate,
    updateTranscriptionStatus,
    updateTranslationStatus,
    updateWebVTTStatus,
    updateSubtitleConfiguration,
    updateMediaConvertCompletion,
    getSubtitleProcessingStatus,
    updateSubtitleError,
    updatePerformanceMetrics,
    SUBTITLE_DB_FIELDS
} = require('./lib/subtitle-db-utils.js');

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    const dynamo = DynamoDBDocument.from(new DynamoDBClient({ 
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    }));

    try {
        // Check if this is a subtitle-specific update operation
        if (event.subtitleOperation) {
            return await handleSubtitleOperation(dynamo, event);
        }

        // Handle standard DynamoDB update operations (existing functionality)
        return await handleStandardUpdate(dynamo, event);

    } catch (err) {
        await error.handler(event, err);
        throw err;
    }
};

/**
 * Handles subtitle-specific DynamoDB operations
 * @param {DynamoDBDocument} dynamo - DynamoDB document client
 * @param {Object} event - Lambda event with subtitle operation details
 * @returns {Object} Updated event data
 */
async function handleSubtitleOperation(dynamo, event) {
    const { subtitleOperation, guid } = event;

    switch (subtitleOperation) {
        case 'updateTranscriptionStatus':
            await updateTranscriptionStatus(dynamo, guid, event.transcriptionStatus, event.transcriptionData || {});
            break;

        case 'updateTranslationStatus':
            await updateTranslationStatus(dynamo, guid, event.translationStatus, event.translationData || {});
            break;

        case 'updateWebVTTStatus':
            await updateWebVTTStatus(dynamo, guid, event.webvttStatus, event.uploadedFiles, event.errorDetails);
            break;

        case 'updateSubtitleConfiguration':
            await updateSubtitleConfiguration(dynamo, guid, event.subtitleConfig);
            break;

        case 'updateMediaConvertCompletion':
            await updateMediaConvertCompletion(dynamo, guid, event.mediaConvertData || {});
            break;

        case 'updateSubtitleError':
            await updateSubtitleError(dynamo, guid, event.errorDetails, event.correlationId);
            break;

        case 'updatePerformanceMetrics':
            await updatePerformanceMetrics(dynamo, guid, event.performanceMetrics || {});
            break;

        case 'getSubtitleStatus':
            const statusData = await getSubtitleProcessingStatus(dynamo, guid);
            return { ...event, subtitleStatusData: statusData };

        default:
            throw new Error(`Unknown subtitle operation: ${subtitleOperation}`);
    }

    return event;
}

/**
 * Handles standard DynamoDB update operations (existing functionality)
 * @param {DynamoDBDocument} dynamo - DynamoDB document client
 * @param {Object} event - Lambda event with standard update data
 * @returns {Object} Updated event data
 */
async function handleStandardUpdate(dynamo, event) {
    // Remove guid from event data (primary db table key) and iterate over event objects
    // to build the update parameters
    let guid = event.guid;
    delete event.guid;
    
    // Initialize S3 client for storing large objects
    const s3 = new S3({customUserAgent: process.env.SOLUTION_IDENTIFIER});
    
    let expression = '';
    let values = {};
    let names = {};
    let i = 0;

    // Helper function to check if a key contains nested attributes
    const hasNestedAttribute = (key) => key.includes('.');

    // Helper function to estimate object size in bytes
    const estimateObjectSize = (obj) => {
        return JSON.stringify(obj).length;
    };

    // Helper function to store large objects in S3
    const storeLargeObjectInS3 = async (key, obj, guid) => {
        const s3Key = `${guid}/large-objects/${key}-${Date.now()}.json`;
        const s3Params = {
            Bucket: process.env.S3Bucket,
            Key: s3Key,
            Body: JSON.stringify(obj),
            ContentType: 'application/json'
        };
        
        await s3.putObject(s3Params);
        
        return {
            s3Location: `s3://${process.env.S3Bucket}/${s3Key}`,
            size: estimateObjectSize(obj),
            timestamp: new Date().toISOString(),
            type: 'large-object-reference'
        };
    };

    // Separate nested and non-nested attributes
    const nestedAttributes = {};
    const flatAttributes = {};

    // Helper function to identify essential fields that should stay in DynamoDB
    const getEssentialFields = () => {
        return new Set([
            'guid',
            'workflowStatus',
            'workflowName',
            'workflowTrigger',
            'startTime',
            'endTime',
            'srcVideo',
            'srcBucket',
            'destBucket',
            'cloudFront',
            'srcMediainfo',
            'srcHeight',
            'srcWidth',
            'hlsUrl',
            'hlsPlaylist',
            'dashUrl',
            'dashPlaylist',
            'mp4Urls',
            'mp4Outputs',
            'mssUrl',
            'mssPlaylist',
            'cmafDashUrl',
            'cmafHlsUrl',
            'thumbNailsUrls',
            'thumbNails',
            'encodeJobId',
            'encodingProfile',
            'frameCapture',
            'frameCaptureHeight',
            'frameCaptureWidth',
            'acceleratedTranscoding',
            'archiveSource',
            'enableMediaPackage',
            'enableSns',
            'enableSqs',
            'jobTemplate',
            'jobTemplate_1080p',
            'jobTemplate_2160p',
            'jobTemplate_720p',
            'isCustomTemplate',
            'inputRotate',
            'subtitleProcessingStatus',
            'subtitleTranslationStatus',
            'subtitleWebvttStatus'
        ]);
    };

    // Separate essential fields from detailed data
    const essentialFields = getEssentialFields();
    const essentialData = {};
    const detailedData = {};
    
    for (const [key, value] of Object.entries(event)) {
        if (essentialFields.has(key)) {
            essentialData[key] = value;
        } else {
            detailedData[key] = value;
        }
    }
    
    // Store detailed data in S3 if it exists and is substantial
    if (Object.keys(detailedData).length > 0) {
        const detailedDataSize = estimateObjectSize(detailedData);
        console.log(`Storing detailed data (${detailedDataSize} bytes) in S3`);
        
        try {
            const s3Reference = await storeLargeObjectInS3('detailedWorkflowData', detailedData, guid);
            essentialData.detailedWorkflowData = s3Reference;
        } catch (s3Error) {
            console.error('Failed to store detailed data in S3:', s3Error);
            // Store a minimal summary instead
            essentialData.detailedWorkflowData = {
                error: 'Failed to store detailed data in S3',
                fieldCount: Object.keys(detailedData).length,
                timestamp: new Date().toISOString(),
                type: 'storage-error'
            };
        }
    }
    
    // Process essential fields for DynamoDB storage
    for (const [key, value] of Object.entries(essentialData)) {
        // Even essential fields might be large (like srcMediainfo)
        const objectSize = estimateObjectSize(value);
        const isLargeObject = objectSize > 500;
        
        if (isLargeObject && typeof value === 'object' && value !== null) {
            console.log(`Storing large essential field ${key} (${objectSize} bytes) in S3`);
            
            try {
                const s3Reference = await storeLargeObjectInS3(key, value, guid);
                
                if (hasNestedAttribute(key)) {
                    const [parentKey, childKey] = key.split('.');
                    if (!nestedAttributes[parentKey]) {
                        nestedAttributes[parentKey] = {};
                    }
                    nestedAttributes[parentKey][childKey] = s3Reference;
                } else {
                    flatAttributes[key] = s3Reference;
                }
            } catch (s3Error) {
                console.error(`Failed to store essential field ${key} in S3:`, s3Error);
                const minimalReference = {
                    error: 'Failed to store in S3',
                    originalSize: objectSize,
                    timestamp: new Date().toISOString(),
                    type: 'storage-error'
                };
                
                if (hasNestedAttribute(key)) {
                    const [parentKey, childKey] = key.split('.');
                    if (!nestedAttributes[parentKey]) {
                        nestedAttributes[parentKey] = {};
                    }
                    nestedAttributes[parentKey][childKey] = minimalReference;
                } else {
                    flatAttributes[key] = minimalReference;
                }
            }
        } else {
            // Store in DynamoDB
            if (hasNestedAttribute(key)) {
                const [parentKey, childKey] = key.split('.');
                if (!nestedAttributes[parentKey]) {
                    nestedAttributes[parentKey] = {};
                }
                nestedAttributes[parentKey][childKey] = value;
            } else {
                flatAttributes[key] = value;
            }
        }
    }

    // Build update expression for flat attributes
    Object.keys(flatAttributes).forEach((key) => {
        i++;
        expression += ' ' + key + ' = :' + i + ',';
        values[':' + i] = flatAttributes[key];
    });

    // Build update expression for nested attributes
    Object.keys(nestedAttributes).forEach((parentKey) => {
        i++;
        expression += ' ' + parentKey + ' = :' + i + ',';
        values[':' + i] = nestedAttributes[parentKey];
    });

    let params = {
        TableName: process.env.DynamoDBTable,
        Key: {
            guid: guid,
        },
        // remove the trailing ',' from the update expression added by the forEach loop
        UpdateExpression: 'set ' + expression.slice(0, -1),
        ExpressionAttributeValues: values
    };

    console.log(`UPDATE:: ${JSON.stringify(params, null, 2)}`);
    await dynamo.update(params);

    // Get updated data and reconst event data to return
    event.guid = guid;
    return event;
}

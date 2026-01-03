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
 * Shared client for subtitle-related DynamoDB operations
 * This module provides a simplified interface for Lambda functions to update subtitle processing status
 */

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

/**
 * Client for subtitle-related DynamoDB operations
 */
class DynamoSubtitleClient {
    constructor(region = process.env.AWS_REGION) {
        this.lambdaClient = new LambdaClient({
            region,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });
        this.dynamoLambdaFunction = process.env.DynamoDBLambda || 'DynamoDBLambda';
    }

    /**
     * Invokes the DynamoDB Lambda function with subtitle operation
     * @param {Object} payload - Operation payload
     * @returns {Promise<Object>} Response from DynamoDB Lambda
     */
    async invokeOperation(payload) {
        try {
            const command = new InvokeCommand({
                FunctionName: this.dynamoLambdaFunction,
                Payload: JSON.stringify(payload)
            });

            const response = await this.lambdaClient.send(command);
            
            if (response.Payload) {
                const result = JSON.parse(Buffer.from(response.Payload).toString());
                
                if (response.FunctionError) {
                    throw new Error(`DynamoDB operation failed: ${result.errorMessage || 'Unknown error'}`);
                }
                
                return result;
            }
            
            return {};
        } catch (err) {
            console.error('Failed to invoke DynamoDB operation:', err);
            throw err;
        }
    }

    /**
     * Updates transcription status in DynamoDB
     * @param {string} guid - Video processing job GUID
     * @param {string} transcriptionStatus - Transcription job status
     * @param {Object} transcriptionData - Additional transcription data
     * @returns {Promise<Object>} Update response
     */
    async updateTranscriptionStatus(guid, transcriptionStatus, transcriptionData = {}) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updateTranscriptionStatus',
            transcriptionStatus,
            transcriptionData
        });
    }

    /**
     * Updates translation status in DynamoDB
     * @param {string} guid - Video processing job GUID
     * @param {string} translationStatus - Translation status
     * @param {Object} translationData - Translation progress data
     * @returns {Promise<Object>} Update response
     */
    async updateTranslationStatus(guid, translationStatus, translationData = {}) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updateTranslationStatus',
            translationStatus,
            translationData
        });
    }

    /**
     * Updates WebVTT generation status in DynamoDB
     * @param {string} guid - Video processing job GUID
     * @param {string} webvttStatus - WebVTT generation status
     * @param {Array} uploadedFiles - Array of uploaded file information
     * @param {string} errorDetails - Error details if failed
     * @returns {Promise<Object>} Update response
     */
    async updateWebVTTStatus(guid, webvttStatus, uploadedFiles = null, errorDetails = null) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updateWebVTTStatus',
            webvttStatus,
            uploadedFiles,
            errorDetails
        });
    }

    /**
     * Updates subtitle configuration in DynamoDB
     * @param {string} guid - Video processing job GUID
     * @param {Object} subtitleConfig - Subtitle configuration
     * @returns {Promise<Object>} Update response
     */
    async updateSubtitleConfiguration(guid, subtitleConfig) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updateSubtitleConfiguration',
            subtitleConfig
        });
    }

    /**
     * Updates MediaConvert completion status with final file locations
     * @param {string} guid - Video processing job GUID
     * @param {Object} mediaConvertData - MediaConvert job completion data
     * @returns {Promise<Object>} Update response
     */
    async updateMediaConvertCompletion(guid, mediaConvertData) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updateMediaConvertCompletion',
            mediaConvertData
        });
    }

    /**
     * Updates subtitle error details in DynamoDB
     * @param {string} guid - Video processing job GUID
     * @param {string} errorDetails - Error details
     * @param {string} correlationId - Error correlation ID
     * @returns {Promise<Object>} Update response
     */
    async updateSubtitleError(guid, errorDetails, correlationId = null) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updateSubtitleError',
            errorDetails,
            correlationId
        });
    }

    /**
     * Updates performance metrics in DynamoDB
     * @param {string} guid - Video processing job GUID
     * @param {Object} performanceMetrics - Performance metrics by stage
     * @returns {Promise<Object>} Update response
     */
    async updatePerformanceMetrics(guid, performanceMetrics) {
        return await this.invokeOperation({
            guid,
            subtitleOperation: 'updatePerformanceMetrics',
            performanceMetrics
        });
    }

    /**
     * Retrieves current subtitle processing status from DynamoDB
     * @param {string} guid - Video processing job GUID
     * @returns {Promise<Object>} Current subtitle processing status and data
     */
    async getSubtitleProcessingStatus(guid) {
        const response = await this.invokeOperation({
            guid,
            subtitleOperation: 'getSubtitleStatus'
        });
        
        return response.subtitleStatusData || null;
    }

    /**
     * Updates subtitle processing status with comprehensive error handling
     * @param {string} guid - Video processing job GUID
     * @param {string} status - Processing status
     * @param {Object} options - Update options
     * @returns {Promise<Object>} Update response
     */
    async updateProcessingStatus(guid, status, options = {}) {
        const {
            stage = 'unknown',
            errorDetails = null,
            correlationId = null,
            additionalData = {}
        } = options;

        // Choose the appropriate update method based on stage
        switch (stage) {
            case 'transcription':
                return await this.updateTranscriptionStatus(guid, status, additionalData);
            
            case 'translation':
                return await this.updateTranslationStatus(guid, status, additionalData);
            
            case 'webvtt':
                return await this.updateWebVTTStatus(guid, status, additionalData.uploadedFiles, errorDetails);
            
            case 'mediaconvert':
                return await this.updateMediaConvertCompletion(guid, additionalData);
            
            default:
                // Generic error update
                if (errorDetails) {
                    return await this.updateSubtitleError(guid, errorDetails, correlationId);
                }
                
                // For other cases, we could extend this with a generic status update
                throw new Error(`Unsupported processing stage: ${stage}`);
        }
    }
}

/**
 * Factory function to create a DynamoSubtitleClient instance
 * @param {string} region - AWS region (optional)
 * @returns {DynamoSubtitleClient} Client instance
 */
function createDynamoSubtitleClient(region) {
    return new DynamoSubtitleClient(region);
}

/**
 * Convenience function for updating subtitle processing status
 * @param {string} guid - Video processing job GUID
 * @param {string} status - Processing status
 * @param {Object} options - Update options
 * @returns {Promise<Object>} Update response
 */
async function updateSubtitleProcessingStatus(guid, status, options = {}) {
    const client = createDynamoSubtitleClient();
    return await client.updateProcessingStatus(guid, status, options);
}

/**
 * Convenience function for getting subtitle processing status
 * @param {string} guid - Video processing job GUID
 * @returns {Promise<Object>} Current status data
 */
async function getSubtitleProcessingStatus(guid) {
    const client = createDynamoSubtitleClient();
    return await client.getSubtitleProcessingStatus(guid);
}

module.exports = {
    DynamoSubtitleClient,
    createDynamoSubtitleClient,
    updateSubtitleProcessingStatus,
    getSubtitleProcessingStatus
};
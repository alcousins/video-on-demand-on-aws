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
const { Lambda } = require("@aws-sdk/client-lambda");
const { SNS } = require("@aws-sdk/client-sns");
const { SQS } = require("@aws-sdk/client-sqs");
const { v4: uuidv4 } = require('uuid');

const {
    SUBTITLE_ERROR_TYPES,
    createSubtitleErrorReport,
    logSubtitleError,
    shouldFailWorkflow,
    getRetryConfig,
    createOptimizedRetryConfig,
    createSubtitleStatusUpdate
} = require('./subtitle-utils');

/**
 * Centralized error handling and notification system for subtitle processing
 */
class SubtitleErrorHandler {
    constructor() {
        this.dynamo = DynamoDBDocument.from(new DynamoDBClient({ 
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        }));

        this.lambda = new Lambda({
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });

        this.sns = new SNS({
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });

        this.sqs = new SQS({
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });

        // Generate correlation ID for this handler instance
        this.correlationId = uuidv4();
    }

    /**
     * Handles errors with comprehensive logging, notification, and retry logic
     * @param {Object} event - Lambda event object
     * @param {Error} error - Error object
     * @param {Object} context - Additional context information
     * @returns {Object} Error handling result
     */
    async handleError(event, error, context = {}) {
        const correlationId = context.correlationId || this.correlationId;
        const errorType = this.classifyError(error, context);
        
        // Create structured error report
        const errorReport = createSubtitleErrorReport(
            errorType,
            error.message,
            {
                ...context,
                guid: event.guid,
                correlationId,
                functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
                stage: context.stage || 'unknown',
                originalError: error.stack,
                timestamp: new Date().toISOString()
            }
        );

        // Log the error with structured information
        logSubtitleError(errorReport);

        // Update DynamoDB with error status and details
        await this.updateDatabaseWithError(event, errorReport);

        // Send notifications based on error severity
        await this.sendErrorNotifications(event, errorReport);

        // Determine if workflow should continue or fail
        const shouldFail = shouldFailWorkflow(errorType, errorReport.context);

        return {
            correlationId,
            errorType,
            errorReport,
            shouldFailWorkflow: shouldFail,
            retryable: errorReport.retryable,
            retryConfig: getRetryConfig(errorType)
        };
    }

    /**
     * Classifies error type based on error message and context
     * @param {Error} error - Error object
     * @param {Object} context - Error context
     * @returns {string} Error type from SUBTITLE_ERROR_TYPES
     */
    classifyError(error, context = {}) {
        const errorMessage = error.message.toLowerCase();
        const errorCode = error.code || '';

        // Configuration errors
        if (errorMessage.includes('configuration') || 
            errorMessage.includes('invalid parameter') ||
            errorMessage.includes('missing required') ||
            errorCode === 'ValidationException') {
            return SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR;
        }

        // Transcription errors
        if (errorMessage.includes('transcribe') ||
            errorMessage.includes('transcription') ||
            errorCode === 'BadRequestException' ||
            context.stage === 'transcription') {
            return SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR;
        }

        // Translation errors
        if (errorMessage.includes('translate') ||
            errorMessage.includes('translation') ||
            errorCode === 'UnsupportedLanguagePairException' ||
            context.stage === 'translation') {
            return SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR;
        }

        // WebVTT generation errors
        if (errorMessage.includes('webvtt') ||
            errorMessage.includes('subtitle') ||
            context.stage === 'webvtt') {
            return SUBTITLE_ERROR_TYPES.WEBVTT_ERROR;
        }

        // Storage errors
        if (errorMessage.includes('s3') ||
            errorMessage.includes('storage') ||
            errorMessage.includes('bucket') ||
            errorCode === 'NoSuchBucket' ||
            errorCode === 'AccessDenied') {
            return SUBTITLE_ERROR_TYPES.STORAGE_ERROR;
        }

        // Timeout errors
        if (errorMessage.includes('timeout') ||
            errorMessage.includes('time out') ||
            errorCode === 'TimeoutError' ||
            error.name === 'TimeoutError') {
            return SUBTITLE_ERROR_TYPES.TIMEOUT_ERROR;
        }

        // Default to transcription error for unknown errors
        return SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR;
    }

    /**
     * Updates DynamoDB with error information and processing status
     * @param {Object} event - Lambda event object
     * @param {Object} errorReport - Structured error report
     */
    async updateDatabaseWithError(event, errorReport) {
        try {
            if (!event.guid || !process.env.DynamoDBTable) {
                console.warn('Missing GUID or DynamoDB table name, skipping database update');
                return;
            }

            // Create status update with error details
            const statusUpdate = createSubtitleStatusUpdate('failed', {
                errorType: errorReport.errorType,
                errorMessage: errorReport.errorMessage,
                errorDetails: JSON.stringify({
                    correlationId: errorReport.context.correlationId,
                    stage: errorReport.context.stage,
                    timestamp: errorReport.timestamp,
                    retryable: errorReport.retryable,
                    severity: errorReport.severity
                }),
                lastErrorAt: errorReport.timestamp
            });

            const params = {
                TableName: process.env.DynamoDBTable,
                Key: { guid: event.guid },
                ...statusUpdate
            };

            await this.dynamo.update(params);

            console.log(`Updated DynamoDB with error status for GUID: ${event.guid}`);
        } catch (dbError) {
            console.error('Failed to update DynamoDB with error status:', dbError);
            // Don't throw here - we don't want database update failures to mask the original error
        }
    }

    /**
     * Sends error notifications through SNS and SQS based on error severity
     * @param {Object} event - Lambda event object
     * @param {Object} errorReport - Structured error report
     */
    async sendErrorNotifications(event, errorReport) {
        try {
            // Prepare notification message
            const notificationMessage = {
                guid: event.guid,
                workflowStatus: 'Error',
                workflowErrorAt: 'SubtitleProcessing',
                errorType: errorReport.errorType,
                errorMessage: errorReport.errorMessage,
                correlationId: errorReport.context.correlationId,
                stage: errorReport.context.stage,
                severity: errorReport.severity,
                retryable: errorReport.retryable,
                timestamp: errorReport.timestamp,
                functionName: errorReport.context.functionName
            };

            // Send SNS notification for high and medium severity errors
            if (errorReport.severity === 'HIGH' || errorReport.severity === 'MEDIUM') {
                await this.sendSNSNotification(notificationMessage);
            }

            // Send SQS message for all errors (for processing/retry logic)
            await this.sendSQSNotification(notificationMessage);

            // Invoke error handler Lambda if configured (for compatibility with existing system)
            if (process.env.ErrorHandler) {
                await this.invokeErrorHandler(event, errorReport);
            }

        } catch (notificationError) {
            console.error('Failed to send error notifications:', notificationError);
            // Don't throw here - notification failures shouldn't mask the original error
        }
    }

    /**
     * Sends SNS notification for error
     * @param {Object} message - Notification message
     */
    async sendSNSNotification(message) {
        if (!process.env.SnsTopic) {
            console.warn('SNS topic not configured, skipping SNS notification');
            return;
        }

        try {
            const params = {
                Message: JSON.stringify(message, null, 2),
                Subject: `Subtitle Processing Error: ${message.errorType} - ${message.guid}`,
                TargetArn: process.env.SnsTopic
            };

            await this.sns.publish(params);
            console.log(`Sent SNS notification for error: ${message.correlationId}`);
        } catch (error) {
            console.error('Failed to send SNS notification:', error);
        }
    }

    /**
     * Sends SQS message for error processing
     * @param {Object} message - Notification message
     */
    async sendSQSNotification(message) {
        if (!process.env.SqsQueue) {
            console.warn('SQS queue not configured, skipping SQS notification');
            return;
        }

        try {
            const params = {
                MessageBody: JSON.stringify(message, null, 2),
                QueueUrl: process.env.SqsQueue,
                MessageAttributes: {
                    'ErrorType': {
                        DataType: 'String',
                        StringValue: message.errorType
                    },
                    'Severity': {
                        DataType: 'String',
                        StringValue: message.severity
                    },
                    'CorrelationId': {
                        DataType: 'String',
                        StringValue: message.correlationId
                    }
                }
            };

            await this.sqs.sendMessage(params);
            console.log(`Sent SQS message for error: ${message.correlationId}`);
        } catch (error) {
            console.error('Failed to send SQS message:', error);
        }
    }

    /**
     * Invokes the existing error handler Lambda for compatibility
     * @param {Object} event - Original Lambda event
     * @param {Object} errorReport - Structured error report
     */
    async invokeErrorHandler(event, errorReport) {
        try {
            const payload = {
                guid: event.guid,
                event: event,
                function: errorReport.context.functionName,
                error: errorReport.errorMessage,
                correlationId: errorReport.context.correlationId,
                errorType: errorReport.errorType,
                stage: errorReport.context.stage
            };

            const params = {
                FunctionName: process.env.ErrorHandler,
                Payload: JSON.stringify(payload, null, 2)
            };

            await this.lambda.invoke(params);
            console.log(`Invoked error handler Lambda: ${errorReport.context.correlationId}`);
        } catch (error) {
            console.error('Failed to invoke error handler Lambda:', error);
        }
    }

    /**
     * Implements exponential backoff retry logic
     * @param {Function} operation - Operation to retry
     * @param {Object} retryConfig - Retry configuration
     * @param {Object} context - Operation context
     * @returns {Promise} Operation result
     */
    async retryWithBackoff(operation, retryConfig, context = {}) {
        const {
            maxAttempts = 3,
            initialDelayMs = 1000,
            backoffMultiplier = 2,
            maxDelayMs = 30000
        } = retryConfig;

        let lastError;
        let delay = initialDelayMs;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`Attempt ${attempt}/${maxAttempts} for operation: ${context.operationName || 'unknown'}`);
                
                const result = await operation();
                
                if (attempt > 1) {
                    console.log(`Operation succeeded on attempt ${attempt}`);
                }
                
                return result;
            } catch (error) {
                lastError = error;
                
                console.warn(`Attempt ${attempt}/${maxAttempts} failed:`, error.message);
                
                // Don't wait after the last attempt
                if (attempt < maxAttempts) {
                    console.log(`Waiting ${delay}ms before retry...`);
                    await this.sleep(delay);
                    
                    // Calculate next delay with exponential backoff
                    delay = Math.min(delay * backoffMultiplier, maxDelayMs);
                }
            }
        }

        // All attempts failed
        const retryError = new Error(`Operation failed after ${maxAttempts} attempts: ${lastError.message}`);
        retryError.originalError = lastError;
        retryError.attempts = maxAttempts;
        throw retryError;
    }

    /**
     * Sleep utility for retry delays
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise} Promise that resolves after delay
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Creates a retry wrapper for Lambda functions
     * @param {string} operationType - Type of operation for optimized retry config
     * @param {Object} context - Additional context for retry optimization
     * @returns {Function} Retry wrapper function
     */
    createRetryWrapper(operationType, context = {}) {
        const retryConfig = createOptimizedRetryConfig(operationType, context);
        
        return (operation) => {
            return this.retryWithBackoff(operation, retryConfig, {
                operationName: operationType,
                ...context
            });
        };
    }

    /**
     * Handles transient errors with automatic retry
     * @param {Object} event - Lambda event object
     * @param {Error} error - Error object
     * @param {Function} operation - Operation to retry
     * @param {Object} context - Additional context
     * @returns {Object} Operation result or error handling result
     */
    async handleTransientError(event, error, operation, context = {}) {
        const errorType = this.classifyError(error, context);
        const retryConfig = getRetryConfig(errorType);

        // Only retry if the error is retryable
        if (retryConfig.maxAttempts > 0) {
            try {
                console.log(`Handling transient error with retry: ${error.message}`);
                
                const result = await this.retryWithBackoff(operation, retryConfig, context);
                
                // Log successful recovery
                console.log(`Successfully recovered from transient error: ${context.correlationId}`);
                
                return { success: true, result };
            } catch (retryError) {
                // All retries failed, handle as permanent error
                console.error(`All retries failed for transient error: ${retryError.message}`);
                
                return await this.handleError(event, retryError, {
                    ...context,
                    originalError: error,
                    retriesAttempted: retryConfig.maxAttempts
                });
            }
        } else {
            // Error is not retryable, handle immediately
            return await this.handleError(event, error, context);
        }
    }

    /**
     * Creates a correlation ID for tracking errors across function calls
     * @param {string} guid - Video processing job GUID
     * @param {string} stage - Processing stage
     * @returns {string} Correlation ID
     */
    static createCorrelationId(guid, stage) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        return `${guid}-${stage}-${timestamp}-${random}`;
    }

    /**
     * Extracts correlation ID from event or creates a new one
     * @param {Object} event - Lambda event object
     * @param {string} stage - Processing stage
     * @returns {string} Correlation ID
     */
    static getOrCreateCorrelationId(event, stage) {
        return event.correlationId || 
               event.context?.correlationId || 
               SubtitleErrorHandler.createCorrelationId(event.guid, stage);
    }
}

/**
 * Factory function to create error handler with proper configuration
 * @param {Object} config - Configuration options
 * @returns {SubtitleErrorHandler} Configured error handler instance
 */
function createSubtitleErrorHandler(config = {}) {
    const handler = new SubtitleErrorHandler();
    
    // Apply any custom configuration
    if (config.correlationId) {
        handler.correlationId = config.correlationId;
    }
    
    return handler;
}

/**
 * Convenience function for handling errors in Lambda functions
 * @param {Object} event - Lambda event object
 * @param {Error} error - Error object
 * @param {Object} context - Additional context
 * @returns {Object} Error handling result
 */
async function handleSubtitleError(event, error, context = {}) {
    const handler = createSubtitleErrorHandler({
        correlationId: SubtitleErrorHandler.getOrCreateCorrelationId(event, context.stage)
    });
    
    return await handler.handleError(event, error, context);
}

/**
 * Convenience function for creating retry wrappers
 * @param {string} operationType - Type of operation
 * @param {Object} context - Additional context
 * @returns {Function} Retry wrapper function
 */
function createRetryWrapper(operationType, context = {}) {
    const handler = createSubtitleErrorHandler();
    return handler.createRetryWrapper(operationType, context);
}

module.exports = {
    SubtitleErrorHandler,
    createSubtitleErrorHandler,
    handleSubtitleError,
    createRetryWrapper
};
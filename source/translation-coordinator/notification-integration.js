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

const { SNS } = require("@aws-sdk/client-sns");
const { SQS } = require("@aws-sdk/client-sqs");
const { Lambda } = require("@aws-sdk/client-lambda");
const { 
    createNotificationMessage, 
    NOTIFICATION_CONFIG 
} = require('./performance-optimizer');

/**
 * Enhanced notification integration for subtitle processing
 * Integrates with existing SNS/SQS notification mechanisms
 */
class SubtitleNotificationIntegration {
    constructor() {
        this.sns = new SNS({
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });

        this.sqs = new SQS({
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });

        this.lambda = new Lambda({
            region: process.env.AWS_REGION,
            customUserAgent: process.env.SOLUTION_IDENTIFIER
        });
    }

    /**
     * Sends comprehensive notification for subtitle processing events
     * @param {string} trigger - Notification trigger type
     * @param {Object} eventData - Event data for notification
     * @param {Object} options - Additional notification options
     */
    async sendSubtitleProcessingNotification(trigger, eventData, options = {}) {
        try {
            const notificationMessage = createNotificationMessage(trigger, eventData);
            
            // Determine which notification channels to use based on priority
            const shouldSendSNS = this.shouldSendSNSNotification(notificationMessage.priority, options);
            const shouldSendSQS = this.shouldSendSQSNotification(notificationMessage.priority, options);
            
            const results = {
                sns: null,
                sqs: null,
                errorHandler: null
            };

            // Send SNS notification for high-priority events
            if (shouldSendSNS && process.env.SnsTopic) {
                results.sns = await this.sendSNSNotification(notificationMessage, eventData);
            }

            // Send SQS message for processing/tracking
            if (shouldSendSQS && process.env.SqsQueue) {
                results.sqs = await this.sendSQSNotification(notificationMessage, eventData);
            }

            // Invoke existing error handler for compatibility (only for failures)
            if (this.shouldInvokeErrorHandler(trigger) && process.env.ErrorHandler) {
                results.errorHandler = await this.invokeExistingErrorHandler(eventData, notificationMessage);
            }

            console.log(`Sent subtitle processing notification: ${trigger} for ${eventData.guid}`);
            return results;

        } catch (error) {
            console.error('Failed to send subtitle processing notification:', error);
            // Don't throw - notification failures shouldn't break the main workflow
            return { error: error.message };
        }
    }

    /**
     * Sends SNS notification with enhanced subtitle processing context
     * @param {Object} notificationMessage - Formatted notification message
     * @param {Object} eventData - Original event data
     */
    async sendSNSNotification(notificationMessage, eventData) {
        try {
            // Create enhanced SNS message with subtitle processing context
            const snsMessage = {
                workflowStatus: this.mapTriggerToWorkflowStatus(notificationMessage.trigger),
                workflowStage: 'SubtitleProcessing',
                guid: eventData.guid,
                trigger: notificationMessage.trigger,
                priority: notificationMessage.priority,
                message: notificationMessage.message,
                timestamp: notificationMessage.timestamp,
                subtitleProcessing: {
                    stage: eventData.stage || 'unknown',
                    estimatedDuration: eventData.estimatedDuration || eventData.duration,
                    processingTime: eventData.processingTime,
                    languageCount: eventData.languageCount,
                    fileCount: eventData.fileCount,
                    errorMessage: eventData.errorMessage,
                    correlationId: eventData.correlationId
                },
                // Include video metadata for context
                srcVideo: eventData.srcVideo,
                srcBucket: eventData.srcBucket,
                destBucket: eventData.destBucket
            };

            const params = {
                Message: JSON.stringify(snsMessage, null, 2),
                Subject: notificationMessage.subject,
                TargetArn: process.env.SnsTopic,
                MessageAttributes: {
                    'WorkflowStage': {
                        DataType: 'String',
                        StringValue: 'SubtitleProcessing'
                    },
                    'Priority': {
                        DataType: 'String',
                        StringValue: notificationMessage.priority
                    },
                    'Trigger': {
                        DataType: 'String',
                        StringValue: notificationMessage.trigger
                    },
                    'GUID': {
                        DataType: 'String',
                        StringValue: eventData.guid || 'unknown'
                    }
                }
            };

            const result = await this.sns.publish(params);
            console.log(`SNS notification sent successfully: ${result.MessageId}`);
            return result;

        } catch (error) {
            console.error('Failed to send SNS notification:', error);
            throw error;
        }
    }

    /**
     * Sends SQS message for subtitle processing tracking and retry logic
     * @param {Object} notificationMessage - Formatted notification message
     * @param {Object} eventData - Original event data
     */
    async sendSQSNotification(notificationMessage, eventData) {
        try {
            // Create SQS message optimized for processing and retry logic
            const sqsMessage = {
                messageType: 'SubtitleProcessingEvent',
                trigger: notificationMessage.trigger,
                priority: notificationMessage.priority,
                guid: eventData.guid,
                timestamp: notificationMessage.timestamp,
                processingData: {
                    stage: eventData.stage,
                    correlationId: eventData.correlationId,
                    estimatedDuration: eventData.estimatedDuration || eventData.duration,
                    processingTime: eventData.processingTime,
                    resourceUsage: eventData.resourceUsage,
                    errorDetails: eventData.errorMessage ? {
                        message: eventData.errorMessage,
                        type: eventData.errorType,
                        retryable: eventData.retryable
                    } : null
                },
                // Include retry information for failed events
                retryInfo: eventData.retryable ? {
                    maxAttempts: eventData.maxRetryAttempts || 3,
                    currentAttempt: eventData.currentAttempt || 1,
                    nextRetryDelay: eventData.nextRetryDelay || 5000
                } : null
            };

            const params = {
                MessageBody: JSON.stringify(sqsMessage, null, 2),
                QueueUrl: process.env.SqsQueue,
                MessageAttributes: {
                    'MessageType': {
                        DataType: 'String',
                        StringValue: 'SubtitleProcessingEvent'
                    },
                    'Trigger': {
                        DataType: 'String',
                        StringValue: notificationMessage.trigger
                    },
                    'Priority': {
                        DataType: 'String',
                        StringValue: notificationMessage.priority
                    },
                    'GUID': {
                        DataType: 'String',
                        StringValue: eventData.guid || 'unknown'
                    },
                    'Stage': {
                        DataType: 'String',
                        StringValue: eventData.stage || 'unknown'
                    },
                    'CorrelationId': {
                        DataType: 'String',
                        StringValue: eventData.correlationId || 'unknown'
                    }
                },
                // Set message delay for retry scenarios
                DelaySeconds: eventData.retryDelay ? Math.min(eventData.retryDelay, 900) : 0
            };

            const result = await this.sqs.sendMessage(params);
            console.log(`SQS message sent successfully: ${result.MessageId}`);
            return result;

        } catch (error) {
            console.error('Failed to send SQS message:', error);
            throw error;
        }
    }

    /**
     * Invokes existing error handler Lambda for compatibility with current system
     * @param {Object} eventData - Original event data
     * @param {Object} notificationMessage - Formatted notification message
     */
    async invokeExistingErrorHandler(eventData, notificationMessage) {
        try {
            // Create payload compatible with existing error handler
            const errorHandlerPayload = {
                guid: eventData.guid,
                event: {
                    guid: eventData.guid,
                    srcVideo: eventData.srcVideo,
                    srcBucket: eventData.srcBucket,
                    destBucket: eventData.destBucket,
                    subtitleProcessing: true,
                    stage: eventData.stage
                },
                function: eventData.functionName || 'SubtitleProcessing',
                error: eventData.errorMessage || notificationMessage.message,
                correlationId: eventData.correlationId,
                errorType: eventData.errorType || 'SUBTITLE_PROCESSING_ERROR',
                stage: eventData.stage || 'subtitle-processing',
                timestamp: notificationMessage.timestamp,
                priority: notificationMessage.priority
            };

            const params = {
                FunctionName: process.env.ErrorHandler,
                Payload: JSON.stringify(errorHandlerPayload, null, 2),
                InvocationType: 'Event' // Asynchronous invocation
            };

            const result = await this.lambda.invoke(params);
            console.log(`Error handler Lambda invoked successfully: ${result.StatusCode}`);
            return result;

        } catch (error) {
            console.error('Failed to invoke error handler Lambda:', error);
            throw error;
        }
    }

    /**
     * Sends progress notification for long-running subtitle processing
     * @param {Object} progressData - Progress information
     */
    async sendProgressNotification(progressData) {
        const eventData = {
            guid: progressData.guid,
            stage: progressData.stage,
            correlationId: progressData.correlationId,
            processingTime: progressData.elapsedTimeSeconds,
            estimatedDuration: progressData.estimatedDurationMinutes,
            progress: progressData.progressPercent,
            resourceUsage: progressData.resourceUsage
        };

        // Determine appropriate trigger based on progress
        let trigger;
        if (progressData.resourceUsage && progressData.resourceUsage.recommendations.timeoutRisk) {
            trigger = NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING;
            eventData.remainingTime = Math.floor(progressData.resourceUsage.remainingTimeMs / 1000);
        } else if (progressData.resourceUsage && progressData.resourceUsage.recommendations.criticalResourceUsage) {
            trigger = NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.RESOURCE_WARNING;
            eventData.resourceType = 'memory';
            eventData.usage = Math.floor(progressData.resourceUsage.memoryUsagePercent * 100);
        } else {
            // Regular progress update - only send for very long videos
            if (progressData.estimatedDurationMinutes < 120) {
                return; // Skip progress notifications for shorter videos
            }
            trigger = 'PROCESSING_PROGRESS'; // Custom trigger for progress updates
        }

        return await this.sendSubtitleProcessingNotification(trigger, eventData, {
            forceNotification: progressData.resourceUsage && 
                             progressData.resourceUsage.recommendations.criticalResourceUsage
        });
    }

    /**
     * Determines if SNS notification should be sent based on priority and options
     * @param {string} priority - Notification priority
     * @param {Object} options - Notification options
     * @returns {boolean} Whether to send SNS notification
     */
    shouldSendSNSNotification(priority, options = {}) {
        if (options.forceNotification) {
            return true;
        }

        // Send SNS for medium priority and above
        return [
            NOTIFICATION_CONFIG.PRIORITY_LEVELS.MEDIUM,
            NOTIFICATION_CONFIG.PRIORITY_LEVELS.HIGH,
            NOTIFICATION_CONFIG.PRIORITY_LEVELS.CRITICAL
        ].includes(priority);
    }

    /**
     * Determines if SQS notification should be sent based on priority and options
     * @param {string} priority - Notification priority
     * @param {Object} options - Notification options
     * @returns {boolean} Whether to send SQS notification
     */
    shouldSendSQSNotification(priority, options = {}) {
        // Send SQS for all events for tracking and retry logic
        return true;
    }

    /**
     * Determines if existing error handler should be invoked
     * @param {string} trigger - Notification trigger
     * @returns {boolean} Whether to invoke error handler
     */
    shouldInvokeErrorHandler(trigger) {
        // Only invoke error handler for failure events
        return [
            NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED,
            NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING,
            NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.RESOURCE_WARNING
        ].includes(trigger);
    }

    /**
     * Maps notification trigger to workflow status for compatibility
     * @param {string} trigger - Notification trigger
     * @returns {string} Workflow status
     */
    mapTriggerToWorkflowStatus(trigger) {
        switch (trigger) {
            case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START:
                return 'Processing';
            case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_COMPLETE:
                return 'Complete';
            case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED:
                return 'Error';
            case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING:
            case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.RESOURCE_WARNING:
                return 'Warning';
            default:
                return 'Processing';
        }
    }

    /**
     * Creates a batch notification for multiple subtitle processing events
     * @param {Array} events - Array of event data objects
     * @param {string} batchType - Type of batch notification
     */
    async sendBatchNotification(events, batchType = 'BATCH_COMPLETE') {
        if (!events || events.length === 0) {
            return;
        }

        const batchData = {
            guid: events[0].guid, // Use first event's GUID as primary
            batchType,
            eventCount: events.length,
            totalProcessingTime: events.reduce((sum, event) => sum + (event.processingTime || 0), 0),
            successCount: events.filter(event => !event.errorMessage).length,
            failureCount: events.filter(event => event.errorMessage).length,
            correlationId: events[0].correlationId,
            timestamp: new Date().toISOString()
        };

        // Send batch notification for multiple subtitle processing events
        await sendSubtitleNotification(
            'BATCH_PROCESSING_COMPLETE',
            batchData,
            { forceNotification: batchData.failureCount > 0 }
        );
    }
}

/**
 * Factory function to create notification integration instance
 * @returns {SubtitleNotificationIntegration} Configured notification integration
 */
function createSubtitleNotificationIntegration() {
    return new SubtitleNotificationIntegration();
}

/**
 * Convenience function for sending subtitle processing notifications
 * @param {string} trigger - Notification trigger
 * @param {Object} eventData - Event data
 * @param {Object} options - Additional options
 */
async function sendSubtitleNotification(trigger, eventData, options = {}) {
    const notificationIntegration = createSubtitleNotificationIntegration();
    return await notificationIntegration.sendSubtitleProcessingNotification(trigger, eventData, options);
}

/**
 * Convenience function for sending progress notifications
 * @param {Object} progressData - Progress data
 */
async function sendProgressNotification(progressData) {
    const notificationIntegration = createSubtitleNotificationIntegration();
    return await notificationIntegration.sendProgressNotification(progressData);
}

module.exports = {
    SubtitleNotificationIntegration,
    createSubtitleNotificationIntegration,
    sendSubtitleNotification,
    sendProgressNotification
};
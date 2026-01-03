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

// Mock AWS SDK clients
const mockSNSPublish = jest.fn();
const mockSQSSendMessage = jest.fn();
const mockLambdaInvoke = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNS: jest.fn(() => ({
        publish: mockSNSPublish
    }))
}));

jest.mock('@aws-sdk/client-sqs', () => ({
    SQS: jest.fn(() => ({
        sendMessage: mockSQSSendMessage
    }))
}));

jest.mock('@aws-sdk/client-lambda', () => ({
    Lambda: jest.fn(() => ({
        invoke: mockLambdaInvoke
    }))
}));

const {
    SubtitleNotificationIntegration,
    createSubtitleNotificationIntegration,
    sendSubtitleNotification,
    sendProgressNotification
} = require('./notification-integration');

const { NOTIFICATION_CONFIG } = require('./performance-optimizer');

describe('Subtitle Notification Integration', () => {
    beforeEach(() => {
        // Set up environment variables
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
        process.env.SnsTopic = 'test-topic-arn';
        process.env.SqsQueue = 'test-queue-url';
        process.env.ErrorHandler = 'test-error-handler';

        // Clear all mocks
        jest.clearAllMocks();
        mockSNSPublish.mockClear();
        mockSQSSendMessage.mockClear();
        mockLambdaInvoke.mockClear();
    });

    afterEach(() => {
        // Clean up environment variables
        delete process.env.SnsTopic;
        delete process.env.SqsQueue;
        delete process.env.ErrorHandler;
    });

    describe('SubtitleNotificationIntegration Class', () => {
        test('should create instance with proper AWS clients', () => {
            const integration = new SubtitleNotificationIntegration();
            expect(integration).toBeInstanceOf(SubtitleNotificationIntegration);
        });

        test('should send SNS notification for high priority events', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSNSPublish.mockResolvedValue({ MessageId: 'test-message-id' });
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const eventData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id',
                processingTime: 300
            };

            const result = await integration.sendSubtitleProcessingNotification(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED,
                eventData
            );

            expect(mockSNSPublish).toHaveBeenCalled();
            expect(mockSQSSendMessage).toHaveBeenCalled();
            expect(result.sns).toBeDefined();
            expect(result.sqs).toBeDefined();
        });

        test('should send SQS notification for all events', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const eventData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id'
            };

            await integration.sendSubtitleProcessingNotification(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
                eventData
            );

            expect(mockSQSSendMessage).toHaveBeenCalled();
            
            const sqsCall = mockSQSSendMessage.mock.calls[0][0];
            expect(sqsCall.QueueUrl).toBe('test-queue-url');
            expect(sqsCall.MessageAttributes.GUID.StringValue).toBe('test-guid-123');
        });

        test('should invoke error handler for failure events', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });
            mockLambdaInvoke.mockResolvedValue({ StatusCode: 200 });

            const eventData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id',
                errorMessage: 'Test error'
            };

            await integration.sendSubtitleProcessingNotification(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED,
                eventData
            );

            expect(mockLambdaInvoke).toHaveBeenCalled();
            
            const lambdaCall = mockLambdaInvoke.mock.calls[0][0];
            expect(lambdaCall.FunctionName).toBe('test-error-handler');
            expect(lambdaCall.InvocationType).toBe('Event');
        });

        test('should handle notification failures gracefully', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSNSPublish.mockRejectedValue(new Error('SNS error'));
            mockSQSSendMessage.mockRejectedValue(new Error('SQS error'));

            const eventData = {
                guid: 'test-guid-123',
                stage: 'transcription'
            };

            const result = await integration.sendSubtitleProcessingNotification(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
                eventData
            );

            expect(result.error).toBeDefined();
            expect(result.error).toContain('Failed to send subtitle processing notification');
        });
    });

    describe('Progress Notifications', () => {
        test('should send timeout warning for critical resource usage', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const progressData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id',
                elapsedTimeSeconds: 600,
                estimatedDurationMinutes: 240,
                resourceUsage: {
                    remainingTimeMs: 30000, // 30 seconds remaining
                    recommendations: {
                        timeoutRisk: true,
                        criticalResourceUsage: false
                    }
                }
            };

            await integration.sendProgressNotification(progressData);

            expect(mockSQSSendMessage).toHaveBeenCalled();
            
            const sqsCall = mockSQSSendMessage.mock.calls[0][0];
            const messageBody = JSON.parse(sqsCall.MessageBody);
            expect(messageBody.trigger).toBe(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING);
        });

        test('should send resource warning for high memory usage', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSNSPublish.mockResolvedValue({ MessageId: 'test-message-id' });
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const progressData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id',
                elapsedTimeSeconds: 600,
                estimatedDurationMinutes: 240,
                resourceUsage: {
                    memoryUsagePercent: 0.95, // 95% memory usage
                    recommendations: {
                        timeoutRisk: false,
                        criticalResourceUsage: true
                    }
                }
            };

            await integration.sendProgressNotification(progressData);

            expect(mockSNSPublish).toHaveBeenCalled(); // Should send SNS for critical resource usage
            expect(mockSQSSendMessage).toHaveBeenCalled();
        });

        test('should skip progress notifications for short videos', async () => {
            const integration = new SubtitleNotificationIntegration();

            const progressData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id',
                elapsedTimeSeconds: 300,
                estimatedDurationMinutes: 60, // Short video
                resourceUsage: {
                    recommendations: {
                        timeoutRisk: false,
                        criticalResourceUsage: false
                    }
                }
            };

            const result = await integration.sendProgressNotification(progressData);

            expect(result).toBeUndefined(); // Should skip notification
            expect(mockSNSPublish).not.toHaveBeenCalled();
            expect(mockSQSSendMessage).not.toHaveBeenCalled();
        });
    });

    describe('Batch Notifications', () => {
        test('should send batch notification for multiple events', async () => {
            const integration = new SubtitleNotificationIntegration();
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const events = [
                { guid: 'test-guid-123', correlationId: 'test-1', processingTime: 100 },
                { guid: 'test-guid-123', correlationId: 'test-2', processingTime: 200, errorMessage: 'Error' },
                { guid: 'test-guid-123', correlationId: 'test-3', processingTime: 150 }
            ];

            await integration.sendBatchNotification(events, 'BATCH_COMPLETE');

            expect(mockSQSSendMessage).toHaveBeenCalled();
            
            const sqsCall = mockSQSSendMessage.mock.calls[0][0];
            const messageBody = JSON.parse(sqsCall.MessageBody);
            expect(messageBody.eventCount).toBe(3);
            expect(messageBody.successCount).toBe(2);
            expect(messageBody.failureCount).toBe(1);
            expect(messageBody.totalProcessingTime).toBe(450);
        });

        test('should handle empty events array', async () => {
            const integration = new SubtitleNotificationIntegration();

            const result = await integration.sendBatchNotification([], 'BATCH_COMPLETE');

            expect(result).toBeUndefined();
            expect(mockSQSSendMessage).not.toHaveBeenCalled();
        });
    });

    describe('Convenience Functions', () => {
        test('sendSubtitleNotification should work correctly', async () => {
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const eventData = {
                guid: 'test-guid-123',
                stage: 'transcription'
            };

            const result = await sendSubtitleNotification(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
                eventData
            );

            expect(result.sqs).toBeDefined();
            expect(mockSQSSendMessage).toHaveBeenCalled();
        });

        test('sendProgressNotification should work correctly', async () => {
            mockSQSSendMessage.mockResolvedValue({ MessageId: 'test-sqs-id' });

            const progressData = {
                guid: 'test-guid-123',
                stage: 'transcription',
                correlationId: 'test-correlation-id',
                elapsedTimeSeconds: 600,
                estimatedDurationMinutes: 240,
                resourceUsage: {
                    recommendations: {
                        timeoutRisk: true,
                        criticalResourceUsage: false
                    }
                }
            };

            const result = await sendProgressNotification(progressData);

            expect(result.sqs).toBeDefined();
            expect(mockSQSSendMessage).toHaveBeenCalled();
        });
    });

    describe('Priority and Channel Logic', () => {
        test('should determine SNS notification correctly based on priority', () => {
            const integration = new SubtitleNotificationIntegration();

            expect(integration.shouldSendSNSNotification('HIGH')).toBe(true);
            expect(integration.shouldSendSNSNotification('MEDIUM')).toBe(true);
            expect(integration.shouldSendSNSNotification('LOW')).toBe(false);
            expect(integration.shouldSendSNSNotification('CRITICAL', { forceNotification: true })).toBe(true);
        });

        test('should always send SQS notifications', () => {
            const integration = new SubtitleNotificationIntegration();

            expect(integration.shouldSendSQSNotification('LOW')).toBe(true);
            expect(integration.shouldSendSQSNotification('HIGH')).toBe(true);
        });

        test('should invoke error handler only for failure events', () => {
            const integration = new SubtitleNotificationIntegration();

            expect(integration.shouldInvokeErrorHandler(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED)).toBe(true);
            expect(integration.shouldInvokeErrorHandler(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING)).toBe(true);
            expect(integration.shouldInvokeErrorHandler(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_COMPLETE)).toBe(false);
        });

        test('should map triggers to workflow status correctly', () => {
            const integration = new SubtitleNotificationIntegration();

            expect(integration.mapTriggerToWorkflowStatus(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START)).toBe('Processing');
            expect(integration.mapTriggerToWorkflowStatus(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_COMPLETE)).toBe('Complete');
            expect(integration.mapTriggerToWorkflowStatus(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED)).toBe('Error');
            expect(integration.mapTriggerToWorkflowStatus(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING)).toBe('Warning');
        });
    });
});
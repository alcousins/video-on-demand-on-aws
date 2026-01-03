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

const {
    SubtitleErrorHandler,
    createSubtitleErrorHandler,
    handleSubtitleError,
    createRetryWrapper
} = require('./subtitle-error-handler');

const {
    SUBTITLE_ERROR_TYPES
} = require('./subtitle-utils');

// Mock AWS SDK clients
const mockDynamoUpdate = jest.fn();
const mockSNSPublish = jest.fn();
const mockSQSSendMessage = jest.fn();
const mockLambdaInvoke = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocument: {
        from: jest.fn(() => ({
            update: mockDynamoUpdate
        }))
    }
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn(() => ({}))
}));

jest.mock('@aws-sdk/client-lambda', () => ({
    Lambda: jest.fn(() => ({
        invoke: mockLambdaInvoke
    }))
}));

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

describe('SubtitleErrorHandler', () => {
    let errorHandler;
    let mockEvent;

    beforeEach(() => {
        // Set up environment variables
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
        process.env.DynamoDBTable = 'test-table';
        process.env.SnsTopic = 'test-topic';
        process.env.SqsQueue = 'test-queue';
        process.env.ErrorHandler = 'test-error-handler';

        errorHandler = new SubtitleErrorHandler();
        mockEvent = {
            guid: 'test-guid-123',
            srcVideo: 'test-video.mp4',
            srcBucket: 'test-bucket'
        };

        // Clear all mocks
        jest.clearAllMocks();
        mockDynamoUpdate.mockClear();
        mockSNSPublish.mockClear();
        mockSQSSendMessage.mockClear();
        mockLambdaInvoke.mockClear();
    });

    describe('Error Classification', () => {
        test('should classify configuration errors correctly', () => {
            const configError = new Error('Invalid configuration parameter');
            const errorType = errorHandler.classifyError(configError, { stage: 'configuration' });
            expect(errorType).toBe(SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR);
        });

        test('should classify transcription errors correctly', () => {
            const transcriptionError = new Error('Transcription job failed');
            const errorType = errorHandler.classifyError(transcriptionError, { stage: 'transcription' });
            expect(errorType).toBe(SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR);
        });

        test('should classify translation errors correctly', () => {
            const translationError = new Error('Translation service unavailable');
            const errorType = errorHandler.classifyError(translationError, { stage: 'translation' });
            expect(errorType).toBe(SUBTITLE_ERROR_TYPES.TRANSLATION_ERROR);
        });

        test('should classify storage errors correctly', () => {
            const storageError = new Error('S3 bucket not found');
            storageError.code = 'NoSuchBucket';
            const errorType = errorHandler.classifyError(storageError);
            expect(errorType).toBe(SUBTITLE_ERROR_TYPES.STORAGE_ERROR);
        });

        test('should classify timeout errors correctly', () => {
            const timeoutError = new Error('Operation timed out');
            timeoutError.name = 'TimeoutError';
            const errorType = errorHandler.classifyError(timeoutError);
            expect(errorType).toBe(SUBTITLE_ERROR_TYPES.TIMEOUT_ERROR);
        });
    });

    describe('Error Handling', () => {
        test('should handle errors with comprehensive logging and notification', async () => {
            const testError = new Error('Test error message');
            const context = {
                stage: 'transcription',
                correlationId: 'test-correlation-id'
            };

            // Mock successful responses
            mockDynamoUpdate.mockResolvedValue({});
            mockSNSPublish.mockResolvedValue({});
            mockSQSSendMessage.mockResolvedValue({});
            mockLambdaInvoke.mockResolvedValue({});

            const result = await errorHandler.handleError(mockEvent, testError, context);

            expect(result).toHaveProperty('correlationId');
            expect(result).toHaveProperty('errorType');
            expect(result).toHaveProperty('errorReport');
            expect(result).toHaveProperty('shouldFailWorkflow');
            expect(result).toHaveProperty('retryable');
            expect(result).toHaveProperty('retryConfig');

            // Verify DynamoDB update was called
            expect(mockDynamoUpdate).toHaveBeenCalled();

            // Verify notifications were sent
            expect(mockSNSPublish).toHaveBeenCalled();
            expect(mockSQSSendMessage).toHaveBeenCalled();
            expect(mockLambdaInvoke).toHaveBeenCalled();
        });

        test('should handle database update failures gracefully', async () => {
            const testError = new Error('Test error message');
            const context = { stage: 'transcription' };

            // Mock DynamoDB update to fail
            mockDynamoUpdate.mockRejectedValue(new Error('DynamoDB error'));

            // Mock other services to succeed
            mockSNSPublish.mockResolvedValue({});
            mockSQSSendMessage.mockResolvedValue({});
            mockLambdaInvoke.mockResolvedValue({});

            // Should not throw even if DynamoDB update fails
            const result = await errorHandler.handleError(mockEvent, testError, context);
            expect(result).toHaveProperty('correlationId');
        });

        test('should handle notification failures gracefully', async () => {
            const testError = new Error('Test error message');
            const context = { stage: 'transcription' };

            // Mock services to fail
            mockDynamoUpdate.mockResolvedValue({});
            mockSNSPublish.mockRejectedValue(new Error('SNS error'));
            mockSQSSendMessage.mockRejectedValue(new Error('SQS error'));
            mockLambdaInvoke.mockRejectedValue(new Error('Lambda error'));

            // Should not throw even if notifications fail
            const result = await errorHandler.handleError(mockEvent, testError, context);
            expect(result).toHaveProperty('correlationId');
        });
    });

    describe('Retry Logic', () => {
        test('should implement exponential backoff retry', async () => {
            const retryConfig = {
                maxAttempts: 3,
                initialDelayMs: 100,
                backoffMultiplier: 2,
                maxDelayMs: 1000
            };

            let attemptCount = 0;
            const operation = jest.fn().mockImplementation(() => {
                attemptCount++;
                if (attemptCount < 3) {
                    throw new Error('Transient error');
                }
                return 'success';
            });

            const result = await errorHandler.retryWithBackoff(operation, retryConfig, {
                operationName: 'testOperation'
            });

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(3);
        });

        test('should fail after max attempts', async () => {
            const retryConfig = {
                maxAttempts: 2,
                initialDelayMs: 10,
                backoffMultiplier: 2,
                maxDelayMs: 100
            };

            const operation = jest.fn().mockRejectedValue(new Error('Persistent error'));

            await expect(
                errorHandler.retryWithBackoff(operation, retryConfig, {
                    operationName: 'testOperation'
                })
            ).rejects.toThrow('Operation failed after 2 attempts');

            expect(operation).toHaveBeenCalledTimes(2);
        });

        test('should create retry wrapper with optimized configuration', () => {
            const retryWrapper = errorHandler.createRetryWrapper('transcription', {
                estimatedDurationMinutes: 120
            });

            expect(typeof retryWrapper).toBe('function');
        });
    });

    describe('Transient Error Handling', () => {
        test('should retry transient errors automatically', async () => {
            const transientError = new Error('Service temporarily unavailable');
            let attemptCount = 0;
            
            const operation = jest.fn().mockImplementation(() => {
                attemptCount++;
                if (attemptCount < 2) {
                    throw transientError;
                }
                return { success: true, result: 'operation completed' };
            });

            // Mock successful error handling for final failure case
            mockDynamoUpdate.mockResolvedValue({});
            mockSNSPublish.mockResolvedValue({});
            mockSQSSendMessage.mockResolvedValue({});
            mockLambdaInvoke.mockResolvedValue({});

            const result = await errorHandler.handleTransientError(
                mockEvent,
                transientError,
                operation,
                { stage: 'transcription' }
            );

            expect(result.success).toBe(true);
            expect(result.result).toBe('operation completed');
            expect(operation).toHaveBeenCalledTimes(2);
        });

        test('should handle non-retryable errors immediately', async () => {
            const nonRetryableError = new Error('Invalid configuration');
            const operation = jest.fn();

            // Mock error handling
            mockDynamoUpdate.mockResolvedValue({});
            mockSNSPublish.mockResolvedValue({});
            mockSQSSendMessage.mockResolvedValue({});
            mockLambdaInvoke.mockResolvedValue({});

            const result = await errorHandler.handleTransientError(
                mockEvent,
                nonRetryableError,
                operation,
                { stage: 'configuration' }
            );

            expect(result).toHaveProperty('errorType');
            expect(operation).not.toHaveBeenCalled();
        });
    });

    describe('Correlation ID Management', () => {
        test('should create correlation ID with proper format', () => {
            const correlationId = SubtitleErrorHandler.createCorrelationId('test-guid', 'transcription');
            
            expect(correlationId).toMatch(/^test-guid-transcription-\d+-[a-z0-9]{6}$/);
        });

        test('should extract existing correlation ID from event', () => {
            const eventWithCorrelationId = {
                ...mockEvent,
                correlationId: 'existing-correlation-id'
            };

            const correlationId = SubtitleErrorHandler.getOrCreateCorrelationId(
                eventWithCorrelationId,
                'transcription'
            );

            expect(correlationId).toBe('existing-correlation-id');
        });

        test('should create new correlation ID when not present', () => {
            const correlationId = SubtitleErrorHandler.getOrCreateCorrelationId(
                mockEvent,
                'transcription'
            );

            expect(correlationId).toMatch(/^test-guid-123-transcription-\d+-[a-z0-9]{6}$/);
        });
    });

    describe('Factory Functions', () => {
        test('should create error handler with configuration', () => {
            const handler = createSubtitleErrorHandler({
                correlationId: 'test-correlation-id'
            });

            expect(handler).toBeInstanceOf(SubtitleErrorHandler);
            expect(handler.correlationId).toBe('test-correlation-id');
        });

        test('should handle subtitle error with convenience function', async () => {
            // Mock error handling
            const mockUpdate = jest.fn().mockResolvedValue({});
            const mockPublish = jest.fn().mockResolvedValue({});
            const mockSendMessage = jest.fn().mockResolvedValue({});
            const mockInvoke = jest.fn().mockResolvedValue({});

            // Mock the constructor to return mocked methods
            jest.spyOn(SubtitleErrorHandler.prototype, 'handleError').mockResolvedValue({
                correlationId: 'test-correlation-id',
                errorType: SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR,
                errorReport: {},
                shouldFailWorkflow: false,
                retryable: true,
                retryConfig: {}
            });

            const testError = new Error('Test error');
            const result = await handleSubtitleError(mockEvent, testError, {
                stage: 'transcription'
            });

            expect(result).toHaveProperty('correlationId');
            expect(result).toHaveProperty('errorType');
        });

        test('should create retry wrapper with convenience function', () => {
            const retryWrapper = createRetryWrapper('translation', {
                segmentCount: 100
            });

            expect(typeof retryWrapper).toBe('function');
        });
    });

    describe('Error Isolation', () => {
        test('should not fail workflow for non-critical errors', async () => {
            const nonCriticalError = new Error('Translation service temporarily unavailable');
            const context = { stage: 'translation' };

            // Mock services
            mockDynamoUpdate.mockResolvedValue({});
            mockSNSPublish.mockResolvedValue({});
            mockSQSSendMessage.mockResolvedValue({});
            mockLambdaInvoke.mockResolvedValue({});

            const result = await errorHandler.handleError(mockEvent, nonCriticalError, context);

            expect(result.shouldFailWorkflow).toBe(false);
        });

        test('should fail workflow for critical configuration errors', async () => {
            const criticalError = new Error('Missing required parameters');
            const context = { 
                stage: 'configuration',
                errorMessage: 'missing required parameters'
            };

            // Mock services
            mockDynamoUpdate.mockResolvedValue({});
            mockSNSPublish.mockResolvedValue({});
            mockSQSSendMessage.mockResolvedValue({});
            mockLambdaInvoke.mockResolvedValue({});

            const result = await errorHandler.handleError(mockEvent, criticalError, context);

            expect(result.shouldFailWorkflow).toBe(true);
        });
    });
});

describe('Integration Tests', () => {
    test('should handle complete error flow with all components', async () => {
        const mockEvent = {
            guid: 'integration-test-guid',
            srcVideo: 'test-video.mp4'
        };

        const testError = new Error('Integration test error');
        
        // Mock all AWS services
        mockDynamoUpdate.mockResolvedValue({});
        mockSNSPublish.mockResolvedValue({});
        mockSQSSendMessage.mockResolvedValue({});
        mockLambdaInvoke.mockResolvedValue({});

        const handler = createSubtitleErrorHandler();

        const result = await handler.handleError(mockEvent, testError, {
            stage: 'transcription',
            functionName: 'test-function'
        });

        // Verify all components were called
        expect(mockDynamoUpdate).toHaveBeenCalled();
        expect(mockSNSPublish).toHaveBeenCalled();
        expect(mockSQSSendMessage).toHaveBeenCalled();
        expect(mockLambdaInvoke).toHaveBeenCalled();

        // Verify result structure
        expect(result).toHaveProperty('correlationId');
        expect(result).toHaveProperty('errorType');
        expect(result).toHaveProperty('errorReport');
        expect(result.errorReport).toHaveProperty('errorType');
        expect(result.errorReport).toHaveProperty('errorMessage');
        expect(result.errorReport).toHaveProperty('timestamp');
        expect(result.errorReport).toHaveProperty('context');
        expect(result.errorReport.context).toHaveProperty('guid');
        expect(result.errorReport.context).toHaveProperty('correlationId');
        expect(result.errorReport.context).toHaveProperty('functionName');
    });
});
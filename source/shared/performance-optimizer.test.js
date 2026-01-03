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
    getVideoDurationCategory,
    calculateOptimizedTranscriptionTimeout,
    getOptimizedMemoryAllocation,
    createOptimizedPollingConfig,
    createOptimizedTranslationBatchConfig,
    estimateVideoDurationFromSize,
    getStepFunctionTimeout,
    createNotificationMessage,
    NOTIFICATION_CONFIG
} = require('./performance-optimizer');

describe('Performance Optimizer', () => {
    describe('Video Duration Categorization', () => {
        test('should categorize short videos correctly', () => {
            expect(getVideoDurationCategory(15 * 60)).toBe('SHORT'); // 15 minutes
            expect(getVideoDurationCategory(30 * 60)).toBe('SHORT'); // 30 minutes
        });

        test('should categorize medium videos correctly', () => {
            expect(getVideoDurationCategory(45 * 60)).toBe('MEDIUM'); // 45 minutes
            expect(getVideoDurationCategory(90 * 60)).toBe('MEDIUM'); // 1.5 hours
        });

        test('should categorize long videos correctly', () => {
            expect(getVideoDurationCategory(120 * 60)).toBe('LONG'); // 2 hours
            expect(getVideoDurationCategory(180 * 60)).toBe('LONG'); // 3 hours
        });

        test('should categorize very long videos correctly', () => {
            expect(getVideoDurationCategory(240 * 60)).toBe('VERY_LONG'); // 4 hours
            expect(getVideoDurationCategory(300 * 60)).toBe('VERY_LONG'); // 5 hours
        });
    });

    describe('Transcription Timeout Optimization', () => {
        test('should calculate appropriate timeouts for different video lengths', () => {
            // Short video (30 minutes)
            const shortTimeout = calculateOptimizedTranscriptionTimeout(30);
            expect(shortTimeout).toBe(20 * 60 * 1000); // 20 minutes

            // Medium video (90 minutes)
            const mediumTimeout = calculateOptimizedTranscriptionTimeout(90);
            expect(mediumTimeout).toBe(45 * 60 * 1000); // 45 minutes

            // Long video (3 hours)
            const longTimeout = calculateOptimizedTranscriptionTimeout(180);
            expect(longTimeout).toBe(90 * 60 * 1000); // 1.5 hours

            // Very long video (4 hours)
            const veryLongTimeout = calculateOptimizedTranscriptionTimeout(240);
            expect(veryLongTimeout).toBe(150 * 60 * 1000); // 2.5 hours
        });

        test('should respect minimum and maximum timeout constraints', () => {
            // Very short video should get minimum timeout
            const minTimeout = calculateOptimizedTranscriptionTimeout(1);
            expect(minTimeout).toBe(20 * 60 * 1000); // 20 minutes minimum (SHORT category)

            // Extremely long video should get maximum timeout
            const maxTimeout = calculateOptimizedTranscriptionTimeout(600); // 10 hours
            expect(maxTimeout).toBe(150 * 60 * 1000); // 2.5 hours for VERY_LONG category
        });
    });

    describe('Memory Allocation Optimization', () => {
        test('should allocate appropriate memory for transcription functions', () => {
            const shortVideoMemory = getOptimizedMemoryAllocation('transcription', { estimatedDurationMinutes: 30 });
            expect(shortVideoMemory).toBe(1024);

            const longVideoMemory = getOptimizedMemoryAllocation('transcription', { estimatedDurationMinutes: 240 });
            expect(longVideoMemory).toBe(3008);
        });

        test('should allocate appropriate memory for translation functions', () => {
            const coordinatorMemory = getOptimizedMemoryAllocation('translationCoordinator');
            expect(coordinatorMemory).toBe(512);

            const lightWorkerMemory = getOptimizedMemoryAllocation('translationWorker', { segmentCount: 100 });
            expect(lightWorkerMemory).toBe(1024);

            const heavyWorkerMemory = getOptimizedMemoryAllocation('translationWorker', { segmentCount: 1000 });
            expect(heavyWorkerMemory).toBe(2048);
        });

        test('should allocate appropriate memory for WebVTT generation', () => {
            const smallFileMemory = getOptimizedMemoryAllocation('webvttGenerator', { fileSize: 500 * 1024 });
            expect(smallFileMemory).toBe(512);

            const largeFileMemory = getOptimizedMemoryAllocation('webvttGenerator', { fileSize: 3 * 1024 * 1024 });
            expect(largeFileMemory).toBe(1536);

            const veryLargeFileMemory = getOptimizedMemoryAllocation('webvttGenerator', { fileSize: 8 * 1024 * 1024 });
            expect(veryLargeFileMemory).toBe(2048);
        });
    });

    describe('Polling Configuration Optimization', () => {
        test('should create optimized polling config for different video lengths', () => {
            const shortConfig = createOptimizedPollingConfig(30);
            expect(shortConfig.initialDelayMs).toBe(10000); // 10 seconds
            expect(shortConfig.maxDelayMs).toBe(60000); // 1 minute
            expect(shortConfig.backoffMultiplier).toBe(1.3);

            const veryLongConfig = createOptimizedPollingConfig(240);
            expect(veryLongConfig.initialDelayMs).toBe(120000); // 2 minutes
            expect(veryLongConfig.maxDelayMs).toBe(900000); // 15 minutes
            expect(veryLongConfig.backoffMultiplier).toBe(2.0);
        });

        test('should include appropriate timeout in polling config', () => {
            const config = createOptimizedPollingConfig(120);
            expect(config.timeoutMs).toBe(90 * 60 * 1000); // 1.5 hours for 2-hour video
        });
    });

    describe('Translation Batch Optimization', () => {
        test('should create optimized batch config for different segment counts', () => {
            // Small transcript
            const smallConfig = createOptimizedTranslationBatchConfig(50, 30);
            expect(smallConfig.batchSize).toBe(50);
            expect(smallConfig.maxConcurrentRequests).toBe(15);

            // Large transcript with long video
            const largeConfig = createOptimizedTranslationBatchConfig(1000, 240);
            expect(largeConfig.batchSize).toBe(15); // LARGE_TRANSCRIPT category
            expect(largeConfig.maxConcurrentRequests).toBe(5);
            expect(largeConfig.batchDelayMs).toBe(1000);
        });

        test('should calculate correct number of batches', () => {
            const config = createOptimizedTranslationBatchConfig(100, 60);
            expect(config.totalBatches).toBe(Math.ceil(100 / config.batchSize));
        });
    });

    describe('Video Duration Estimation', () => {
        test('should estimate duration from file size and format', () => {
            // 100MB MP4 file
            const mp4Duration = estimateVideoDurationFromSize(100 * 1024 * 1024, 'mp4');
            expect(mp4Duration).toBeGreaterThan(0);
            expect(mp4Duration).toBeLessThanOrEqual(240); // Max 4 hours

            // Same size M2TS should be shorter duration (higher bitrate)
            const m2tsDuration = estimateVideoDurationFromSize(100 * 1024 * 1024, 'm2ts');
            expect(m2tsDuration).toBeLessThan(mp4Duration);
        });

        test('should respect minimum and maximum duration constraints', () => {
            // Very small file should get minimum 1 minute
            const minDuration = estimateVideoDurationFromSize(1024, 'mp4');
            expect(minDuration).toBe(1);

            // Very large file should be capped at 240 minutes
            const maxDuration = estimateVideoDurationFromSize(10 * 1024 * 1024 * 1024, 'mp4'); // 10GB
            expect(maxDuration).toBe(240);
        });
    });

    describe('Step Function Timeout Configuration', () => {
        test('should provide appropriate timeouts for different task types', () => {
            const transcriptionTimeout = getStepFunctionTimeout('transcription', { estimatedDurationMinutes: 240 });
            expect(transcriptionTimeout).toBe(270); // 4.5 hours for very long video

            const coordinatorTimeout = getStepFunctionTimeout('translationCoordinator');
            expect(coordinatorTimeout).toBe(15);

            const workerTimeout = getStepFunctionTimeout('translationWorker', { estimatedDurationMinutes: 240 });
            expect(workerTimeout).toBe(26); // Increased for very long videos

            const webvttTimeout = getStepFunctionTimeout('webvttGenerator');
            expect(webvttTimeout).toBe(20);
        });
    });

    describe('Notification Message Creation', () => {
        test('should create properly formatted notification messages', () => {
            const eventData = {
                guid: 'test-guid-123',
                duration: 120,
                processingTime: 300,
                languageCount: 3
            };

            const message = createNotificationMessage(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
                eventData
            );

            expect(message.trigger).toBe(NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START);
            expect(message.message).toContain('test-guid-123');
            expect(message.message).toContain('120 minutes');
            expect(message.priority).toBe(NOTIFICATION_CONFIG.PRIORITY_LEVELS.MEDIUM);
            expect(message.subject).toContain('test-guid-123');
        });

        test('should assign appropriate priorities to different triggers', () => {
            const failureMessage = createNotificationMessage(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED,
                { guid: 'test' }
            );
            expect(failureMessage.priority).toBe(NOTIFICATION_CONFIG.PRIORITY_LEVELS.HIGH);

            const completeMessage = createNotificationMessage(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_COMPLETE,
                { guid: 'test' }
            );
            expect(completeMessage.priority).toBe(NOTIFICATION_CONFIG.PRIORITY_LEVELS.LOW);
        });

        test('should handle missing template variables gracefully', () => {
            const message = createNotificationMessage(
                NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_START,
                { guid: 'test-guid' } // Missing duration
            );

            expect(message.message).toContain('test-guid');
            expect(message.message).toContain('{duration}'); // Template variable not replaced
        });
    });
});
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
 * Performance optimization utilities for subtitle processing
 * Supports videos up to 4 hours in length with optimized resource management
 */

/**
 * Enhanced performance configurations for 4-hour video support
 */
const ENHANCED_PERFORMANCE_CONFIG = {
    // Video duration thresholds for performance optimization
    VIDEO_DURATION_THRESHOLDS: {
        SHORT: 30 * 60, // 30 minutes in seconds
        MEDIUM: 90 * 60, // 1.5 hours in seconds
        LONG: 180 * 60, // 3 hours in seconds
        VERY_LONG: 240 * 60 // 4 hours in seconds
    },

    // Transcription timeout configurations for different video lengths
    TRANSCRIPTION_TIMEOUTS: {
        // Base timeout for short videos (up to 30 minutes)
        SHORT_VIDEO_TIMEOUT_MS: 20 * 60 * 1000, // 20 minutes
        // Timeout for medium videos (30 minutes to 1.5 hours)
        MEDIUM_VIDEO_TIMEOUT_MS: 45 * 60 * 1000, // 45 minutes
        // Timeout for long videos (1.5 to 3 hours)
        LONG_VIDEO_TIMEOUT_MS: 90 * 60 * 1000, // 1.5 hours
        // Timeout for very long videos (3 to 4 hours)
        VERY_LONG_VIDEO_TIMEOUT_MS: 150 * 60 * 1000, // 2.5 hours
        // Absolute maximum timeout
        MAX_TIMEOUT_MS: 180 * 60 * 1000, // 3 hours maximum
        // Minimum timeout regardless of video length
        MIN_TIMEOUT_MS: 10 * 60 * 1000 // 10 minutes minimum
    },

    // Lambda timeout configurations for Step Functions
    STEP_FUNCTION_TIMEOUTS: {
        TRANSCRIPTION_TASK_TIMEOUT_MINUTES: 180, // 3 hours for very long videos
        TRANSLATION_COORDINATOR_TIMEOUT_MINUTES: 15, // 15 minutes for large transcripts
        TRANSLATION_WORKER_TIMEOUT_MINUTES: 20, // 20 minutes for many segments
        WEBVTT_GENERATOR_TIMEOUT_MINUTES: 20 // 20 minutes for large files
    },

    // Memory optimization based on video characteristics
    MEMORY_OPTIMIZATION: {
        // Memory allocation based on estimated processing load
        TRANSCRIPTION_MEMORY: {
            SHORT: 1024, // MB for short videos
            MEDIUM: 1536, // MB for medium videos
            LONG: 2048, // MB for long videos
            VERY_LONG: 3008 // MB for very long videos (max Lambda memory)
        },
        TRANSLATION_MEMORY: {
            COORDINATOR: 512, // MB for coordination tasks
            WORKER_LIGHT: 1024, // MB for small translation batches
            WORKER_HEAVY: 2048 // MB for large translation batches
        },
        WEBVTT_MEMORY: {
            SMALL_FILE: 512, // MB for small WebVTT files
            LARGE_FILE: 1536, // MB for large WebVTT files
            VERY_LARGE_FILE: 2048 // MB for very large WebVTT files
        }
    },

    // Polling optimization for long-running transcription jobs
    POLLING_OPTIMIZATION: {
        // Initial polling intervals based on video length
        INITIAL_POLL_INTERVALS: {
            SHORT: 10 * 1000, // 10 seconds for short videos
            MEDIUM: 30 * 1000, // 30 seconds for medium videos
            LONG: 60 * 1000, // 1 minute for long videos
            VERY_LONG: 120 * 1000 // 2 minutes for very long videos
        },
        // Maximum polling intervals
        MAX_POLL_INTERVALS: {
            SHORT: 60 * 1000, // 1 minute max for short videos
            MEDIUM: 300 * 1000, // 5 minutes max for medium videos
            LONG: 600 * 1000, // 10 minutes max for long videos
            VERY_LONG: 900 * 1000 // 15 minutes max for very long videos
        },
        // Backoff multipliers for different video lengths
        BACKOFF_MULTIPLIERS: {
            SHORT: 1.3, // Gentle backoff for short videos
            MEDIUM: 1.5, // Standard backoff for medium videos
            LONG: 1.8, // Aggressive backoff for long videos
            VERY_LONG: 2.0 // Maximum backoff for very long videos
        }
    },

    // Translation batch optimization
    TRANSLATION_BATCH_OPTIMIZATION: {
        // Batch sizes based on total segment count
        BATCH_SIZES: {
            SMALL_TRANSCRIPT: 50, // segments per batch for small transcripts
            MEDIUM_TRANSCRIPT: 25, // segments per batch for medium transcripts
            LARGE_TRANSCRIPT: 15, // segments per batch for large transcripts
            VERY_LARGE_TRANSCRIPT: 10 // segments per batch for very large transcripts
        },
        // Concurrent request limits based on video length
        CONCURRENT_LIMITS: {
            SHORT: 15, // concurrent requests for short videos
            MEDIUM: 12, // concurrent requests for medium videos
            LONG: 8, // concurrent requests for long videos
            VERY_LONG: 5 // concurrent requests for very long videos
        },
        // Delays between batches to avoid rate limiting
        BATCH_DELAYS: {
            SHORT: 100, // ms delay for short videos
            MEDIUM: 200, // ms delay for medium videos
            LONG: 500, // ms delay for long videos
            VERY_LONG: 1000 // ms delay for very long videos
        }
    },

    // Resource management thresholds
    RESOURCE_MANAGEMENT: {
        // Memory usage thresholds for optimization decisions
        MEMORY_THRESHOLDS: {
            LOW_USAGE: 0.6, // 60% memory usage
            MEDIUM_USAGE: 0.75, // 75% memory usage
            HIGH_USAGE: 0.9 // 90% memory usage
        },
        // CPU usage thresholds
        CPU_THRESHOLDS: {
            LOW_USAGE: 0.5, // 50% CPU usage
            MEDIUM_USAGE: 0.7, // 70% CPU usage
            HIGH_USAGE: 0.85 // 85% CPU usage
        },
        // Lambda timeout buffer (time to reserve for cleanup)
        TIMEOUT_BUFFER_MS: 30 * 1000 // 30 seconds buffer
    }
};

/**
 * Notification integration configurations
 */
const NOTIFICATION_CONFIG = {
    // Notification priorities based on processing stage and video length
    PRIORITY_LEVELS: {
        LOW: 'LOW',
        MEDIUM: 'MEDIUM',
        HIGH: 'HIGH',
        CRITICAL: 'CRITICAL'
    },

    // Notification triggers for different events
    NOTIFICATION_TRIGGERS: {
        PROCESSING_START: 'PROCESSING_START',
        TRANSCRIPTION_COMPLETE: 'TRANSCRIPTION_COMPLETE',
        TRANSLATION_COMPLETE: 'TRANSLATION_COMPLETE',
        WEBVTT_COMPLETE: 'WEBVTT_COMPLETE',
        PROCESSING_COMPLETE: 'PROCESSING_COMPLETE',
        PROCESSING_FAILED: 'PROCESSING_FAILED',
        TIMEOUT_WARNING: 'TIMEOUT_WARNING',
        RESOURCE_WARNING: 'RESOURCE_WARNING'
    },

    // Message templates for different notification types
    MESSAGE_TEMPLATES: {
        PROCESSING_START: 'Subtitle processing started for video {guid} (estimated duration: {duration} minutes)',
        TRANSCRIPTION_COMPLETE: 'Transcription completed for video {guid} in {processingTime} seconds',
        TRANSLATION_COMPLETE: 'Translation completed for video {guid} - {languageCount} languages processed',
        WEBVTT_COMPLETE: 'WebVTT generation completed for video {guid} - {fileCount} files created',
        PROCESSING_COMPLETE: 'Subtitle processing completed successfully for video {guid} (total time: {totalTime} seconds)',
        PROCESSING_FAILED: 'Subtitle processing failed for video {guid}: {errorMessage}',
        TIMEOUT_WARNING: 'Subtitle processing timeout warning for video {guid} - {remainingTime} seconds remaining',
        RESOURCE_WARNING: 'Resource usage warning for video {guid} - {resourceType} at {usage}%'
    }
};

/**
 * Determines video duration category based on estimated duration
 * @param {number} durationSeconds - Estimated video duration in seconds
 * @returns {string} Duration category (SHORT, MEDIUM, LONG, VERY_LONG)
 */
function getVideoDurationCategory(durationSeconds) {
    const thresholds = ENHANCED_PERFORMANCE_CONFIG.VIDEO_DURATION_THRESHOLDS;
    
    if (durationSeconds <= thresholds.SHORT) {
        return 'SHORT';
    } else if (durationSeconds <= thresholds.MEDIUM) {
        return 'MEDIUM';
    } else if (durationSeconds <= thresholds.LONG) {
        return 'LONG';
    } else {
        return 'VERY_LONG';
    }
}

/**
 * Calculates optimized transcription timeout based on video duration
 * @param {number} estimatedDurationMinutes - Estimated video duration in minutes
 * @returns {number} Optimized timeout in milliseconds
 */
function calculateOptimizedTranscriptionTimeout(estimatedDurationMinutes) {
    const durationSeconds = estimatedDurationMinutes * 60;
    const category = getVideoDurationCategory(durationSeconds);
    const timeouts = ENHANCED_PERFORMANCE_CONFIG.TRANSCRIPTION_TIMEOUTS;
    
    let timeout;
    switch (category) {
        case 'SHORT':
            timeout = timeouts.SHORT_VIDEO_TIMEOUT_MS;
            break;
        case 'MEDIUM':
            timeout = timeouts.MEDIUM_VIDEO_TIMEOUT_MS;
            break;
        case 'LONG':
            timeout = timeouts.LONG_VIDEO_TIMEOUT_MS;
            break;
        case 'VERY_LONG':
            timeout = timeouts.VERY_LONG_VIDEO_TIMEOUT_MS;
            break;
        default:
            timeout = timeouts.MEDIUM_VIDEO_TIMEOUT_MS;
    }
    
    // Apply min/max constraints
    return Math.max(
        timeouts.MIN_TIMEOUT_MS,
        Math.min(timeout, timeouts.MAX_TIMEOUT_MS)
    );
}

/**
 * Gets optimized memory allocation for Lambda function based on video characteristics
 * @param {string} functionType - Type of Lambda function (transcription, translation, webvtt)
 * @param {Object} videoCharacteristics - Video characteristics object
 * @returns {number} Recommended memory allocation in MB
 */
function getOptimizedMemoryAllocation(functionType, videoCharacteristics = {}) {
    const { estimatedDurationMinutes = 60, segmentCount = 100, fileSize = 0 } = videoCharacteristics;
    const durationSeconds = estimatedDurationMinutes * 60;
    const category = getVideoDurationCategory(durationSeconds);
    const memoryConfig = ENHANCED_PERFORMANCE_CONFIG.MEMORY_OPTIMIZATION;
    
    switch (functionType) {
        case 'transcription':
            return memoryConfig.TRANSCRIPTION_MEMORY[category] || memoryConfig.TRANSCRIPTION_MEMORY.MEDIUM;
            
        case 'translationCoordinator':
            return memoryConfig.TRANSLATION_MEMORY.COORDINATOR;
            
        case 'translationWorker':
            // Choose memory based on expected batch size
            const isHeavyLoad = segmentCount > 500 || category === 'VERY_LONG';
            return isHeavyLoad ? 
                memoryConfig.TRANSLATION_MEMORY.WORKER_HEAVY : 
                memoryConfig.TRANSLATION_MEMORY.WORKER_LIGHT;
                
        case 'webvttGenerator':
            // Choose memory based on expected file size
            if (fileSize > 5 * 1024 * 1024) { // > 5MB
                return memoryConfig.WEBVTT_MEMORY.VERY_LARGE_FILE;
            } else if (fileSize > 1 * 1024 * 1024) { // > 1MB
                return memoryConfig.WEBVTT_MEMORY.LARGE_FILE;
            } else {
                return memoryConfig.WEBVTT_MEMORY.SMALL_FILE;
            }
            
        default:
            return 1024; // Default 1GB
    }
}

/**
 * Creates optimized polling configuration for transcription jobs
 * @param {number} estimatedDurationMinutes - Estimated video duration in minutes
 * @returns {Object} Optimized polling configuration
 */
function createOptimizedPollingConfig(estimatedDurationMinutes) {
    const durationSeconds = estimatedDurationMinutes * 60;
    const category = getVideoDurationCategory(durationSeconds);
    const pollingConfig = ENHANCED_PERFORMANCE_CONFIG.POLLING_OPTIMIZATION;
    
    return {
        initialDelayMs: pollingConfig.INITIAL_POLL_INTERVALS[category],
        maxDelayMs: pollingConfig.MAX_POLL_INTERVALS[category],
        backoffMultiplier: pollingConfig.BACKOFF_MULTIPLIERS[category],
        maxAttempts: Math.max(20, Math.floor(estimatedDurationMinutes / 2)), // More attempts for longer videos
        timeoutMs: calculateOptimizedTranscriptionTimeout(estimatedDurationMinutes)
    };
}

/**
 * Creates optimized translation batch configuration
 * @param {number} totalSegments - Total number of text segments to translate
 * @param {number} estimatedDurationMinutes - Estimated video duration in minutes
 * @returns {Object} Optimized batch configuration
 */
function createOptimizedTranslationBatchConfig(totalSegments, estimatedDurationMinutes) {
    const durationSeconds = estimatedDurationMinutes * 60;
    const category = getVideoDurationCategory(durationSeconds);
    const batchConfig = ENHANCED_PERFORMANCE_CONFIG.TRANSLATION_BATCH_OPTIMIZATION;
    
    // Determine transcript size category
    let transcriptCategory;
    if (totalSegments <= 100) {
        transcriptCategory = 'SMALL_TRANSCRIPT';
    } else if (totalSegments <= 500) {
        transcriptCategory = 'MEDIUM_TRANSCRIPT';
    } else if (totalSegments <= 1500) {
        transcriptCategory = 'LARGE_TRANSCRIPT';
    } else {
        transcriptCategory = 'VERY_LARGE_TRANSCRIPT';
    }
    
    return {
        batchSize: batchConfig.BATCH_SIZES[transcriptCategory],
        maxConcurrentRequests: batchConfig.CONCURRENT_LIMITS[category],
        batchDelayMs: batchConfig.BATCH_DELAYS[category],
        totalBatches: Math.ceil(totalSegments / batchConfig.BATCH_SIZES[transcriptCategory])
    };
}

/**
 * Monitors resource usage and provides optimization recommendations
 * @param {Object} context - Lambda context object
 * @param {number} startTime - Processing start time
 * @returns {Object} Resource monitoring data and recommendations
 */
function monitorResourceUsage(context, startTime) {
    const currentTime = Date.now();
    const elapsedTime = currentTime - startTime;
    const remainingTime = context.getRemainingTimeInMillis ? context.getRemainingTimeInMillis() : 0;
    
    // Calculate resource usage percentages
    const timeUsagePercent = remainingTime > 0 ? 
        (elapsedTime / (elapsedTime + remainingTime)) : 1.0;
    
    // Memory usage estimation (simplified - would need actual memory monitoring in production)
    const memoryUsagePercent = process.memoryUsage().heapUsed / process.memoryUsage().heapTotal;
    
    const thresholds = ENHANCED_PERFORMANCE_CONFIG.RESOURCE_MANAGEMENT;
    
    return {
        elapsedTimeMs: elapsedTime,
        remainingTimeMs: remainingTime,
        timeUsagePercent,
        memoryUsagePercent,
        recommendations: {
            shouldOptimizeMemory: memoryUsagePercent > thresholds.MEMORY_THRESHOLDS.HIGH_USAGE,
            shouldReduceBatchSize: memoryUsagePercent > thresholds.MEMORY_THRESHOLDS.MEDIUM_USAGE,
            shouldIncreasePollingInterval: timeUsagePercent > 0.7,
            timeoutRisk: remainingTime < thresholds.TIMEOUT_BUFFER_MS,
            criticalResourceUsage: timeUsagePercent > 0.9 || memoryUsagePercent > thresholds.MEMORY_THRESHOLDS.HIGH_USAGE
        }
    };
}

/**
 * Creates notification message for subtitle processing events
 * @param {string} trigger - Notification trigger type
 * @param {Object} eventData - Event data for message templating
 * @returns {Object} Formatted notification message
 */
function createNotificationMessage(trigger, eventData) {
    const template = NOTIFICATION_CONFIG.MESSAGE_TEMPLATES[trigger];
    if (!template) {
        throw new Error(`Unknown notification trigger: ${trigger}`);
    }
    
    // Replace template variables with actual data
    let message = template;
    Object.keys(eventData).forEach(key => {
        const placeholder = `{${key}}`;
        if (message.includes(placeholder)) {
            message = message.replace(new RegExp(placeholder, 'g'), eventData[key]);
        }
    });
    
    // Determine priority based on trigger and video characteristics
    let priority = NOTIFICATION_CONFIG.PRIORITY_LEVELS.MEDIUM;
    
    switch (trigger) {
        case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_FAILED:
        case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.TIMEOUT_WARNING:
            priority = NOTIFICATION_CONFIG.PRIORITY_LEVELS.HIGH;
            break;
        case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.RESOURCE_WARNING:
            priority = NOTIFICATION_CONFIG.PRIORITY_LEVELS.CRITICAL;
            break;
        case NOTIFICATION_CONFIG.NOTIFICATION_TRIGGERS.PROCESSING_COMPLETE:
            priority = NOTIFICATION_CONFIG.PRIORITY_LEVELS.LOW;
            break;
        default:
            priority = NOTIFICATION_CONFIG.PRIORITY_LEVELS.MEDIUM;
    }
    
    return {
        trigger,
        message,
        priority,
        timestamp: new Date().toISOString(),
        eventData,
        subject: `Subtitle Processing ${trigger}: ${eventData.guid || 'Unknown'}`
    };
}

/**
 * Estimates video duration from file size and format
 * Enhanced version with better accuracy for different formats
 * @param {number} fileSizeBytes - File size in bytes
 * @param {string} videoFormat - Video format (mp4, mov, etc.)
 * @returns {number} Estimated duration in minutes
 */
function estimateVideoDurationFromSize(fileSizeBytes, videoFormat = 'mp4') {
    // Enhanced bitrate estimates based on format and typical encoding
    const formatBitrates = {
        'mp4': 2500000, // 2.5 Mbps average for MP4
        'mov': 3000000, // 3 Mbps average for MOV (often higher quality)
        'm4v': 2500000, // Similar to MP4
        'mpg': 4000000, // 4 Mbps for MPEG (older, less efficient)
        'm2ts': 8000000 // 8 Mbps for M2TS (broadcast quality)
    };
    
    const estimatedBitrate = formatBitrates[videoFormat.toLowerCase()] || formatBitrates['mp4'];
    
    // Convert file size to bits and calculate duration
    const fileSizeBits = fileSizeBytes * 8;
    const durationSeconds = fileSizeBits / estimatedBitrate;
    const durationMinutes = Math.max(1, Math.round(durationSeconds / 60)); // Minimum 1 minute
    
    // Cap at 4 hours (240 minutes) as per requirements
    return Math.min(durationMinutes, 240);
}

/**
 * Creates Step Function timeout configuration for different tasks
 * @param {string} taskType - Type of Step Function task
 * @param {Object} videoCharacteristics - Video characteristics for optimization
 * @returns {number} Timeout in minutes for Step Function task
 */
function getStepFunctionTimeout(taskType, videoCharacteristics = {}) {
    const { estimatedDurationMinutes = 60 } = videoCharacteristics;
    const category = getVideoDurationCategory(estimatedDurationMinutes * 60);
    const baseTimeouts = ENHANCED_PERFORMANCE_CONFIG.STEP_FUNCTION_TIMEOUTS;
    
    switch (taskType) {
        case 'transcription':
            // Scale timeout based on video length
            const multiplier = category === 'VERY_LONG' ? 1.5 : 
                              category === 'LONG' ? 1.2 : 1.0;
            return Math.floor(baseTimeouts.TRANSCRIPTION_TASK_TIMEOUT_MINUTES * multiplier);
            
        case 'translationCoordinator':
            return baseTimeouts.TRANSLATION_COORDINATOR_TIMEOUT_MINUTES;
            
        case 'translationWorker':
            // Increase timeout for longer videos with more segments
            const workerMultiplier = category === 'VERY_LONG' ? 1.3 : 1.0;
            return Math.floor(baseTimeouts.TRANSLATION_WORKER_TIMEOUT_MINUTES * workerMultiplier);
            
        case 'webvttGenerator':
            return baseTimeouts.WEBVTT_GENERATOR_TIMEOUT_MINUTES;
            
        default:
            return 15; // Default 15 minutes
    }
}

module.exports = {
    ENHANCED_PERFORMANCE_CONFIG,
    NOTIFICATION_CONFIG,
    getVideoDurationCategory,
    calculateOptimizedTranscriptionTimeout,
    getOptimizedMemoryAllocation,
    createOptimizedPollingConfig,
    createOptimizedTranslationBatchConfig,
    monitorResourceUsage,
    createNotificationMessage,
    estimateVideoDurationFromSize,
    getStepFunctionTimeout
};
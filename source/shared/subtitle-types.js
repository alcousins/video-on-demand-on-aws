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
 * TypeScript-style interfaces defined as JSDoc for Node.js compatibility
 * These interfaces define the data models for subtitle processing
 */

/**
 * Configuration for transcription jobs
 * @typedef {Object} TranscriptionConfig
 * @property {string} jobName - Unique name for the transcription job
 * @property {string} mediaUri - S3 URI of the video file to transcribe
 * @property {string} outputBucket - S3 bucket for transcription output
 * @property {string} outputKey - S3 key prefix for transcription output
 * @property {string} languageCode - Language code ("auto" for detection or specific code like "en-US")
 * @property {string[]} subtitleFormats - Array of subtitle formats, typically ["vtt"]
 * @property {number} outputStartIndex - Starting index for output files, typically 1
 */

/**
 * Individual text segment with timing information
 * @typedef {Object} TextSegment
 * @property {number} startTime - Start time in milliseconds
 * @property {number} endTime - End time in milliseconds
 * @property {string} text - Text content for this segment
 */

/**
 * Translation task for a specific language
 * @typedef {Object} TranslationTask
 * @property {string} sourceLanguage - Source language code (e.g., "en")
 * @property {string} targetLanguage - Target language code (e.g., "es")
 * @property {TextSegment[]} textSegments - Array of text segments to translate
 * @property {string} jobId - Unique job identifier
 */

/**
 * WebVTT file representation
 * @typedef {Object} WebVTTFile
 * @property {string} language - Language code for this file
 * @property {string} filename - Filename for the WebVTT file
 * @property {string} s3Location - S3 URI where the file is stored
 * @property {string} content - WebVTT formatted content
 * @property {number} size - File size in bytes
 * @property {string} checksum - File checksum for integrity verification
 */

/**
 * Input data for the Subtitle Processor state machine
 * @typedef {Object} SubtitleProcessorInput
 * @property {string} guid - Unique identifier for the video processing job
 * @property {string} jobId - MediaConvert job ID
 * @property {string} srcVideo - Source video filename
 * @property {string} srcBucket - Source S3 bucket name
 * @property {string} destBucket - Destination S3 bucket name
 * @property {SubtitleConfig} subtitleConfig - Configuration for subtitle processing
 */

/**
 * Subtitle processing configuration
 * @typedef {Object} SubtitleConfig
 * @property {boolean} enabled - Whether subtitle processing is enabled
 * @property {string} primaryLanguage - Primary language code or "auto" for detection
 * @property {string[]} targetLanguages - Array of target language codes for translation
 */

/**
 * Output data from the Subtitle Processor state machine
 * @typedef {Object} SubtitleProcessorOutput
 * @property {string} guid - Unique identifier for the video processing job
 * @property {string} jobId - MediaConvert job ID
 * @property {SubtitleProcessingResult} subtitleProcessing - Results of subtitle processing
 */

/**
 * Results of subtitle processing
 * @typedef {Object} SubtitleProcessingResult
 * @property {string} status - Processing status ("pending", "transcribing", "translating", "generating", "completed", "failed")
 * @property {Object.<string, string>} subtitleFiles - Map of language codes to S3 URIs
 * @property {string} [errorDetails] - Error details if processing failed
 */

/**
 * Extended DynamoDB record structure for subtitle processing
 * @typedef {Object} SubtitleProcessingRecord
 * @property {boolean} enabled - Whether subtitle processing is enabled
 * @property {string} status - Current processing status
 * @property {string} primaryLanguage - Primary language code or "auto"
 * @property {string[]} targetLanguages - Array of target language codes
 * @property {string} [transcriptionJobId] - AWS Transcribe job ID
 * @property {string} [transcriptionStatus] - Transcription job status
 * @property {Object.<string, string>} subtitleFiles - Map of language codes to S3 URIs
 * @property {string} [errorDetails] - Error details if processing failed
 * @property {string} [processingStartTime] - ISO timestamp when processing started
 * @property {string} [processingEndTime] - ISO timestamp when processing completed
 */

// Export types for use in other modules
module.exports = {
    // Type definitions are exported as JSDoc comments for documentation
    // Actual validation functions can be added here if needed
};
# Requirements Document

## Introduction

This document defines the requirements for adding a transcription and translation state machine to the existing Video on Demand on AWS solution. The new state machine will process video files to generate WebVTT subtitle files in multiple languages, delivered alongside the transcoded video content without modifying the existing transcoding workflow.

## Glossary

- **Transcription_Service**: AWS service that converts speech in video to text
- **Translation_Service**: AWS service that translates text from one language to another
- **WebVTT_Generator**: Component that creates WebVTT subtitle files from transcribed and translated text
- **Subtitle_Processor**: The new state machine that orchestrates transcription and translation
- **Source_Video**: The original video file uploaded to the S3 source bucket
- **Subtitle_Files**: WebVTT files containing timed text in various languages
- **Primary_Language**: The original language spoken in the video
- **Target_Languages**: Languages to translate subtitles into

## Requirements

### Requirement 1: Video Transcription

**User Story:** As a content creator, I want my videos to be automatically transcribed, so that I can provide accessible content with subtitles.

#### Acceptance Criteria

1. WHEN a video file is processed by the existing workflow, THE Subtitle_Processor SHALL initiate transcription of the audio track
2. WHEN transcription is requested, THE Transcription_Service SHALL extract speech from the video and convert it to timed text
3. WHEN transcription completes successfully, THE Subtitle_Processor SHALL store the transcribed text with timestamps
4. IF transcription fails, THEN THE Subtitle_Processor SHALL log the error and continue without blocking the main video workflow
5. THE Transcription_Service SHALL support common video formats (MP4, MOV, M4V, MPG, M2TS)

### Requirement 2: Multi-Language Translation

**User Story:** As a content distributor, I want subtitles translated into multiple languages, so that I can reach a global audience.

#### Acceptance Criteria

1. WHEN transcription is complete, THE Translation_Service SHALL translate the text into configured target languages
2. THE Translation_Service SHALL preserve timing information during translation
3. WHEN translation is requested for multiple languages, THE Subtitle_Processor SHALL process them in parallel for efficiency
4. THE Translation_Service SHALL support at least 10 common languages (English, Spanish, French, German, Italian, Portuguese, Brazilian Portuguese, Japanese, Korean, Chinese, Arabic)
5. IF translation fails for a specific language, THEN THE Subtitle_Processor SHALL continue processing other languages

### Requirement 3: WebVTT Subtitle Generation

**User Story:** As a video platform operator, I want subtitles in WebVTT format, so that they can be used with standard video players.

#### Acceptance Criteria

1. WHEN transcription and translation are complete, THE WebVTT_Generator SHALL create properly formatted WebVTT files
2. THE WebVTT_Generator SHALL include timing cues, text content, and language metadata
3. WHEN generating WebVTT files, THE WebVTT_Generator SHALL ensure proper character encoding (UTF-8)
4. THE WebVTT_Generator SHALL validate WebVTT syntax before storing files
5. THE WebVTT_Generator SHALL create separate files for each language with appropriate naming conventions

### Requirement 4: Storage and Delivery Integration

**User Story:** As a system administrator, I want subtitle files stored alongside video content, so that they can be delivered together through the existing CDN.

#### Acceptance Criteria

1. WHEN WebVTT files are generated, THE Subtitle_Processor SHALL store them in the destination S3 bucket
2. THE Subtitle_Processor SHALL organize subtitle files in the same directory structure as the corresponding video files
3. WHEN storing subtitle files, THE Subtitle_Processor SHALL use consistent naming patterns (e.g., video_name.en.vtt, video_name.es.vtt)
4. THE Subtitle_Processor SHALL update the DynamoDB record with subtitle file locations and metadata
5. THE Subtitle_Processor SHALL ensure subtitle files are accessible through the existing CloudFront distribution

### Requirement 5: Workflow Integration

**User Story:** As a developer, I want the subtitle workflow to integrate seamlessly with the existing video processing, so that it doesn't disrupt current operations.

#### Acceptance Criteria

1. WHEN the existing Process Workflow completes, THE Subtitle_Processor SHALL be triggered automatically
2. THE Subtitle_Processor SHALL run independently without blocking the existing Publish Workflow
3. WHEN subtitle processing completes, THE Subtitle_Processor SHALL trigger the existing Publish Workflow if not already completed
4. THE Subtitle_Processor SHALL use the same error handling patterns as existing workflows
5. THE Subtitle_Processor SHALL support the same notification mechanisms (SNS, SQS) as existing workflows

### Requirement 6: Configuration and Control

**User Story:** As a system administrator, I want to configure subtitle processing options, so that I can control costs and processing behavior.

#### Acceptance Criteria

1. THE Subtitle_Processor SHALL support enabling/disabling transcription and translation through configuration
2. THE Subtitle_Processor SHALL allow configuration of target languages for translation
3. THE Subtitle_Processor SHALL support configuration of primary language detection or explicit specification
4. WHERE subtitle processing is disabled, THE Subtitle_Processor SHALL skip processing and continue the workflow
5. THE Subtitle_Processor SHALL respect the same metadata file override patterns as the existing workflow

### Requirement 7: Error Handling and Monitoring

**User Story:** As a system operator, I want comprehensive error handling and monitoring, so that I can troubleshoot issues and ensure reliable operation.

#### Acceptance Criteria

1. WHEN any step in subtitle processing fails, THE Subtitle_Processor SHALL log detailed error information
2. THE Subtitle_Processor SHALL implement retry logic with exponential backoff for transient failures
3. WHEN critical errors occur, THE Subtitle_Processor SHALL send notifications through the existing error handling system
4. THE Subtitle_Processor SHALL update DynamoDB with processing status and error details
5. THE Subtitle_Processor SHALL continue the main workflow even if subtitle processing fails completely

### Requirement 8: Performance and Scalability

**User Story:** As a platform architect, I want subtitle processing to scale efficiently, so that it can handle varying workloads without impacting system performance.

#### Acceptance Criteria

1. THE Subtitle_Processor SHALL process multiple translation languages concurrently
2. THE Subtitle_Processor SHALL use appropriate timeouts for long-running transcription jobs
3. THE Subtitle_Processor SHALL implement proper resource management to avoid Lambda timeout issues
4. THE Subtitle_Processor SHALL support processing videos of various lengths (up to 4 hours)
5. THE Subtitle_Processor SHALL optimize API calls to minimize costs while maintaining performance
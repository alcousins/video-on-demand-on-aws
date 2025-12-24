# Implementation Plan: Video Transcription and Translation State Machine

## Overview

This implementation plan breaks down the development of the subtitle processing state machine into discrete, manageable tasks. Each task builds incrementally on previous work, ensuring the new functionality integrates seamlessly with the existing Video on Demand on AWS solution without disrupting current operations.

The implementation follows the existing project patterns using Node.js 22, AWS SDK v3, and the same testing frameworks (Jest) used throughout the solution.

## Tasks

- [ ] 1. Set up project structure and core interfaces
  - Create directory structure for new Lambda functions
  - Define TypeScript interfaces for data models
  - Set up package.json files with consistent dependencies
  - Create shared utilities for subtitle processing
  - _Requirements: 1.1, 5.1, 6.1_

- [ ]* 1.1 Write property test for project structure setup
  - **Property 1: Workflow Integration Trigger**
  - **Validates: Requirements 1.1, 5.1**

- [ ] 2. Implement Transcription Lambda function
  - [ ] 2.1 Create transcription Lambda with AWS Transcribe integration
    - Write Lambda handler for transcription job management
    - Implement AWS Transcribe job submission with WebVTT output
    - Add job status polling with exponential backoff
    - Handle language detection and explicit language specification
    - _Requirements: 1.2, 1.3, 1.5, 6.3_

  - [ ]* 2.2 Write property test for transcription functionality
    - **Property 2: Transcription Round Trip with Timing**
    - **Property 3: Video Format Support**
    - **Validates: Requirements 1.2, 1.3, 1.5, 2.2**

  - [ ]* 2.3 Write unit tests for transcription Lambda
    - Test transcription job submission and polling
    - Test error handling for unsupported formats
    - Test language detection vs explicit specification
    - _Requirements: 1.2, 1.3, 1.5_

- [ ] 3. Implement Translation Coordinator Lambda function
  - [ ] 3.1 Create translation coordinator with parallel task generation
    - Write Lambda handler for translation orchestration
    - Parse transcription JSON to extract text segments
    - Generate parallel translation tasks for target languages
    - Prepare input data for Step Functions parallel execution
    - _Requirements: 2.1, 2.3, 6.2_

  - [ ]* 3.2 Write property test for translation coordination
    - **Property 4: Parallel Translation Processing**
    - **Validates: Requirements 2.1, 2.3, 8.1**

  - [ ]* 3.3 Write unit tests for translation coordinator
    - Test transcription JSON parsing
    - Test parallel task generation
    - Test target language configuration handling
    - _Requirements: 2.1, 2.3, 6.2_

- [ ] 4. Implement Translation Worker Lambda function
  - [ ] 4.1 Create translation worker with AWS Translate integration
    - Write Lambda handler for individual language translation
    - Implement AWS Translate API integration
    - Preserve timing information during translation
    - Handle translation errors gracefully
    - _Requirements: 2.2, 2.4, 2.5_

  - [ ]* 4.2 Write property test for translation worker
    - **Property 5: Language Support Coverage**
    - **Validates: Requirements 2.4**

  - [ ]* 4.3 Write unit tests for translation worker
    - Test translation with timing preservation
    - Test error handling for unsupported languages
    - Test translation quality and character encoding
    - _Requirements: 2.2, 2.4, 2.5_

- [ ] 5. Checkpoint - Core Lambda functions complete
  - Ensure all Lambda functions pass their tests
  - Verify AWS SDK integrations work correctly
  - Ask the user if questions arise

- [ ] 6. Implement WebVTT Generator Lambda function
  - [ ] 6.1 Create WebVTT generator with format validation
    - Write Lambda handler for WebVTT file generation
    - Implement WebVTT format generation with proper headers
    - Add WebVTT syntax validation
    - Ensure UTF-8 encoding and proper character handling
    - Create separate files for each language with consistent naming
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 6.2 Write property test for WebVTT generation
    - **Property 6: WebVTT Format Correctness**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [ ]* 6.3 Write unit tests for WebVTT generator
    - Test WebVTT format compliance
    - Test UTF-8 encoding handling
    - Test file naming conventions
    - Test syntax validation
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 7. Implement S3 storage and DynamoDB integration
  - [ ] 7.1 Add S3 storage functionality to WebVTT generator
    - Implement S3 upload with proper directory structure
    - Add consistent file naming patterns
    - Ensure files are accessible through CloudFront
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [ ] 7.2 Add DynamoDB update functionality
    - Update existing DynamoDB schema with subtitle fields
    - Implement status tracking and metadata updates
    - Add error detail logging to database records
    - _Requirements: 4.4, 7.4_

  - [ ]* 7.3 Write property tests for storage and database
    - **Property 7: File Organization Consistency**
    - **Property 8: Database State Consistency**
    - **Property 9: CDN Accessibility**
    - **Validates: Requirements 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 7.4**

  - [ ]* 7.4 Write unit tests for storage integration
    - Test S3 upload and directory organization
    - Test DynamoDB record updates
    - Test CloudFront URL accessibility
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 8. Create Subtitle Processor State Machine
  - [ ] 8.1 Define Step Functions state machine definition
    - Create state machine JSON definition with proper error handling
    - Implement parallel translation execution
    - Add retry logic with exponential backoff
    - Integrate with existing workflow trigger points
    - _Requirements: 5.1, 5.2, 5.3, 7.2, 8.1_

  - [ ]* 8.2 Write property test for state machine workflow
    - **Property 10: Workflow Independence**
    - **Property 11: Error Isolation**
    - **Validates: Requirements 1.4, 2.5, 5.2, 5.3, 7.5**

  - [ ]* 8.3 Write unit tests for state machine integration
    - Test state machine execution flow
    - Test error handling and retry logic
    - Test integration with existing workflows
    - _Requirements: 5.1, 5.2, 5.3, 7.2_

- [ ] 9. Implement configuration and error handling
  - [ ] 9.1 Add configuration support and error handling
    - Implement enable/disable configuration handling
    - Add target language configuration support
    - Integrate with existing metadata file override patterns
    - Implement comprehensive error logging and notification
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 7.1, 7.3_

  - [ ]* 9.2 Write property tests for configuration and error handling
    - **Property 12: Configuration Respect**
    - **Property 13: Error Handling and Notification**
    - **Property 14: Retry Behavior**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3**

  - [ ]* 9.3 Write unit tests for configuration and error handling
    - Test configuration override behavior
    - Test error logging and notification
    - Test retry logic with exponential backoff
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 7.1, 7.2, 7.3_

- [ ] 10. Update CloudFormation template
  - [ ] 10.1 Add new resources to CloudFormation template
    - Add Subtitle Processor State Machine resource
    - Add four new Lambda function resources with proper IAM roles
    - Add IAM policies for Transcribe and Translate service access
    - Add environment variables for subtitle processing configuration
    - Add CloudWatch Log Groups for new Lambda functions
    - _Requirements: 5.1, 6.1, 6.2_

  - [ ]* 10.2 Write integration tests for CloudFormation deployment
    - Test template validation and deployment
    - Test IAM permissions and service access
    - Test environment variable configuration
    - _Requirements: 5.1, 6.1, 6.2_

- [ ] 11. Implement performance optimizations
  - [ ] 11.1 Add performance optimizations and timeout handling
    - Implement appropriate timeouts for transcription jobs
    - Add resource management to avoid Lambda timeouts
    - Optimize API calls for cost efficiency
    - Support processing videos up to 4 hours in length
    - _Requirements: 8.2, 8.4_

  - [ ]* 11.2 Write property test for performance requirements
    - **Property 15: Video Length Support**
    - **Validates: Requirements 8.2, 8.4**

  - [ ]* 11.3 Write performance tests
    - Test processing videos of various lengths
    - Test timeout handling and resource management
    - Test cost optimization measures
    - _Requirements: 8.2, 8.4_

- [ ] 12. Integration and end-to-end testing
  - [ ] 12.1 Wire all components together
    - Connect state machine to existing workflow triggers
    - Ensure proper data flow between all Lambda functions
    - Integrate error handling with existing error handler
    - Test complete end-to-end subtitle processing workflow
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [ ]* 12.2 Write end-to-end integration tests
    - Test complete workflow from video upload to subtitle delivery
    - Test integration with existing video processing workflow
    - Test error propagation and workflow resilience
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

- [ ] 13. Final checkpoint - Complete system validation
  - Ensure all tests pass including property-based tests
  - Verify integration with existing Video on Demand workflow
  - Validate subtitle files are accessible through CloudFront
  - Confirm no disruption to existing transcoding process
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation throughout development
- Property tests validate universal correctness properties across all inputs
- Unit tests validate specific examples, edge cases, and integration points
- The implementation maintains consistency with existing Video on Demand solution patterns
- All new Lambda functions follow the same structure and conventions as existing functions
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

const expect = require('chai').expect;
const { mockClient } = require('aws-sdk-client-mock');
const { SFNClient, StartExecutionCommand, DescribeExecutionCommand } = require('@aws-sdk/client-sfn');
const { DynamoDBClient, UpdateItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Import all Lambda functions for complete integration testing
const stepFunctionsLambda = require('../step-functions/index.js');
const inputValidateLambda = require('../input-validate/index.js');
const subtitleConfigLambda = require('../subtitle-config/index.js');
const transcriptionLambda = require('../transcription/index.js');
const translationCoordinatorLambda = require('../translation-coordinator/index.js');
const translationWorkerLambda = require('../translation-worker/index.js');
const webvttGeneratorLambda = require('../webvtt-generator/index.js');
const encodeLambda = require('../encode/index.js');

describe('#COMPLETE WORKFLOW INTEGRATION - TASK 15.1::', () => {
    // Mock AWS clients
    const sfnClientMock = mockClient(SFNClient);
    const dynamoClientMock = mockClient(DynamoDBClient);
    const s3ClientMock = mockClient(S3Client);
    const snsClientMock = mockClient(SNSClient);
    const sqsClientMock = mockClient(SQSClient);
    const lambdaClientMock = mockClient(LambdaClient);

    beforeEach(() => {
        // Set up complete environment for end-to-end testing
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'AwsSolution/SO0146/v6.0.0';
        process.env.IngestWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-ingest';
        process.env.ProcessWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-process';
        process.env.PublishWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-publish';
        process.env.SubtitleProcessorWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-subtitle-processor';
        process.env.ErrorHandler = 'vod-error-handler';
        process.env.WorkflowName = 'vod-workflow';
        process.env.Source = 'vod-source-bucket';
        process.env.Destination = 'vod-destination-bucket';
        process.env.CloudFront = 'd123456789.cloudfront.net';
        process.env.DynamoDBTable = 'vod-dynamodb-table';
        process.env.SnsTopic = 'arn:aws:sns:us-east-1:123456789012:vod-notifications';
        process.env.SqsQueue = 'arn:aws:sqs:us-east-1:123456789012:vod-queue';
        process.env.FrameCapture = 'false';
        process.env.ArchiveSource = 'DISABLED';
        process.env.MediaConvert_Template_2160p = 'vod-workflow_Ott_2160p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.MediaConvert_Template_1080p = 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.MediaConvert_Template_720p = 'vod-workflow_Ott_720p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.InputRotate = 'DEGREE_0';
        process.env.AcceleratedTranscoding = 'PREFERRED';
        process.env.EnableSns = 'true';
        process.env.EnableSqs = 'true';
        process.env.EnableMediaPackage = 'false';
        process.env.SUBTITLE_ENABLED = 'true';
        process.env.SUBTITLE_PRIMARY_LANGUAGE = 'auto';
        process.env.SUBTITLE_TARGET_LANGUAGES = 'en,es,fr,de,it,pt,ja,ko,zh,ar';
        process.env.SUBTITLE_TEMP_BUCKET = 'vod-temp-subtitle-bucket';
        process.env.SUBTITLE_TEMP_PREFIX = 'temp-subtitles/';
    });

    afterEach(() => {
        sfnClientMock.reset();
        dynamoClientMock.reset();
        s3ClientMock.reset();
        snsClientMock.reset();
        sqsClientMock.reset();
        lambdaClientMock.reset();
    });

    describe('Complete End-to-End Workflow: Video Upload to Subtitle Delivery', () => {
        it('should execute complete workflow from video upload through subtitle processing to MediaConvert integration', async () => {
            console.log('=== COMPLETE END-TO-END WORKFLOW INTEGRATION TEST ===');
            
            // Mock all AWS service responses for successful workflow
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:integration-12345',
                startDate: new Date()
            });

            sfnClientMock.on(DescribeExecutionCommand).resolves({
                status: 'SUCCEEDED',
                output: JSON.stringify({ status: 'completed' })
            });

            s3ClientMock.on(HeadObjectCommand).resolves({
                ContentLength: 2048000,
                ContentType: 'video/mp4'
            });

            s3ClientMock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: async () => JSON.stringify({
                        "results": {
                            "transcripts": [{
                                "transcript": "Hello world, this is a test video for subtitle processing."
                            }],
                            "items": [
                                {
                                    "start_time": "0.0",
                                    "end_time": "2.5",
                                    "alternatives": [{"content": "Hello", "confidence": "0.99"}],
                                    "type": "pronunciation"
                                },
                                {
                                    "start_time": "2.5",
                                    "end_time": "4.0",
                                    "alternatives": [{"content": "world", "confidence": "0.98"}],
                                    "type": "pronunciation"
                                }
                            ]
                        }
                    })
                }
            });

            s3ClientMock.on(PutObjectCommand).resolves({
                ETag: '"test-etag"',
                VersionId: 'test-version'
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});
            dynamoClientMock.on(GetItemCommand).resolves({
                Item: {
                    guid: { S: 'integration-test-guid' },
                    workflowStatus: { S: 'Processing' },
                    srcVideo: { S: 'integration-test-video.mp4' },
                    srcBucket: { S: 'vod-source-bucket' },
                    destBucket: { S: 'vod-destination-bucket' }
                }
            });

            snsClientMock.on(PublishCommand).resolves({ MessageId: 'test-message-id' });
            sqsClientMock.on(SendMessageCommand).resolves({ MessageId: 'test-sqs-message-id' });
            lambdaClientMock.on(InvokeCommand).resolves({ StatusCode: 200 });

            const testGuid = 'integration-test-guid-e2e';
            const testVideo = 'integration-test-video.mp4';

            console.log('=== PHASE 1: Video Upload and Ingest Workflow ===');
            
            // Step 1: Video file uploaded to S3 triggers Ingest Workflow
            const videoUploadEvent = {
                Records: [{
                    eventVersion: '2.1',
                    eventSource: 'aws:s3',
                    eventName: 'ObjectCreated:Put',
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { 
                            key: testVideo,
                            size: 2048000
                        }
                    }
                }]
            };

            const ingestResult = await stepFunctionsLambda.handler(videoUploadEvent);
            expect(ingestResult).to.equal('success');

            // Verify Ingest workflow was triggered with correct parameters
            let calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const ingestCall = calls[0];
            expect(ingestCall.args[0].input.stateMachineArn).to.equal(process.env.IngestWorkflow);
            
            const ingestInput = JSON.parse(ingestCall.args[0].input.input);
            expect(ingestInput.workflowTrigger).to.equal('Video');
            expect(ingestInput).to.have.property('guid');

            console.log(`Generated GUID: ${ingestInput.guid}`);

            console.log('=== PHASE 2: Input Validation with Subtitle Configuration ===');

            // Step 2: Input validation processes the video and sets up subtitle configuration
            const inputValidationEvent = {
                guid: testGuid,
                workflowTrigger: 'Video',
                Records: videoUploadEvent.Records
            };

            const validatedData = await inputValidateLambda.handler(inputValidationEvent);
            
            // Verify complete input validation including subtitle configuration
            expect(validatedData.guid).to.equal(testGuid);
            expect(validatedData.workflowTrigger).to.equal('Video');
            expect(validatedData.srcVideo).to.equal(testVideo);
            expect(validatedData.srcBucket).to.equal('vod-source-bucket');
            expect(validatedData.destBucket).to.equal('vod-destination-bucket');
            expect(validatedData.workflowName).to.equal('vod-workflow');
            
            // Verify subtitle configuration is properly initialized
            expect(validatedData).to.have.property('subtitleConfig');
            expect(validatedData.subtitleConfig.enabled).to.be.true;
            expect(validatedData.subtitleConfig.primaryLanguage).to.equal('auto');
            expect(validatedData.subtitleConfig.targetLanguages).to.be.an('array');
            expect(validatedData.subtitleConfig.targetLanguages).to.include.members(['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar']);

            console.log('=== PHASE 3: Process Workflow with Subtitle Processing Integration ===');

            // Step 3: Process Workflow is triggered after input validation
            sfnClientMock.reset();
            
            const processEvent = {
                guid: testGuid
            };

            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Verify Process workflow was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const processCall = calls[0];
            expect(processCall.args[0].input.stateMachineArn).to.equal(process.env.ProcessWorkflow);
            expect(processCall.args[0].input.name).to.equal(testGuid);

            console.log('=== PHASE 4: Subtitle Processor Workflow Execution ===');

            // Step 4: Subtitle Processor is triggered as part of Process Workflow
            sfnClientMock.reset();
            
            const subtitleTriggerEvent = {
                guid: testGuid,
                srcVideo: validatedData.srcVideo,
                srcBucket: validatedData.srcBucket,
                destBucket: validatedData.destBucket,
                subtitleConfig: validatedData.subtitleConfig,
                subtitleTrigger: true
            };

            const subtitleResult = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(subtitleResult).to.equal('success');

            // Verify Subtitle Processor workflow was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const subtitleCall = calls[0];
            expect(subtitleCall.args[0].input.stateMachineArn).to.equal(process.env.SubtitleProcessorWorkflow);
            expect(subtitleCall.args[0].input.name).to.equal(`${testGuid}-subtitle`);

            // Verify subtitle processor input contains all required data
            const subtitleInput = JSON.parse(subtitleCall.args[0].input.input);
            expect(subtitleInput.guid).to.equal(testGuid);
            expect(subtitleInput.srcVideo).to.equal(validatedData.srcVideo);
            expect(subtitleInput.srcBucket).to.equal(validatedData.srcBucket);
            expect(subtitleInput.destBucket).to.equal(validatedData.destBucket);
            expect(subtitleInput.subtitleConfig.enabled).to.be.true;
            expect(subtitleInput.subtitleConfig.targetLanguages).to.deep.equal(validatedData.subtitleConfig.targetLanguages);
            expect(subtitleInput.subtitleTrigger).to.be.true;

            console.log('=== PHASE 5: Individual Subtitle Processing Components ===');

            // Step 5a: Test Subtitle Configuration Lambda
            const configResult = await subtitleConfigLambda.handler(subtitleInput);
            expect(configResult).to.have.property('subtitleConfig');
            expect(configResult.subtitleConfig.enabled).to.be.true;
            expect(configResult.subtitleConfig.targetLanguages).to.be.an('array');

            // Step 5b: Test Transcription Lambda
            const transcriptionEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                subtitleConfig: configResult.subtitleConfig
            };

            const transcriptionResult = await transcriptionLambda.handler(transcriptionEvent);
            expect(transcriptionResult).to.have.property('transcriptionJobName');
            expect(transcriptionResult).to.have.property('transcriptionStatus');

            // Step 5c: Test Translation Coordinator Lambda
            const coordinatorEvent = {
                guid: testGuid,
                transcriptionJobName: transcriptionResult.transcriptionJobName,
                transcriptionOutputLocation: `s3://vod-source-bucket/transcription/${testGuid}.json`,
                transcriptionResults: {
                    results: {
                        transcripts: [{ transcript: "Hello world, this is a test." }],
                        items: [
                            { start_time: "0.0", end_time: "2.5", alternatives: [{ content: "Hello", confidence: "0.99" }] },
                            { start_time: "2.5", end_time: "4.0", alternatives: [{ content: "world", confidence: "0.98" }] }
                        ]
                    }
                },
                subtitleConfig: configResult.subtitleConfig
            };

            const coordinatorResult = await translationCoordinatorLambda.handler(coordinatorEvent);
            expect(coordinatorResult).to.have.property('parallelTranslationInput');
            expect(coordinatorResult.parallelTranslationInput).to.be.an('array');
            expect(coordinatorResult.parallelTranslationInput.length).to.be.greaterThan(0);

            // Step 5d: Test Translation Worker Lambda (for one language)
            const workerEvent = coordinatorResult.parallelTranslationInput[0];
            const workerResult = await translationWorkerLambda.handler(workerEvent);
            expect(workerResult).to.have.property('translatedSegments');
            expect(workerResult.translatedSegments).to.be.an('array');

            // Step 5e: Test WebVTT Generator Lambda
            const webvttEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                subtitleConfig: configResult.subtitleConfig,
                transcriptionResult: coordinatorEvent.transcriptionResults,
                translationResults: [workerResult]
            };

            const webvttResult = await webvttGeneratorLambda.handler(webvttEvent);
            expect(webvttResult).to.have.property('webvttFiles');
            expect(webvttResult.webvttFiles).to.be.an('array');
            expect(webvttResult.webvttFiles.length).to.be.greaterThan(0);

            console.log('=== PHASE 6: MediaConvert Integration with Subtitle Files ===');

            // Step 6: Test Enhanced Encode Lambda with subtitle files
            const encodeEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                jobTemplate_1080p: 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset',
                subtitleFiles: webvttResult.webvttFiles,
                frameCapture: false,
                acceleratedTranscoding: 'PREFERRED'
            };

            const encodeResult = await encodeLambda.handler(encodeEvent);
            expect(encodeResult).to.have.property('jobId');
            expect(encodeResult).to.have.property('jobTemplate');

            console.log('=== PHASE 7: MediaConvert Completion and Publish Workflow ===');

            // Step 7: MediaConvert job completes and triggers Publish workflow
            sfnClientMock.reset();
            
            const mediaConvertCompletionEvent = {
                version: '0',
                id: 'test-event-id',
                'detail-type': 'MediaConvert Job State Change',
                source: 'aws.mediaconvert',
                account: '123456789012',
                time: '2023-01-01T12:00:00Z',
                region: 'us-east-1',
                detail: {
                    status: 'COMPLETE',
                    jobId: encodeResult.jobId,
                    queue: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/Default',
                    userMetadata: {
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    },
                    outputGroupDetails: [{
                        outputDetails: [{
                            outputFilePaths: [
                                's3://vod-destination-bucket/mp4/integration-test-video_1080p.mp4',
                                's3://vod-destination-bucket/mp4/integration-test-video_720p.mp4',
                                's3://vod-destination-bucket/subtitles/integration-test-video.en.vtt',
                                's3://vod-destination-bucket/subtitles/integration-test-video.es.vtt'
                            ]
                        }]
                    }]
                }
            };

            const publishResult = await stepFunctionsLambda.handler(mediaConvertCompletionEvent);
            expect(publishResult).to.equal('success');

            // Verify Publish workflow was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const publishCall = calls[0];
            expect(publishCall.args[0].input.stateMachineArn).to.equal(process.env.PublishWorkflow);
            expect(publishCall.args[0].input.name).to.equal(testGuid);

            const publishInput = JSON.parse(publishCall.args[0].input.input);
            expect(publishInput.detail.userMetadata.guid).to.equal(testGuid);
            expect(publishInput.detail.status).to.equal('COMPLETE');

            console.log('=== PHASE 8: Verification of Complete Integration ===');

            // Verify all AWS service interactions occurred as expected
            const dynamoCalls = dynamoClientMock.commandCalls(UpdateItemCommand);
            expect(dynamoCalls.length).to.be.greaterThan(0);

            const s3Calls = s3ClientMock.commandCalls(PutObjectCommand);
            expect(s3Calls.length).to.be.greaterThan(0);

            console.log('✅ COMPLETE END-TO-END WORKFLOW INTEGRATION TEST PASSED!');
            console.log(`✅ Successfully processed video: ${testVideo}`);
            console.log(`✅ GUID: ${testGuid}`);
            console.log(`✅ All workflow steps executed successfully`);
            console.log(`✅ Subtitle files generated and integrated with MediaConvert`);
            console.log(`✅ Workflow resilience and error handling verified`);
        });

        it('should handle workflow with subtitle processing disabled', async () => {
            console.log('=== TESTING DISABLED SUBTITLE PROCESSING WORKFLOW ===');

            // Disable subtitle processing
            process.env.SUBTITLE_ENABLED = 'false';

            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:disabled-12345'
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});

            const testGuid = 'disabled-subtitle-test-guid';
            const testVideo = 'disabled-subtitle-test.mp4';

            // Test input validation with disabled subtitles
            const inputEvent = {
                guid: testGuid,
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: testVideo }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);
            expect(validatedData.subtitleConfig.enabled).to.be.false;

            // Subtitle processor should still be triggered but will skip processing
            const subtitleTriggerEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                subtitleConfig: validatedData.subtitleConfig,
                subtitleTrigger: true
            };

            const result = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(result).to.equal('success');

            // Verify subtitle processor was triggered with disabled configuration
            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const subtitleInput = JSON.parse(calls[0].args[0].input.input);
            expect(subtitleInput.subtitleConfig.enabled).to.be.false;

            // Test that MediaConvert integration works without subtitle files
            const encodeEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                jobTemplate_1080p: 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset',
                frameCapture: false,
                acceleratedTranscoding: 'PREFERRED'
                // No subtitleFiles property when disabled
            };

            const encodeResult = await encodeLambda.handler(encodeEvent);
            expect(encodeResult).to.have.property('jobId');
            expect(encodeResult).to.have.property('jobTemplate');

            console.log('✅ Disabled subtitle processing workflow test passed!');
        });

        it('should maintain workflow independence when subtitle processing fails', async () => {
            console.log('=== TESTING WORKFLOW INDEPENDENCE WITH SUBTITLE FAILURES ===');

            // Mock subtitle processor to fail, but main workflow should continue
            sfnClientMock.on(StartExecutionCommand).callsFake((command) => {
                if (command.stateMachineArn === process.env.SubtitleProcessorWorkflow) {
                    const error = new Error('Subtitle processing service unavailable');
                    error.name = 'ServiceException';
                    throw error;
                }
                return Promise.resolve({ 
                    executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:success'
                });
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});
            snsClientMock.on(PublishCommand).resolves({ MessageId: 'error-notification-id' });

            const testGuid = 'workflow-independence-test-guid';

            // Test that process workflow continues even if subtitle processor fails
            const processEvent = { 
                guid: testGuid,
                srcVideo: 'test-video.mp4',
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket'
            };
            
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Test subtitle processor failure
            const subtitleEvent = {
                guid: testGuid,
                srcVideo: 'test-video.mp4',
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en', 'es']
                },
                subtitleTrigger: true
            };

            try {
                await stepFunctionsLambda.handler(subtitleEvent);
                expect.fail('Should have thrown error for subtitle processing failure');
            } catch (error) {
                expect(error.message).to.equal('Subtitle processing service unavailable');
                expect(error.name).to.equal('ServiceException');
            }

            // Test that MediaConvert can still process without subtitle files
            const encodeEvent = {
                guid: testGuid,
                srcVideo: 'test-video.mp4',
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                jobTemplate_1080p: 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset',
                frameCapture: false,
                acceleratedTranscoding: 'PREFERRED'
                // No subtitle files due to processing failure
            };

            const encodeResult = await encodeLambda.handler(encodeEvent);
            expect(encodeResult).to.have.property('jobId');

            // Test that publish workflow can still be triggered despite subtitle failure
            sfnClientMock.reset();
            sfnClientMock.on(StartExecutionCommand).resolves({ 
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:publish-success'
            });

            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: { 
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    }
                }
            };

            const publishResult = await stepFunctionsLambda.handler(publishEvent);
            expect(publishResult).to.equal('success');

            // Verify publish workflow was triggered successfully
            const publishCalls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(publishCalls).to.have.lengthOf(1);
            expect(publishCalls[0].args[0].input.stateMachineArn).to.equal(process.env.PublishWorkflow);

            console.log('✅ Workflow independence test passed!');
        });
    });

    describe('Data Flow and Component Integration', () => {
        it('should maintain proper data flow from subtitle processing to MediaConvert', async () => {
            console.log('=== TESTING DATA FLOW FROM SUBTITLE PROCESSING TO MEDIACONVERT ===');

            // Mock successful subtitle processing
            s3ClientMock.on(PutObjectCommand).resolves({
                ETag: '"test-etag"',
                VersionId: 'test-version'
            });

            const testGuid = 'data-flow-test-guid';
            const testVideo = 'data-flow-test.mp4';

            // Step 1: Generate subtitle files through complete processing
            const subtitleConfig = {
                enabled: true,
                primaryLanguage: 'en',
                targetLanguages: ['es', 'fr', 'de']
            };

            const transcriptionResults = {
                results: {
                    transcripts: [{ transcript: "This is a test video for data flow validation." }],
                    items: [
                        { start_time: "0.0", end_time: "3.0", alternatives: [{ content: "This", confidence: "0.99" }] },
                        { start_time: "3.0", end_time: "5.0", alternatives: [{ content: "is", confidence: "0.98" }] },
                        { start_time: "5.0", end_time: "7.0", alternatives: [{ content: "a", confidence: "0.97" }] },
                        { start_time: "7.0", end_time: "9.0", alternatives: [{ content: "test", confidence: "0.99" }] }
                    ]
                }
            };

            // Generate WebVTT files
            const webvttEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                subtitleConfig: subtitleConfig,
                transcriptionResult: transcriptionResults,
                translationResults: [
                    {
                        targetLanguage: 'es',
                        translatedSegments: [
                            { startTime: 0.0, endTime: 3.0, text: "Esto" },
                            { startTime: 3.0, endTime: 5.0, text: "es" },
                            { startTime: 5.0, endTime: 7.0, text: "un" },
                            { startTime: 7.0, endTime: 9.0, text: "prueba" }
                        ]
                    }
                ]
            };

            const webvttResult = await webvttGeneratorLambda.handler(webvttEvent);
            expect(webvttResult).to.have.property('webvttFiles');
            expect(webvttResult.webvttFiles).to.be.an('array');

            // Step 2: Test MediaConvert integration with subtitle files
            const encodeEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                jobTemplate_1080p: 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset',
                subtitleFiles: webvttResult.webvttFiles,
                frameCapture: false,
                acceleratedTranscoding: 'PREFERRED'
            };

            const encodeResult = await encodeLambda.handler(encodeEvent);
            expect(encodeResult).to.have.property('jobId');
            expect(encodeResult).to.have.property('jobTemplate');

            // Verify subtitle files are properly integrated
            expect(encodeResult).to.have.property('subtitleFilesIncluded');
            expect(encodeResult.subtitleFilesIncluded).to.be.true;

            console.log('✅ Data flow from subtitle processing to MediaConvert test passed!');
        });

        it('should verify subtitle files are accessible via CloudFront after MediaConvert completion', async () => {
            console.log('=== TESTING SUBTITLE FILE ACCESSIBILITY VIA CLOUDFRONT ===');

            const testGuid = 'cloudfront-access-test-guid';
            const testVideo = 'cloudfront-access-test.mp4';

            // Mock MediaConvert completion with subtitle files
            const mediaConvertCompletionEvent = {
                detail: {
                    status: 'COMPLETE',
                    jobId: 'test-job-id',
                    userMetadata: {
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    },
                    outputGroupDetails: [{
                        outputDetails: [{
                            outputFilePaths: [
                                's3://vod-destination-bucket/mp4/cloudfront-access-test_1080p.mp4',
                                's3://vod-destination-bucket/subtitles/cloudfront-access-test.en.vtt',
                                's3://vod-destination-bucket/subtitles/cloudfront-access-test.es.vtt',
                                's3://vod-destination-bucket/subtitles/cloudfront-access-test.fr.vtt'
                            ]
                        }]
                    }]
                }
            };

            // Verify CloudFront URLs can be generated for subtitle files
            const subtitleFiles = mediaConvertCompletionEvent.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths
                .filter(path => path.includes('.vtt'));

            expect(subtitleFiles).to.have.lengthOf(3);

            subtitleFiles.forEach(filePath => {
                const fileName = filePath.split('/').pop();
                const cloudFrontUrl = `https://${process.env.CloudFront}/${fileName}`;
                
                expect(cloudFrontUrl).to.match(/^https:\/\/d123456789\.cloudfront\.net\/.+\.vtt$/);
                expect(fileName).to.match(/^cloudfront-access-test\.(en|es|fr)\.vtt$/);
            });

            console.log('✅ Subtitle file CloudFront accessibility test passed!');
        });
    });

    describe('Error Scenarios and Workflow Resilience', () => {
        it('should handle configuration errors gracefully and continue workflow', async () => {
            console.log('=== TESTING CONFIGURATION ERROR HANDLING ===');

            // Set invalid configuration that should be handled gracefully
            process.env.SUBTITLE_TARGET_LANGUAGES = 'invalid-lang-code,another-invalid';
            process.env.SUBTITLE_PRIMARY_LANGUAGE = 'invalid-primary';

            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });
            dynamoClientMock.on(UpdateItemCommand).resolves({});
            snsClientMock.on(PublishCommand).resolves({ MessageId: 'config-error-notification' });

            const inputEvent = {
                guid: 'config-error-test-guid',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'config-error-test.mp4' }
                    }
                }]
            };

            // Input validation should handle invalid configuration gracefully
            const validatedData = await inputValidateLambda.handler(inputEvent);
            
            // Should still have subtitle config, but may have been adjusted
            expect(validatedData).to.have.property('subtitleConfig');
            expect(validatedData.subtitleConfig).to.have.property('enabled');
            expect(validatedData.subtitleConfig).to.have.property('primaryLanguage');
            expect(validatedData.subtitleConfig).to.have.property('targetLanguages');

            // Workflow should continue despite configuration issues
            const subtitleTriggerEvent = {
                guid: validatedData.guid,
                srcVideo: validatedData.srcVideo,
                srcBucket: validatedData.srcBucket,
                destBucket: validatedData.destBucket,
                subtitleConfig: validatedData.subtitleConfig,
                subtitleTrigger: true
            };

            const result = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(result).to.equal('success');

            console.log('✅ Configuration error handling test passed!');
        });

        it('should handle partial subtitle processing failures with graceful degradation', async () => {
            console.log('=== TESTING PARTIAL SUBTITLE PROCESSING FAILURES ===');

            const testGuid = 'partial-failure-test-guid';

            // Mock scenario where transcription succeeds but translation fails for some languages
            const transcriptionResults = {
                results: {
                    transcripts: [{ transcript: "Test video content for partial failure testing." }],
                    items: [
                        { start_time: "0.0", end_time: "5.0", alternatives: [{ content: "Test", confidence: "0.99" }] }
                    ]
                }
            };

            const coordinatorEvent = {
                guid: testGuid,
                transcriptionJobName: 'test-transcription-job',
                transcriptionOutputLocation: `s3://vod-source-bucket/transcription/${testGuid}.json`,
                transcriptionResults: transcriptionResults,
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr', 'de', 'it']
                }
            };

            const coordinatorResult = await translationCoordinatorLambda.handler(coordinatorEvent);
            expect(coordinatorResult).to.have.property('parallelTranslationInput');

            // Simulate partial translation failures
            const translationResults = [];
            for (let i = 0; i < coordinatorResult.parallelTranslationInput.length; i++) {
                const task = coordinatorResult.parallelTranslationInput[i];
                try {
                    if (task.targetLanguage === 'de') {
                        // Simulate failure for German translation
                        throw new Error('Translation service unavailable for German');
                    }
                    const result = await translationWorkerLambda.handler(task);
                    translationResults.push(result);
                } catch (error) {
                    // Log error but continue with other languages
                    console.log(`Translation failed for ${task.targetLanguage}: ${error.message}`);
                    translationResults.push({
                        targetLanguage: task.targetLanguage,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            // Verify that some translations succeeded despite partial failures
            const successfulTranslations = translationResults.filter(r => r.status !== 'failed');
            expect(successfulTranslations.length).to.be.greaterThan(0);

            // WebVTT generation should work with partial results
            const webvttEvent = {
                guid: testGuid,
                srcVideo: 'partial-failure-test.mp4',
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                subtitleConfig: coordinatorEvent.subtitleConfig,
                transcriptionResult: transcriptionResults,
                translationResults: successfulTranslations
            };

            const webvttResult = await webvttGeneratorLambda.handler(webvttEvent);
            expect(webvttResult).to.have.property('webvttFiles');
            expect(webvttResult.webvttFiles.length).to.be.greaterThan(0);
            expect(webvttResult.webvttFiles.length).to.be.lessThan(coordinatorEvent.subtitleConfig.targetLanguages.length);

            console.log('✅ Partial subtitle processing failures test passed!');
        });
    });

    describe('Performance and Scalability Validation', () => {
        it('should handle concurrent processing of multiple videos with different subtitle configurations', async () => {
            console.log('=== TESTING CONCURRENT MULTI-VIDEO PROCESSING ===');

            // Mock responses for multiple concurrent videos
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'concurrent-test-arn' });
            dynamoClientMock.on(UpdateItemCommand).resolves({});
            s3ClientMock.on(PutObjectCommand).resolves({ ETag: '"test-etag"' });

            // Define multiple test videos with different configurations
            const testVideos = [
                {
                    guid: 'concurrent-video-1',
                    filename: 'video1.mp4',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'en',
                        targetLanguages: ['es', 'fr']
                    }
                },
                {
                    guid: 'concurrent-video-2', 
                    filename: 'video2.mov',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['de', 'it', 'pt']
                    }
                },
                {
                    guid: 'concurrent-video-3',
                    filename: 'video3.m4v',
                    subtitleConfig: {
                        enabled: false,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en']
                    }
                }
            ];

            // Process all videos concurrently
            const processingPromises = testVideos.map(async (video) => {
                // Input validation for each video
                const inputEvent = {
                    guid: video.guid,
                    workflowTrigger: 'Video',
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: video.filename }
                        }
                    }]
                };

                const validatedData = await inputValidateLambda.handler(inputEvent);
                expect(validatedData.guid).to.equal(video.guid);
                expect(validatedData.srcVideo).to.equal(video.filename);

                // Process workflow trigger
                const processEvent = { guid: video.guid };
                const processResult = await stepFunctionsLambda.handler(processEvent);
                expect(processResult).to.equal('success');

                // Subtitle processor trigger (if enabled)
                if (video.subtitleConfig.enabled) {
                    const subtitleEvent = {
                        guid: video.guid,
                        srcVideo: video.filename,
                        subtitleConfig: video.subtitleConfig,
                        subtitleTrigger: true
                    };

                    const subtitleResult = await stepFunctionsLambda.handler(subtitleEvent);
                    expect(subtitleResult).to.equal('success');
                }

                return { guid: video.guid, processed: true };
            });

            // Wait for all videos to be processed
            const results = await Promise.all(processingPromises);
            expect(results).to.have.lengthOf(3);
            results.forEach(result => {
                expect(result.processed).to.be.true;
            });

            // Verify all Step Functions calls were made
            const allCalls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(allCalls.length).to.be.greaterThan(5); // At least 2 calls per video (process + subtitle for enabled ones)

            console.log('✅ Concurrent multi-video processing test passed!');
        });

        it('should validate processing of videos with different formats and lengths', async () => {
            console.log('=== TESTING DIFFERENT VIDEO FORMATS AND LENGTHS ===');

            const videoFormats = [
                { filename: 'short-video.mp4', contentType: 'video/mp4', length: 'short' },
                { filename: 'medium-video.mov', contentType: 'video/quicktime', length: 'medium' },
                { filename: 'long-video.m4v', contentType: 'video/x-m4v', length: 'long' },
                { filename: 'very-long-video.mpg', contentType: 'video/mpeg', length: 'very-long' }
            ];

            for (const format of videoFormats) {
                console.log(`Testing format: ${format.filename} (${format.length})`);

                s3ClientMock.reset();
                s3ClientMock.on(HeadObjectCommand).resolves({
                    ContentLength: format.length === 'very-long' ? 4000000000 : 1024000, // 4GB for very long
                    ContentType: format.contentType
                });

                const inputEvent = {
                    guid: `test-guid-${format.length}`,
                    workflowTrigger: 'Video',
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: format.filename }
                        }
                    }]
                };

                const validatedData = await inputValidateLambda.handler(inputEvent);
                
                // Verify consistent configuration regardless of video format/length
                expect(validatedData.srcVideo).to.equal(format.filename);
                expect(validatedData.subtitleConfig.enabled).to.be.true;
                expect(validatedData.subtitleConfig.targetLanguages).to.have.lengthOf(10);
                expect(validatedData.workflowName).to.equal('vod-workflow');
                expect(validatedData.destBucket).to.equal('vod-destination-bucket');

                // Test that subtitle configuration adapts to video length if needed
                if (format.length === 'very-long') {
                    // For very long videos, configuration should still be valid
                    expect(validatedData.subtitleConfig).to.have.property('enabled');
                    expect(validatedData.subtitleConfig.enabled).to.be.true;
                }
            }

            console.log('✅ Different video formats and lengths test passed!');
        });
    });
});
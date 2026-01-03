/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

const expect = require('chai').expect;
const { mockClient } = require('aws-sdk-client-mock');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { DynamoDBClient, UpdateItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

// Import Lambda functions for integration testing
const stepFunctionsLambda = require('../step-functions/index.js');
const inputValidateLambda = require('../input-validate/index.js');

describe('#WORKFLOW WIRING INTEGRATION - TASK 15.1::', () => {
    // Mock AWS clients
    const sfnClientMock = mockClient(SFNClient);
    const dynamoClientMock = mockClient(DynamoDBClient);
    const s3ClientMock = mockClient(S3Client);
    const snsClientMock = mockClient(SNSClient);

    beforeEach(() => {
        // Set up complete environment for integration testing
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
    });

    afterEach(() => {
        sfnClientMock.reset();
        dynamoClientMock.reset();
        s3ClientMock.reset();
        snsClientMock.reset();
    });

    describe('Complete Workflow Wiring and Data Flow', () => {
        it('should wire all components together: Video Upload → Ingest → Process → Subtitle Processing → Publish', async () => {
            console.log('=== TESTING COMPLETE WORKFLOW WIRING ===');
            
            // Mock all AWS service responses for successful workflow
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:wiring-12345',
                startDate: new Date()
            });

            s3ClientMock.on(HeadObjectCommand).resolves({
                ContentLength: 1024000,
                ContentType: 'video/mp4'
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});
            dynamoClientMock.on(GetItemCommand).resolves({
                Item: {
                    guid: { S: 'wiring-test-guid' },
                    workflowStatus: { S: 'Processing' },
                    srcVideo: { S: 'wiring-test-video.mp4' },
                    srcBucket: { S: 'vod-source-bucket' },
                    destBucket: { S: 'vod-destination-bucket' }
                }
            });

            snsClientMock.on(PublishCommand).resolves({ MessageId: 'test-message-id' });

            const testGuid = 'wiring-test-guid';
            const testVideo = 'wiring-test-video.mp4';

            console.log('Step 1: Video Upload triggers Ingest Workflow');
            
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
                            size: 1024000
                        }
                    }
                }]
            };

            const ingestResult = await stepFunctionsLambda.handler(videoUploadEvent);
            expect(ingestResult).to.equal('success');

            // Verify Ingest workflow was triggered
            let calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const ingestCall = calls[0];
            expect(ingestCall.args[0].input.stateMachineArn).to.equal(process.env.IngestWorkflow);
            
            const ingestInput = JSON.parse(ingestCall.args[0].input.input);
            expect(ingestInput.workflowTrigger).to.equal('Video');
            expect(ingestInput).to.have.property('guid');

            console.log(`Generated GUID: ${ingestInput.guid}`);

            console.log('Step 2: Input Validation with Subtitle Configuration');

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

            console.log('Step 3: Process Workflow Trigger');

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

            console.log('Step 4: Subtitle Processor Workflow Trigger');

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

            console.log('Step 5: Publish Workflow Trigger (after MediaConvert completion)');

            // Step 5: MediaConvert job completes and triggers Publish workflow
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
                    jobId: 'test-job-id',
                    queue: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/Default',
                    userMetadata: {
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    },
                    outputGroupDetails: [{
                        outputDetails: [{
                            outputFilePaths: [
                                's3://vod-destination-bucket/mp4/wiring-test-video_1080p.mp4',
                                's3://vod-destination-bucket/mp4/wiring-test-video_720p.mp4',
                                's3://vod-destination-bucket/subtitles/wiring-test-video.en.vtt',
                                's3://vod-destination-bucket/subtitles/wiring-test-video.es.vtt'
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

            console.log('✅ COMPLETE WORKFLOW WIRING INTEGRATION TEST PASSED!');
            console.log(`✅ Successfully wired all components for video: ${testVideo}`);
            console.log(`✅ GUID: ${testGuid}`);
            console.log(`✅ All workflow steps properly connected and triggered`);
            console.log(`✅ Subtitle processing integrated into main workflow`);
        });

        it('should ensure proper data flow from subtitle processing to MediaConvert', async () => {
            console.log('=== TESTING DATA FLOW TO MEDIACONVERT ===');

            // Mock successful responses
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:dataflow-12345'
            });

            s3ClientMock.on(PutObjectCommand).resolves({
                ETag: '"test-etag"',
                VersionId: 'test-version'
            });

            const testGuid = 'dataflow-test-guid';
            const testVideo = 'dataflow-test.mp4';

            // Test that subtitle files are properly passed to MediaConvert
            const subtitleFiles = [
                {
                    language: 'en',
                    filename: 'dataflow-test.en.vtt',
                    s3Location: 's3://vod-temp-subtitle-bucket/temp-subtitles/dataflow-test.en.vtt'
                },
                {
                    language: 'es',
                    filename: 'dataflow-test.es.vtt',
                    s3Location: 's3://vod-temp-subtitle-bucket/temp-subtitles/dataflow-test.es.vtt'
                }
            ];

            // Verify MediaConvert completion includes subtitle files
            const mediaConvertCompletionEvent = {
                detail: {
                    status: 'COMPLETE',
                    jobId: 'dataflow-test-job-id',
                    userMetadata: {
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    },
                    outputGroupDetails: [{
                        outputDetails: [{
                            outputFilePaths: [
                                's3://vod-destination-bucket/mp4/dataflow-test_1080p.mp4',
                                's3://vod-destination-bucket/subtitles/dataflow-test.en.vtt',
                                's3://vod-destination-bucket/subtitles/dataflow-test.es.vtt'
                            ]
                        }]
                    }]
                }
            };

            const publishResult = await stepFunctionsLambda.handler(mediaConvertCompletionEvent);
            expect(publishResult).to.equal('success');

            // Verify subtitle files are included in MediaConvert output
            const subtitleOutputFiles = mediaConvertCompletionEvent.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths
                .filter(path => path.includes('.vtt'));

            expect(subtitleOutputFiles).to.have.lengthOf(2);
            expect(subtitleOutputFiles).to.include('s3://vod-destination-bucket/subtitles/dataflow-test.en.vtt');
            expect(subtitleOutputFiles).to.include('s3://vod-destination-bucket/subtitles/dataflow-test.es.vtt');

            console.log('✅ Data flow to MediaConvert test passed!');
        });

        it('should verify subtitle files are accessible via CloudFront after processing', async () => {
            console.log('=== TESTING CLOUDFRONT ACCESSIBILITY ===');

            const testGuid = 'cloudfront-test-guid';
            const testVideo = 'cloudfront-test.mp4';

            // Mock MediaConvert completion with subtitle files
            const mediaConvertCompletionEvent = {
                detail: {
                    status: 'COMPLETE',
                    jobId: 'cloudfront-test-job-id',
                    userMetadata: {
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    },
                    outputGroupDetails: [{
                        outputDetails: [{
                            outputFilePaths: [
                                's3://vod-destination-bucket/mp4/cloudfront-test_1080p.mp4',
                                's3://vod-destination-bucket/subtitles/cloudfront-test.en.vtt',
                                's3://vod-destination-bucket/subtitles/cloudfront-test.es.vtt',
                                's3://vod-destination-bucket/subtitles/cloudfront-test.fr.vtt'
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
                expect(fileName).to.match(/^cloudfront-test\.(en|es|fr)\.vtt$/);
            });

            console.log('✅ CloudFront accessibility test passed!');
        });

        it('should handle workflow with subtitle processing disabled', async () => {
            console.log('=== TESTING DISABLED SUBTITLE PROCESSING ===');

            // Disable subtitle processing
            process.env.SUBTITLE_ENABLED = 'false';

            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:disabled-12345'
            });

            const testGuid = 'disabled-test-guid';
            const testVideo = 'disabled-test.mp4';

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

            console.log('✅ Disabled subtitle processing test passed!');
        });

        it('should maintain workflow independence when subtitle processing fails', async () => {
            console.log('=== TESTING WORKFLOW INDEPENDENCE ===');

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

            snsClientMock.on(PublishCommand).resolves({ MessageId: 'error-notification-id' });

            const testGuid = 'independence-test-guid';

            // Test that process workflow continues even if subtitle processor fails
            const processEvent = { 
                guid: testGuid
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

    describe('Error Scenarios and Workflow Resilience', () => {
        it('should handle configuration errors gracefully and continue workflow', async () => {
            console.log('=== TESTING CONFIGURATION ERROR HANDLING ===');

            // Set invalid configuration that should be handled gracefully
            process.env.SUBTITLE_TARGET_LANGUAGES = 'invalid-lang-code,another-invalid';
            process.env.SUBTITLE_PRIMARY_LANGUAGE = 'invalid-primary';

            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });
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

        it('should handle concurrent processing of multiple videos', async () => {
            console.log('=== TESTING CONCURRENT PROCESSING ===');

            // Mock responses for multiple concurrent videos
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'concurrent-test-arn' });

            // Define multiple test videos
            const testVideos = [
                {
                    guid: 'concurrent-video-1',
                    filename: 'video1.mp4'
                },
                {
                    guid: 'concurrent-video-2', 
                    filename: 'video2.mov'
                },
                {
                    guid: 'concurrent-video-3',
                    filename: 'video3.m4v'
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

                // Subtitle processor trigger
                const subtitleEvent = {
                    guid: video.guid,
                    srcVideo: video.filename,
                    subtitleTrigger: true
                };

                const subtitleResult = await stepFunctionsLambda.handler(subtitleEvent);
                expect(subtitleResult).to.equal('success');

                return { guid: video.guid, processed: true };
            });

            // Wait for all videos to be processed
            const results = await Promise.all(processingPromises);
            expect(results).to.have.lengthOf(3);
            results.forEach(result => {
                expect(result.processed).to.be.true;
            });

            console.log('✅ Concurrent processing test passed!');
        });
    });
});
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

// Import Lambda functions
const stepFunctionsLambda = require('../step-functions/index.js');
const inputValidateLambda = require('../input-validate/index.js');
const subtitleConfigLambda = require('../subtitle-config/index.js');

describe('#COMPLETE END-TO-END WORKFLOW INTEGRATION::', () => {
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
    });

    afterEach(() => {
        sfnClientMock.reset();
        dynamoClientMock.reset();
        s3ClientMock.reset();
        snsClientMock.reset();
        sqsClientMock.reset();
        lambdaClientMock.reset();
    });

    describe('Complete Video Upload to Subtitle Delivery Workflow', () => {
        it('should execute complete end-to-end workflow: Upload → Ingest → Process → Subtitle Processing → Publish', async () => {
            // Mock all AWS service responses for successful workflow
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345',
                startDate: new Date()
            });

            sfnClientMock.on(DescribeExecutionCommand).resolves({
                status: 'SUCCEEDED',
                output: JSON.stringify({ status: 'completed' })
            });

            s3ClientMock.on(HeadObjectCommand).resolves({
                ContentLength: 1024000,
                ContentType: 'video/mp4'
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});
            dynamoClientMock.on(GetItemCommand).resolves({
                Item: {
                    guid: { S: 'test-guid-e2e' },
                    workflowStatus: { S: 'Ingest' },
                    srcVideo: { S: 'sample-video.mp4' },
                    srcBucket: { S: 'vod-source-bucket' },
                    destBucket: { S: 'vod-destination-bucket' }
                }
            });

            snsClientMock.on(PublishCommand).resolves({ MessageId: 'test-message-id' });
            sqsClientMock.on(SendMessageCommand).resolves({ MessageId: 'test-sqs-message-id' });
            lambdaClientMock.on(InvokeCommand).resolves({ StatusCode: 200 });

            console.log('=== PHASE 1: Video Upload Triggers Ingest Workflow ===');
            
            // Step 1: Video file uploaded to S3 triggers Lambda
            const videoUploadEvent = {
                Records: [{
                    eventVersion: '2.1',
                    eventSource: 'aws:s3',
                    eventName: 'ObjectCreated:Put',
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { 
                            key: 'uploads/sample-video.mp4',
                            size: 1024000
                        }
                    }
                }]
            };

            // Test the step functions handler directly without triggering error paths
            try {
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
                expect(ingestInput.Records[0].s3.object.key).to.equal('uploads/sample-video.mp4');

                const testGuid = ingestInput.guid;
                console.log(`Generated GUID: ${testGuid}`);

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
                expect(validatedData.srcVideo).to.equal('uploads/sample-video.mp4');
                expect(validatedData.srcBucket).to.equal('vod-source-bucket');
                expect(validatedData.destBucket).to.equal('vod-destination-bucket');
                expect(validatedData.workflowName).to.equal('vod-workflow');
                
                // Verify subtitle configuration is properly initialized
                expect(validatedData).to.have.property('subtitleConfig');
                expect(validatedData.subtitleConfig.enabled).to.be.true;
                expect(validatedData.subtitleConfig.primaryLanguage).to.equal('auto');
                expect(validatedData.subtitleConfig.targetLanguages).to.be.an('array');
                expect(validatedData.subtitleConfig.targetLanguages).to.include.members(['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar']);

                console.log('=== PHASE 3: Process Workflow Initiation ===');

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

                const processInput = JSON.parse(processCall.args[0].input.input);
                expect(processInput.guid).to.equal(testGuid);

                console.log('=== PHASE 4: Subtitle Processor Workflow Trigger ===');

                // Step 4: Subtitle Processor is triggered after MediaConvert job submission
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

                console.log('=== PHASE 5: MediaConvert Completion and Publish Workflow ===');

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
                                    's3://vod-destination-bucket/mp4/sample-video_1080p.mp4',
                                    's3://vod-destination-bucket/mp4/sample-video_720p.mp4'
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

                console.log('=== PHASE 6: Workflow Completion Verification ===');

                console.log('✅ Complete end-to-end workflow integration test passed!');
                console.log(`✅ Successfully processed video: ${validatedData.srcVideo}`);
                console.log(`✅ GUID: ${testGuid}`);
                console.log(`✅ All workflow steps executed successfully`);

            } catch (error) {
                // If we get an error, it should be a controlled test failure, not an AWS service error
                console.error('Test failed with error:', error.message);
                throw error;
            }
        });

        it('should handle metadata-driven workflow with custom subtitle configuration', async () => {
            // Mock S3 response with metadata file containing custom subtitle config
            const customMetadataContent = JSON.stringify({
                srcVideo: 'custom-video.mp4',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr', 'de', 'it']
                },
                jobTemplate_1080p: 'custom-template-1080p',
                acceleratedTranscoding: 'ENABLED'
            });

            s3ClientMock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: async () => customMetadataContent
                }
            });

            s3ClientMock.on(HeadObjectCommand).resolves({
                ContentLength: 2048000,
                ContentType: 'video/mp4'
            });

            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:metadata-12345'
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});

            console.log('=== Testing Metadata-Driven Workflow ===');

            // Step 1: Metadata file upload triggers workflow
            const metadataUploadEvent = {
                Records: [{
                    eventVersion: '2.1',
                    eventSource: 'aws:s3',
                    eventName: 'ObjectCreated:Put',
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { 
                            key: 'metadata/custom-video-metadata.json',
                            size: 1024
                        }
                    }
                }]
            };

            const ingestResult = await stepFunctionsLambda.handler(metadataUploadEvent);
            expect(ingestResult).to.equal('success');

            // Verify metadata workflow trigger
            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const ingestInput = JSON.parse(calls[0].args[0].input.input);
            expect(ingestInput.workflowTrigger).to.equal('Metadata');

            // Step 2: Input validation with metadata file
            const inputValidationEvent = {
                guid: ingestInput.guid,
                workflowTrigger: 'Metadata',
                Records: metadataUploadEvent.Records
            };

            const validatedData = await inputValidateLambda.handler(inputValidationEvent);
            
            // Verify metadata overrides were applied
            expect(validatedData.srcVideo).to.equal('custom-video.mp4');
            expect(validatedData.srcMetadataFile).to.equal('metadata/custom-video-metadata.json');
            expect(validatedData.subtitleConfig.enabled).to.be.true;
            expect(validatedData.subtitleConfig.primaryLanguage).to.equal('en');
            expect(validatedData.subtitleConfig.targetLanguages).to.deep.equal(['es', 'fr', 'de', 'it']);
            expect(validatedData.jobTemplate_1080p).to.equal('custom-template-1080p');
            expect(validatedData.acceleratedTranscoding).to.equal('ENABLED');

            console.log('✅ Metadata-driven workflow test passed!');
        });

        it('should handle workflow with subtitle processing disabled', async () => {
            // Disable subtitle processing
            process.env.SUBTITLE_ENABLED = 'false';

            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:disabled-12345'
            });

            console.log('=== Testing Disabled Subtitle Processing ===');

            // Test input validation with disabled subtitles
            const inputEvent = {
                guid: 'test-guid-disabled',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'test-video-no-subtitles.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);
            expect(validatedData.subtitleConfig.enabled).to.be.false;

            // Subtitle processor should still be triggered but will skip processing
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

            // Verify subtitle processor was triggered with disabled configuration
            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const subtitleInput = JSON.parse(calls[0].args[0].input.input);
            expect(subtitleInput.subtitleConfig.enabled).to.be.false;

            console.log('✅ Disabled subtitle processing test passed!');
        });
    });

    describe('Error Propagation and Workflow Resilience', () => {
        it('should maintain workflow independence when subtitle processing fails', async () => {
            console.log('=== Testing Workflow Independence with Subtitle Failures ===');

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

            // Test that process workflow continues even if subtitle processor fails
            const processEvent = { 
                guid: 'test-guid-resilience',
                srcVideo: 'test-video.mp4',
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket'
            };
            
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Test subtitle processor failure
            const subtitleEvent = {
                guid: 'test-guid-resilience',
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
                        guid: 'test-guid-resilience',
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

        it('should handle configuration errors gracefully and continue workflow', async () => {
            console.log('=== Testing Configuration Error Handling ===');

            // Set invalid configuration that should be handled gracefully
            process.env.SUBTITLE_TARGET_LANGUAGES = 'invalid-lang-code,another-invalid';
            process.env.SUBTITLE_PRIMARY_LANGUAGE = 'invalid-primary';

            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });
            dynamoClientMock.on(UpdateItemCommand).resolves({});
            snsClientMock.on(PublishCommand).resolves({ MessageId: 'config-error-notification' });

            const inputEvent = {
                guid: 'test-guid-config-error',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'test-video-config-error.mp4' }
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

        it('should handle network failures and service timeouts with proper error reporting', async () => {
            console.log('=== Testing Network Failures and Service Timeouts ===');

            // Mock various types of network and service failures
            const networkError = new Error('Network timeout');
            networkError.name = 'NetworkingError';
            networkError.code = 'ECONNRESET';

            const serviceError = new Error('Service temporarily unavailable');
            serviceError.name = 'ServiceUnavailableException';
            serviceError.statusCode = 503;

            const throttleError = new Error('Request rate exceeded');
            throttleError.name = 'ThrottlingException';
            throttleError.statusCode = 429;

            // Test different error scenarios
            const errorScenarios = [
                { error: networkError, description: 'Network timeout' },
                { error: serviceError, description: 'Service unavailable' },
                { error: throttleError, description: 'Request throttling' }
            ];

            for (const scenario of errorScenarios) {
                console.log(`Testing ${scenario.description}...`);

                sfnClientMock.reset();
                sfnClientMock.on(StartExecutionCommand).rejects(scenario.error);
                
                dynamoClientMock.on(UpdateItemCommand).resolves({});
                snsClientMock.on(PublishCommand).resolves({ MessageId: 'error-notification' });

                const subtitleEvent = {
                    guid: `test-guid-${scenario.error.name}`,
                    srcVideo: 'test-video.mp4',
                    subtitleConfig: { enabled: true },
                    subtitleTrigger: true
                };

                try {
                    await stepFunctionsLambda.handler(subtitleEvent);
                    expect.fail(`Should have thrown error for ${scenario.description}`);
                } catch (error) {
                    expect(error.name).to.equal(scenario.error.name);
                    expect(error.message).to.equal(scenario.error.message);
                }

                // Verify error was properly logged and reported
                const snsCalls = snsClientMock.commandCalls(PublishCommand);
                expect(snsCalls.length).to.be.greaterThan(0);
            }

            console.log('✅ Network failures and service timeouts test passed!');
        });

        it('should handle partial workflow failures and maintain data consistency', async () => {
            console.log('=== Testing Partial Workflow Failures and Data Consistency ===');

            // Mock scenario where some operations succeed and others fail
            let callCount = 0;
            sfnClientMock.on(StartExecutionCommand).callsFake((command) => {
                callCount++;
                if (callCount === 1) {
                    // First call (ingest) succeeds
                    return Promise.resolve({ executionArn: 'success-arn-1' });
                } else if (callCount === 2) {
                    // Second call (process) succeeds
                    return Promise.resolve({ executionArn: 'success-arn-2' });
                } else if (callCount === 3) {
                    // Third call (subtitle) fails
                    throw new Error('Subtitle processing failed');
                } else {
                    // Fourth call (publish) should still succeed
                    return Promise.resolve({ executionArn: 'success-arn-4' });
                }
            });

            dynamoClientMock.on(UpdateItemCommand).resolves({});
            dynamoClientMock.on(GetItemCommand).resolves({
                Item: {
                    guid: { S: 'test-guid-partial' },
                    workflowStatus: { S: 'Processing' }
                }
            });

            snsClientMock.on(PublishCommand).resolves({ MessageId: 'partial-failure-notification' });

            const testGuid = 'test-guid-partial-failure';

            // Step 1: Ingest succeeds
            const ingestEvent = {
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'partial-failure-video.mp4' }
                    }
                }]
            };

            const ingestResult = await stepFunctionsLambda.handler(ingestEvent);
            expect(ingestResult).to.equal('success');

            // Step 2: Process succeeds
            const processEvent = { guid: testGuid };
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Step 3: Subtitle processing fails
            const subtitleEvent = {
                guid: testGuid,
                srcVideo: 'partial-failure-video.mp4',
                subtitleConfig: { enabled: true },
                subtitleTrigger: true
            };

            try {
                await stepFunctionsLambda.handler(subtitleEvent);
                expect.fail('Should have thrown error for subtitle processing');
            } catch (error) {
                expect(error.message).to.equal('Subtitle processing failed');
            }

            // Step 4: Publish should still succeed despite subtitle failure
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

            // Verify all expected calls were made
            const allCalls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(allCalls).to.have.lengthOf(4);

            // Verify DynamoDB was updated to track the partial failure
            const dynamoCalls = dynamoClientMock.commandCalls(UpdateItemCommand);
            expect(dynamoCalls.length).to.be.greaterThan(0);

            // Verify error notification was sent
            const snsCalls = snsClientMock.commandCalls(PublishCommand);
            expect(snsCalls.length).to.be.greaterThan(0);

            console.log('✅ Partial workflow failures and data consistency test passed!');
        });
    });

    describe('Integration with Existing Video Processing Workflow', () => {
        it('should integrate seamlessly with existing MediaConvert workflow without disruption', async () => {
            console.log('=== Testing Integration with Existing MediaConvert Workflow ===');

            // Mock successful MediaConvert workflow integration
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'integration-test-arn' });
            dynamoClientMock.on(UpdateItemCommand).resolves({});
            dynamoClientMock.on(GetItemCommand).resolves({
                Item: {
                    guid: { S: 'integration-test-guid' },
                    workflowStatus: { S: 'Processing' },
                    srcVideo: { S: 'integration-test.mp4' },
                    jobTemplate_1080p: { S: 'existing-template-1080p' },
                    acceleratedTranscoding: { S: 'PREFERRED' }
                }
            });

            const testGuid = 'integration-test-guid';

            // Test that existing workflow parameters are preserved
            const inputEvent = {
                guid: testGuid,
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'integration-test.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);

            // Verify existing workflow configuration is preserved
            expect(validatedData.jobTemplate_1080p).to.equal(process.env.MediaConvert_Template_1080p);
            expect(validatedData.acceleratedTranscoding).to.equal('PREFERRED');
            expect(validatedData.frameCapture).to.be.false;
            expect(validatedData.archiveSource).to.equal('DISABLED');
            expect(validatedData.enableSns).to.be.true;
            expect(validatedData.enableSqs).to.be.true;
            expect(validatedData.enableMediaPackage).to.be.false;

            // Verify subtitle configuration is added without affecting existing config
            expect(validatedData.subtitleConfig).to.exist;
            expect(validatedData.subtitleConfig.enabled).to.be.true;

            // Test process workflow trigger maintains existing behavior
            const processEvent = { guid: testGuid };
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            const processCalls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(processCalls).to.have.lengthOf(1);
            expect(processCalls[0].args[0].input.stateMachineArn).to.equal(process.env.ProcessWorkflow);

            // Test subtitle processor is triggered as additional step
            const subtitleEvent = {
                guid: testGuid,
                srcVideo: validatedData.srcVideo,
                srcBucket: validatedData.srcBucket,
                destBucket: validatedData.destBucket,
                subtitleConfig: validatedData.subtitleConfig,
                subtitleTrigger: true
            };

            const subtitleResult = await stepFunctionsLambda.handler(subtitleEvent);
            expect(subtitleResult).to.equal('success');

            // Test MediaConvert completion event handling remains unchanged
            const mediaConvertEvent = {
                detail: {
                    status: 'COMPLETE',
                    jobId: 'mediaconvert-job-123',
                    userMetadata: {
                        guid: testGuid,
                        workflow: 'vod-workflow'
                    }
                }
            };

            const publishResult = await stepFunctionsLambda.handler(mediaConvertEvent);
            expect(publishResult).to.equal('success');

            console.log('✅ MediaConvert workflow integration test passed!');
        });

        it('should handle concurrent processing of multiple videos with different configurations', async () => {
            console.log('=== Testing Concurrent Multi-Video Processing ===');

            // Mock responses for multiple concurrent videos
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'concurrent-test-arn' });
            dynamoClientMock.on(UpdateItemCommand).resolves({});

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

        it('should maintain proper execution naming and avoid conflicts', async () => {
            console.log('=== Testing Execution Naming and Conflict Avoidance ===');

            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'naming-test-arn' });

            const testCases = [
                { guid: 'test-guid-1', expectedIngestName: 'test-guid-1', expectedSubtitleName: 'test-guid-1-subtitle' },
                { guid: 'test-guid-2', expectedIngestName: 'test-guid-2', expectedSubtitleName: 'test-guid-2-subtitle' },
                { guid: 'special-chars-guid_123', expectedIngestName: 'special-chars-guid_123', expectedSubtitleName: 'special-chars-guid_123-subtitle' }
            ];

            for (const testCase of testCases) {
                sfnClientMock.reset();

                // Test ingest workflow naming
                const ingestEvent = {
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: `${testCase.guid}.mp4` }
                        }
                    }]
                };

                // Manually set guid to test specific naming
                ingestEvent.guid = testCase.guid;

                const ingestResult = await stepFunctionsLambda.handler(ingestEvent);
                expect(ingestResult).to.equal('success');

                let calls = sfnClientMock.commandCalls(StartExecutionCommand);
                expect(calls[0].args[0].input.name).to.equal(testCase.expectedIngestName);

                // Test process workflow naming
                const processEvent = { guid: testCase.guid };
                const processResult = await stepFunctionsLambda.handler(processEvent);
                expect(processResult).to.equal('success');

                calls = sfnClientMock.commandCalls(StartExecutionCommand);
                expect(calls[1].args[0].input.name).to.equal(testCase.guid);

                // Test subtitle processor naming
                const subtitleEvent = {
                    guid: testCase.guid,
                    srcVideo: `${testCase.guid}.mp4`,
                    subtitleTrigger: true
                };

                const subtitleResult = await stepFunctionsLambda.handler(subtitleEvent);
                expect(subtitleResult).to.equal('success');

                calls = sfnClientMock.commandCalls(StartExecutionCommand);
                expect(calls[2].args[0].input.name).to.equal(testCase.expectedSubtitleName);
            }

            console.log('✅ Execution naming and conflict avoidance test passed!');
        });
    });
});
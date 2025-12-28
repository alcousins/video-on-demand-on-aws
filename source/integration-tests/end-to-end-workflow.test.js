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
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

// Import all workflow components
const stepFunctionsLambda = require('../step-functions/index.js');
const inputValidateLambda = require('../input-validate/index.js');

describe('#END-TO-END SUBTITLE WORKFLOW::', () => {
    const sfnClientMock = mockClient(SFNClient);

    beforeEach(() => {
        // Set up complete environment
        process.env.IngestWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:test-ingest';
        process.env.ProcessWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:test-process';
        process.env.PublishWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:test-publish';
        process.env.SubtitleProcessorWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:test-subtitle-processor';
        process.env.ErrorHandler = 'test-error-handler';
        process.env.WorkflowName = 'test-vod-workflow';
        process.env.Source = 'test-source-bucket';
        process.env.Destination = 'test-destination-bucket';
        process.env.CloudFront = 'd123456789.cloudfront.net';
        process.env.FrameCapture = 'false';
        process.env.ArchiveSource = 'DISABLED';
        process.env.MediaConvert_Template_2160p = 'test-vod-workflow_Ott_2160p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.MediaConvert_Template_1080p = 'test-vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.MediaConvert_Template_720p = 'test-vod-workflow_Ott_720p_Avc_Aac_16x9_qvbr_no_preset';
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
    });

    describe('Complete Video Processing Workflow with Subtitles', () => {
        it('should execute complete workflow: Ingest → Process → Subtitle Processing → Publish', async () => {
            // Mock all Step Functions executions to succeed
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345',
                startDate: new Date()
            });

            // Step 1: Video upload triggers Ingest Workflow
            console.log('Step 1: Testing video upload trigger...');
            const videoUploadEvent = {
                Records: [{
                    s3: {
                        bucket: { name: 'test-source-bucket' },
                        object: { key: 'sample-video.mp4' }
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

            // Step 2: Input validation includes subtitle configuration
            console.log('Step 2: Testing input validation with subtitle config...');
            const inputValidationEvent = {
                guid: ingestInput.guid,
                workflowTrigger: 'Video',
                Records: videoUploadEvent.Records
            };

            const validatedData = await inputValidateLambda.handler(inputValidationEvent);
            
            // Verify subtitle configuration is properly set
            expect(validatedData).to.have.property('subtitleConfig');
            expect(validatedData.subtitleConfig.enabled).to.be.true;
            expect(validatedData.subtitleConfig.primaryLanguage).to.equal('auto');
            expect(validatedData.subtitleConfig.targetLanguages).to.be.an('array');
            expect(validatedData.subtitleConfig.targetLanguages).to.include('en');
            expect(validatedData.subtitleConfig.targetLanguages).to.include('es');
            expect(validatedData.subtitleConfig.targetLanguages).to.include('fr');

            // Step 3: Process Workflow trigger
            console.log('Step 3: Testing process workflow trigger...');
            sfnClientMock.reset();
            
            const processEvent = {
                guid: validatedData.guid
            };

            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Verify Process workflow was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const processCall = calls[0];
            expect(processCall.args[0].input.stateMachineArn).to.equal(process.env.ProcessWorkflow);

            // Step 4: Subtitle Processor trigger (happens within Process Workflow)
            console.log('Step 4: Testing subtitle processor trigger...');
            sfnClientMock.reset();
            
            const subtitleTriggerEvent = {
                guid: validatedData.guid,
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
            expect(subtitleCall.args[0].input.name).to.equal(`${validatedData.guid}-subtitle`);

            // Verify subtitle processor input data
            const subtitleInput = JSON.parse(subtitleCall.args[0].input.input);
            expect(subtitleInput.guid).to.equal(validatedData.guid);
            expect(subtitleInput.srcVideo).to.equal(validatedData.srcVideo);
            expect(subtitleInput.subtitleConfig.enabled).to.be.true;
            expect(subtitleInput.subtitleTrigger).to.be.true;

            // Step 5: Publish Workflow trigger (after MediaConvert completion)
            console.log('Step 5: Testing publish workflow trigger...');
            sfnClientMock.reset();
            
            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: {
                        guid: validatedData.guid,
                        workflow: process.env.WorkflowName
                    }
                }
            };

            const publishResult = await stepFunctionsLambda.handler(publishEvent);
            expect(publishResult).to.equal('success');

            // Verify Publish workflow was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const publishCall = calls[0];
            expect(publishCall.args[0].input.stateMachineArn).to.equal(process.env.PublishWorkflow);

            console.log('✅ Complete workflow integration test passed!');
        });

        it('should handle workflow with subtitle processing disabled', async () => {
            // Disable subtitle processing
            process.env.SUBTITLE_ENABLED = 'false';

            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345'
            });

            // Test input validation with disabled subtitles
            const inputEvent = {
                guid: 'test-guid-disabled',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'test-source-bucket' },
                        object: { key: 'test-video.mp4' }
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

            // Verify subtitle processor was still triggered (it will handle the disabled state internally)
            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const subtitleInput = JSON.parse(calls[0].args[0].input.input);
            expect(subtitleInput.subtitleConfig.enabled).to.be.false;
        });

        it('should maintain workflow independence - subtitle failures do not block main workflow', async () => {
            // Mock subtitle processor to fail, but main workflow should continue
            sfnClientMock.on(StartExecutionCommand).callsFake((command) => {
                if (command.stateMachineArn === process.env.SubtitleProcessorWorkflow) {
                    throw new Error('Subtitle processing failed');
                }
                return Promise.resolve({ executionArn: 'test-arn' });
            });

            // Test that process workflow continues even if subtitle processor fails
            const processEvent = { guid: 'test-guid' };
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Test subtitle processor failure
            const subtitleEvent = {
                guid: 'test-guid',
                srcVideo: 'test.mp4',
                subtitleTrigger: true
            };

            try {
                await stepFunctionsLambda.handler(subtitleEvent);
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error.message).to.equal('Subtitle processing failed');
            }

            // Test that publish workflow can still be triggered
            sfnClientMock.reset();
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });

            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: { guid: 'test-guid' }
                }
            };

            const publishResult = await stepFunctionsLambda.handler(publishEvent);
            expect(publishResult).to.equal('success');
        });
    });

    describe('Configuration and Data Flow Validation', () => {
        it('should properly configure subtitle processing with all supported languages', async () => {
            const inputEvent = {
                guid: 'test-guid-languages',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'test-source-bucket' },
                        object: { key: 'multilingual-video.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);
            
            // Verify all supported languages are configured
            const expectedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'];
            expect(validatedData.subtitleConfig.targetLanguages).to.deep.equal(expectedLanguages);
        });

        it('should pass correct workflow metadata through all steps', async () => {
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });

            const testGuid = 'integration-test-guid-12345';
            const testVideo = 'integration-test-video.mp4';
            
            const subtitleEvent = {
                guid: testGuid,
                srcVideo: testVideo,
                srcBucket: 'integration-source-bucket',
                destBucket: 'integration-dest-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr', 'de']
                },
                subtitleTrigger: true
            };

            await stepFunctionsLambda.handler(subtitleEvent);

            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            const inputData = JSON.parse(calls[0].args[0].input.input);
            
            // Verify all metadata is correctly passed through
            expect(inputData.guid).to.equal(testGuid);
            expect(inputData.srcVideo).to.equal(testVideo);
            expect(inputData.srcBucket).to.equal('integration-source-bucket');
            expect(inputData.destBucket).to.equal('integration-dest-bucket');
            expect(inputData.subtitleConfig.primaryLanguage).to.equal('en');
            expect(inputData.subtitleConfig.targetLanguages).to.deep.equal(['es', 'fr', 'de']);
        });
    });
});
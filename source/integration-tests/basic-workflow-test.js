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

describe('#BASIC WORKFLOW INTEGRATION::', () => {
    const sfnClientMock = mockClient(SFNClient);

    beforeEach(() => {
        // Set up environment variables
        process.env.IngestWorkflow = 'test-ingest-workflow';
        process.env.ProcessWorkflow = 'test-process-workflow';
        process.env.PublishWorkflow = 'test-publish-workflow';
        process.env.SubtitleProcessorWorkflow = 'test-subtitle-processor-workflow';
        process.env.ErrorHandler = 'test-error-handler';
        process.env.WorkflowName = 'test-workflow';
        process.env.Source = 'test-source-bucket';
        process.env.Destination = 'test-dest-bucket';
        process.env.CloudFront = 'test.cloudfront.net';
        process.env.FrameCapture = 'false';
        process.env.ArchiveSource = 'DISABLED';
        process.env.MediaConvert_Template_2160p = 'test-2160p-template';
        process.env.MediaConvert_Template_1080p = 'test-1080p-template';
        process.env.MediaConvert_Template_720p = 'test-720p-template';
        process.env.InputRotate = 'DEGREE_0';
        process.env.AcceleratedTranscoding = 'PREFERRED';
        process.env.EnableSns = 'true';
        process.env.EnableSqs = 'true';
        process.env.EnableMediaPackage = 'false';
        process.env.SUBTITLE_ENABLED = 'true';
        process.env.SUBTITLE_PRIMARY_LANGUAGE = 'auto';
        process.env.SUBTITLE_TARGET_LANGUAGES = 'en,es,fr,de,it';
    });

    afterEach(() => {
        sfnClientMock.reset();
    });

    describe('Step Functions Integration', () => {
        it('should handle subtitle processor trigger correctly', async () => {
            // Mock successful Step Functions execution
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345',
                startDate: new Date()
            });

            // Import the step functions Lambda
            const stepFunctionsLambda = require('../step-functions/index.js');

            // Test subtitle processor trigger
            const subtitleTriggerEvent = {
                guid: 'test-guid-integration',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en', 'es', 'fr']
                },
                subtitleTrigger: true
            };

            const result = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(result).to.equal('success');

            // Verify the correct state machine was triggered
            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            
            const call = calls[0];
            expect(call.args[0].input.stateMachineArn).to.equal('test-subtitle-processor-workflow');
            expect(call.args[0].input.name).to.equal('test-guid-integration-subtitle');

            // Verify the input data was passed correctly
            const inputData = JSON.parse(call.args[0].input.input);
            expect(inputData.guid).to.equal('test-guid-integration');
            expect(inputData.srcVideo).to.equal('test-video.mp4');
            expect(inputData.subtitleConfig.enabled).to.be.true;
            expect(inputData.subtitleTrigger).to.be.true;
        });

        it('should handle process workflow trigger correctly', async () => {
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345'
            });

            const stepFunctionsLambda = require('../step-functions/index.js');

            const processEvent = {
                guid: 'test-process-guid'
            };

            const result = await stepFunctionsLambda.handler(processEvent);
            expect(result).to.equal('success');

            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].args[0].input.stateMachineArn).to.equal('test-process-workflow');
        });

        it('should handle publish workflow trigger correctly', async () => {
            sfnClientMock.on(StartExecutionCommand).resolves({
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345'
            });

            const stepFunctionsLambda = require('../step-functions/index.js');

            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: {
                        guid: 'test-publish-guid',
                        workflow: 'test-workflow'
                    }
                }
            };

            const result = await stepFunctionsLambda.handler(publishEvent);
            expect(result).to.equal('success');

            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].args[0].input.stateMachineArn).to.equal('test-publish-workflow');
        });
    });

    describe('Input Validation Integration', () => {
        it('should include subtitle configuration in validated input', async () => {
            const inputValidateLambda = require('../input-validate/index.js');

            const inputEvent = {
                guid: 'test-input-guid',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            const result = await inputValidateLambda.handler(inputEvent);

            // Verify subtitle configuration is included
            expect(result).to.have.property('subtitleConfig');
            expect(result.subtitleConfig).to.be.an('object');
            expect(result.subtitleConfig).to.have.property('enabled');
            expect(result.subtitleConfig).to.have.property('primaryLanguage');
            expect(result.subtitleConfig).to.have.property('targetLanguages');

            // Verify configuration values
            expect(result.subtitleConfig.enabled).to.be.true;
            expect(result.subtitleConfig.primaryLanguage).to.equal('auto');
            expect(result.subtitleConfig.targetLanguages).to.be.an('array');
            expect(result.subtitleConfig.targetLanguages).to.include('en');
            expect(result.subtitleConfig.targetLanguages).to.include('es');
        });

        it('should handle disabled subtitle processing', async () => {
            // Temporarily disable subtitle processing
            process.env.SUBTITLE_ENABLED = 'false';

            const inputValidateLambda = require('../input-validate/index.js');

            const inputEvent = {
                guid: 'test-disabled-guid',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            const result = await inputValidateLambda.handler(inputEvent);

            expect(result.subtitleConfig.enabled).to.be.false;
        });
    });

    describe('Workflow Independence', () => {
        it('should continue main workflow even if subtitle processor fails', async () => {
            // Mock subtitle processor to fail, but other workflows to succeed
            sfnClientMock.on(StartExecutionCommand).callsFake((command) => {
                if (command.stateMachineArn === 'test-subtitle-processor-workflow') {
                    throw new Error('Subtitle processing failed');
                }
                return Promise.resolve({ executionArn: 'test-arn' });
            });

            const stepFunctionsLambda = require('../step-functions/index.js');

            // Test that process workflow still succeeds
            const processEvent = { guid: 'test-guid' };
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Test that subtitle processor fails as expected
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

    describe('Configuration Validation', () => {
        it('should validate supported languages configuration', () => {
            const supportedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'];
            const configuredLanguages = process.env.SUBTITLE_TARGET_LANGUAGES.split(',');

            configuredLanguages.forEach(lang => {
                expect(supportedLanguages).to.include(lang, `Language ${lang} should be supported`);
            });
        });

        it('should validate state machine definition exists', () => {
            const fs = require('fs');
            const path = require('path');
            
            const stateMachineFile = path.join(__dirname, '../cdk/lib/subtitle-processor-state-machine.json');
            expect(fs.existsSync(stateMachineFile)).to.be.true;

            const content = fs.readFileSync(stateMachineFile, 'utf8');
            const stateMachine = JSON.parse(content);

            expect(stateMachine).to.have.property('StartAt');
            expect(stateMachine).to.have.property('States');
            expect(stateMachine.States).to.have.property('LoadSubtitleConfiguration');
            expect(stateMachine.States).to.have.property('TriggerPublishWorkflow');
        });
    });
});
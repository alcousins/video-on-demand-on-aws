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
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

describe('#END-TO-END WORKFLOW VALIDATION::', () => {
    const sfnClientMock = mockClient(SFNClient);
    const s3ClientMock = mockClient(S3Client);
    const dynamoClientMock = mockClient(DynamoDBClient);
    const lambdaClientMock = mockClient(LambdaClient);

    beforeEach(() => {
        // Set up environment variables for all components
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
        process.env.DynamoDBTable = 'test-table';
        process.env.SnsTopic = 'test-sns-topic';

        // Mock S3 responses
        s3ClientMock.on(HeadObjectCommand).resolves({
            ContentLength: 1000000,
            LastModified: new Date()
        });

        s3ClientMock.on(GetObjectCommand).resolves({
            Body: {
                transformToString: () => Promise.resolve(JSON.stringify({
                    srcVideo: 'test-video.mp4'
                }))
            }
        });

        // Mock DynamoDB responses
        dynamoClientMock.on(UpdateItemCommand).resolves({});

        // Mock Lambda responses
        lambdaClientMock.on(InvokeCommand).resolves({
            StatusCode: 200,
            Payload: Buffer.from(JSON.stringify({ success: true }))
        });

        // Mock Step Functions responses
        sfnClientMock.on(StartExecutionCommand).resolves({
            executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345',
            startDate: new Date()
        });
    });

    afterEach(() => {
        sfnClientMock.reset();
        s3ClientMock.reset();
        dynamoClientMock.reset();
        lambdaClientMock.reset();
    });

    describe('Complete Workflow Integration', () => {
        it('should complete full workflow: Ingest → Process → Subtitle Processing → Publish', async () => {
            // Step 1: Input Validation (Ingest Workflow)
            const inputValidateLambda = require('../input-validate/index.js');
            
            const inputEvent = {
                guid: 'test-end-to-end-guid',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            const validatedInput = await inputValidateLambda.handler(inputEvent);
            
            // Verify input validation includes subtitle configuration
            expect(validatedInput).to.have.property('subtitleConfig');
            expect(validatedInput.subtitleConfig.enabled).to.be.true;
            expect(validatedInput.subtitleConfig.targetLanguages).to.include('en');
            expect(validatedInput.subtitleConfig.targetLanguages).to.include('es');

            // Step 2: Step Functions Orchestration
            const stepFunctionsLambda = require('../step-functions/index.js');

            // Test Process Workflow trigger
            const processEvent = {
                guid: validatedInput.guid
            };

            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Verify Process Workflow was triggered
            let calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].args[0].input.stateMachineArn).to.equal('test-process-workflow');

            // Step 3: Subtitle Processor Trigger (after MediaConvert job submission)
            sfnClientMock.reset();
            
            const subtitleTriggerEvent = {
                guid: validatedInput.guid,
                srcVideo: validatedInput.srcVideo,
                srcBucket: validatedInput.srcBucket,
                destBucket: validatedInput.destBucket,
                subtitleConfig: validatedInput.subtitleConfig,
                subtitleTrigger: true
            };

            const subtitleResult = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(subtitleResult).to.equal('success');

            // Verify Subtitle Processor was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].args[0].input.stateMachineArn).to.equal('test-subtitle-processor-workflow');
            expect(calls[0].args[0].input.name).to.equal(`${validatedInput.guid}-subtitle`);

            // Verify subtitle trigger data
            const subtitleInputData = JSON.parse(calls[0].args[0].input.input);
            expect(subtitleInputData.subtitleTrigger).to.be.true;
            expect(subtitleInputData.subtitleConfig).to.deep.equal(validatedInput.subtitleConfig);

            // Step 4: Publish Workflow trigger (after subtitle processing completes)
            sfnClientMock.reset();

            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: {
                        guid: validatedInput.guid,
                        workflow: 'subtitle-processor'
                    }
                }
            };

            const publishResult = await stepFunctionsLambda.handler(publishEvent);
            expect(publishResult).to.equal('success');

            // Verify Publish Workflow was triggered
            calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].args[0].input.stateMachineArn).to.equal('test-publish-workflow');
        });

        it('should handle subtitle processing disabled configuration', async () => {
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

            const validatedInput = await inputValidateLambda.handler(inputEvent);
            
            // Verify subtitle processing is disabled
            expect(validatedInput.subtitleConfig.enabled).to.be.false;

            // Test that subtitle processor can still be triggered but will skip processing
            const stepFunctionsLambda = require('../step-functions/index.js');

            const subtitleTriggerEvent = {
                guid: validatedInput.guid,
                srcVideo: validatedInput.srcVideo,
                srcBucket: validatedInput.srcBucket,
                destBucket: validatedInput.destBucket,
                subtitleConfig: validatedInput.subtitleConfig,
                subtitleTrigger: true
            };

            const result = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(result).to.equal('success');

            // Verify subtitle processor was still triggered (it will handle disabled state internally)
            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(1);
            expect(calls[0].args[0].input.stateMachineArn).to.equal('test-subtitle-processor-workflow');
        });

        it('should handle metadata file workflow with subtitle overrides', async () => {
            // Mock metadata file with subtitle overrides
            s3ClientMock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: () => Promise.resolve(JSON.stringify({
                        srcVideo: 'test-video.mp4',
                        subtitleEnabled: true,
                        subtitlePrimaryLanguage: 'es',
                        subtitleTargetLanguages: ['en', 'fr', 'de']
                    }))
                }
            });

            const inputValidateLambda = require('../input-validate/index.js');
            
            const metadataEvent = {
                guid: 'test-metadata-guid',
                workflowTrigger: 'Metadata',
                Records: [{
                    s3: {
                        object: {
                            key: 'metadata.json'
                        }
                    }
                }]
            };

            const validatedInput = await inputValidateLambda.handler(metadataEvent);
            
            // Verify metadata overrides were applied
            expect(validatedInput.subtitleEnabled).to.be.true;
            expect(validatedInput.subtitlePrimaryLanguage).to.equal('es');
            expect(validatedInput.subtitleTargetLanguages).to.deep.equal(['en', 'fr', 'de']);

            // Test workflow continues normally
            const stepFunctionsLambda = require('../step-functions/index.js');

            const processEvent = {
                guid: validatedInput.guid
            };

            const result = await stepFunctionsLambda.handler(processEvent);
            expect(result).to.equal('success');
        });
    });

    describe('Error Handling and Workflow Independence', () => {
        it('should continue main workflow when subtitle processor fails', async () => {
            // Mock subtitle processor to fail
            sfnClientMock.on(StartExecutionCommand).callsFake((command) => {
                if (command.stateMachineArn === 'test-subtitle-processor-workflow') {
                    throw new Error('Subtitle processing failed');
                }
                return Promise.resolve({ 
                    executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345' 
                });
            });

            const stepFunctionsLambda = require('../step-functions/index.js');

            // Test that process workflow still succeeds
            const processEvent = { guid: 'test-error-guid' };
            const processResult = await stepFunctionsLambda.handler(processEvent);
            expect(processResult).to.equal('success');

            // Test that subtitle processor fails as expected
            const subtitleEvent = {
                guid: 'test-error-guid',
                srcVideo: 'test.mp4',
                subtitleTrigger: true
            };

            try {
                await stepFunctionsLambda.handler(subtitleEvent);
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error.message).to.equal('Subtitle processing failed');
            }

            // Reset mock to allow publish workflow to succeed
            sfnClientMock.reset();
            sfnClientMock.on(StartExecutionCommand).resolves({ 
                executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test:12345' 
            });

            // Test that publish workflow can still be triggered
            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: { guid: 'test-error-guid' }
                }
            };

            const publishResult = await stepFunctionsLambda.handler(publishEvent);
            expect(publishResult).to.equal('success');
        });

        it('should validate workflow independence properties', () => {
            // Property 10: Workflow Independence
            // Verify that subtitle processor runs independently without blocking main workflow
            
            const stepFunctionsLambda = require('../step-functions/index.js');
            
            // Test that different workflow triggers use different state machines
            const processEvent = { guid: 'test-independence' };
            const subtitleEvent = { 
                guid: 'test-independence', 
                subtitleTrigger: true,
                srcVideo: 'test.mp4'
            };
            const publishEvent = { 
                detail: { 
                    status: 'COMPLETE', 
                    userMetadata: { guid: 'test-independence' } 
                } 
            };

            // All should be handled by different state machines
            return Promise.all([
                stepFunctionsLambda.handler(processEvent),
                stepFunctionsLambda.handler(subtitleEvent),
                stepFunctionsLambda.handler(publishEvent)
            ]).then(results => {
                expect(results).to.deep.equal(['success', 'success', 'success']);
                
                const calls = sfnClientMock.commandCalls(StartExecutionCommand);
                expect(calls).to.have.lengthOf(3);
                
                // Verify different state machines were called
                const stateMachines = calls.map(call => call.args[0].input.stateMachineArn);
                expect(stateMachines).to.include('test-process-workflow');
                expect(stateMachines).to.include('test-subtitle-processor-workflow');
                expect(stateMachines).to.include('test-publish-workflow');
            });
        });
    });

    describe('Configuration and Data Flow Validation', () => {
        it('should validate subtitle configuration flows through all components', async () => {
            const inputValidateLambda = require('../input-validate/index.js');
            
            const inputEvent = {
                guid: 'test-config-flow',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            const validatedInput = await inputValidateLambda.handler(inputEvent);
            
            // Verify configuration structure
            expect(validatedInput.subtitleConfig).to.have.all.keys([
                'enabled', 'primaryLanguage', 'targetLanguages'
            ]);
            
            // Verify configuration values match environment
            expect(validatedInput.subtitleConfig.enabled).to.equal(
                JSON.parse(process.env.SUBTITLE_ENABLED)
            );
            expect(validatedInput.subtitleConfig.primaryLanguage).to.equal(
                process.env.SUBTITLE_PRIMARY_LANGUAGE
            );
            expect(validatedInput.subtitleConfig.targetLanguages).to.deep.equal(
                process.env.SUBTITLE_TARGET_LANGUAGES.split(',')
            );

            // Test that configuration flows to subtitle processor
            const stepFunctionsLambda = require('../step-functions/index.js');

            const subtitleTriggerEvent = {
                guid: validatedInput.guid,
                srcVideo: validatedInput.srcVideo,
                srcBucket: validatedInput.srcBucket,
                destBucket: validatedInput.destBucket,
                subtitleConfig: validatedInput.subtitleConfig,
                subtitleTrigger: true
            };

            await stepFunctionsLambda.handler(subtitleTriggerEvent);

            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            const inputData = JSON.parse(calls[0].args[0].input.input);
            
            // Verify configuration is preserved in subtitle processor input
            expect(inputData.subtitleConfig).to.deep.equal(validatedInput.subtitleConfig);
        });

        it('should validate supported language configuration', () => {
            // Property 12: Configuration Respect
            const supportedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'];
            const configuredLanguages = process.env.SUBTITLE_TARGET_LANGUAGES.split(',');

            configuredLanguages.forEach(lang => {
                expect(supportedLanguages).to.include(lang.trim(), 
                    `Language ${lang} should be supported according to requirements`);
            });

            // Verify primary language options
            const validPrimaryLanguages = ['auto', ...supportedLanguages];
            expect(validPrimaryLanguages).to.include(process.env.SUBTITLE_PRIMARY_LANGUAGE);
        });
    });

    describe('State Machine Integration Validation', () => {
        it('should validate state machine definition exists and is well-formed', () => {
            const fs = require('fs');
            const path = require('path');
            
            const stateMachineFile = path.join(__dirname, '../cdk/lib/subtitle-processor-state-machine.json');
            expect(fs.existsSync(stateMachineFile), 'State machine definition file should exist').to.be.true;

            const content = fs.readFileSync(stateMachineFile, 'utf8');
            const stateMachine = JSON.parse(content);

            // Validate required state machine structure
            expect(stateMachine).to.have.property('StartAt');
            expect(stateMachine).to.have.property('States');
            
            // Validate key states exist
            const requiredStates = [
                'LoadSubtitleConfiguration',
                'CheckSubtitleConfig',
                'StartTranscription',
                'StartTranslationCoordinator',
                'ExecuteTranslations',
                'GenerateWebVTTFiles',
                'TriggerPublishWorkflow'
            ];

            requiredStates.forEach(stateName => {
                expect(stateMachine.States).to.have.property(stateName, 
                    `State ${stateName} should exist in state machine`);
            });

            // Validate error handling states exist
            const errorStates = [
                'HandleConfigurationError',
                'HandleTranscriptionError',
                'HandleTranslationError',
                'HandleWebVTTError'
            ];

            errorStates.forEach(stateName => {
                expect(stateMachine.States).to.have.property(stateName, 
                    `Error handling state ${stateName} should exist`);
            });
        });

        it('should validate Lambda function placeholders in state machine', () => {
            const fs = require('fs');
            const path = require('path');
            
            const stateMachineFile = path.join(__dirname, '../cdk/lib/subtitle-processor-state-machine.json');
            const content = fs.readFileSync(stateMachineFile, 'utf8');

            // Validate that placeholders exist for all Lambda functions
            const requiredPlaceholders = [
                '${SubtitleConfigLambdaArn}',
                '${TranscriptionLambdaArn}',
                '${TranslationCoordinatorLambdaArn}',
                '${TranslationWorkerLambdaArn}',
                '${WebVTTGeneratorLambdaArn}',
                '${DynamoUpdateLambdaArn}',
                '${ErrorHandlerLambdaArn}',
                '${StepFunctionsLambdaArn}'
            ];

            requiredPlaceholders.forEach(placeholder => {
                expect(content).to.include(placeholder, 
                    `State machine should reference ${placeholder}`);
            });
        });
    });
});
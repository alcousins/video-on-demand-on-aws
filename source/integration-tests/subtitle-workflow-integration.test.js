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
const { DynamoDBClient, UpdateItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

// Import Lambda functions
const stepFunctionsLambda = require('../step-functions/index.js');
const inputValidateLambda = require('../input-validate/index.js');
const subtitleConfigLambda = require('../subtitle-config/index.js');

describe('#SUBTITLE WORKFLOW INTEGRATION::', () => {
    // Mock AWS clients
    const sfnClientMock = mockClient(SFNClient);
    const dynamoClientMock = mockClient(DynamoDBClient);
    const s3ClientMock = mockClient(S3Client);

    // Set up environment variables
    beforeEach(() => {
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
    });

    afterEach(() => {
        sfnClientMock.reset();
        dynamoClientMock.reset();
        s3ClientMock.reset();
    });

    describe('Complete Workflow Integration', () => {
        it('should process video upload through complete subtitle workflow', async () => {
            // Mock successful responses
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });
            dynamoClientMock.on(GetItemCommand).resolves({
                Item: {
                    guid: { S: 'test-guid' },
                    srcVideo: { S: 'test-video.mp4' },
                    srcBucket: { S: 'test-source-bucket' },
                    destBucket: { S: 'test-dest-bucket' }
                }
            });

            // Test 1: Video upload triggers ingest workflow
            const videoUploadEvent = {
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            const ingestResponse = await stepFunctionsLambda.handler(videoUploadEvent);
            expect(ingestResponse).to.equal('success');

            // Verify ingest workflow was triggered
            expect(sfnClientMock.commandCalls(StartExecutionCommand)).to.have.lengthOf(1);
            const ingestCall = sfnClientMock.commandCalls(StartExecutionCommand)[0];
            expect(ingestCall.args[0].input.stateMachineArn).to.equal('test-ingest-workflow');

            // Test 2: Input validation includes subtitle configuration
            const inputValidateEvent = {
                guid: 'test-guid',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            const validatedInput = await inputValidateLambda.handler(inputValidateEvent);
            expect(validatedInput).to.have.property('subtitleConfig');
            expect(validatedInput.subtitleConfig.enabled).to.be.true;
            expect(validatedInput.subtitleConfig.primaryLanguage).to.equal('auto');
            expect(validatedInput.subtitleConfig.targetLanguages).to.include('en');
            expect(validatedInput.subtitleConfig.targetLanguages).to.include('es');

            // Test 3: Process workflow triggers subtitle processor
            sfnClientMock.reset();
            const processEvent = {
                guid: 'test-guid'
            };

            const processResponse = await stepFunctionsLambda.handler(processEvent);
            expect(processResponse).to.equal('success');

            // Verify process workflow was triggered
            expect(sfnClientMock.commandCalls(StartExecutionCommand)).to.have.lengthOf(1);
            const processCall = sfnClientMock.commandCalls(StartExecutionCommand)[0];
            expect(processCall.args[0].input.stateMachineArn).to.equal('test-process-workflow');

            // Test 4: Subtitle processor trigger
            sfnClientMock.reset();
            const subtitleTriggerEvent = {
                guid: 'test-guid',
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

            const subtitleResponse = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(subtitleResponse).to.equal('success');

            // Verify subtitle processor workflow was triggered
            expect(sfnClientMock.commandCalls(StartExecutionCommand)).to.have.lengthOf(1);
            const subtitleCall = sfnClientMock.commandCalls(StartExecutionCommand)[0];
            expect(subtitleCall.args[0].input.stateMachineArn).to.equal('test-subtitle-processor-workflow');

            // Test 5: Publish workflow trigger
            sfnClientMock.reset();
            const publishEvent = {
                detail: {
                    status: 'COMPLETE',
                    userMetadata: {
                        guid: 'test-guid',
                        workflow: 'test-workflow'
                    }
                }
            };

            const publishResponse = await stepFunctionsLambda.handler(publishEvent);
            expect(publishResponse).to.equal('success');

            // Verify publish workflow was triggered
            expect(sfnClientMock.commandCalls(StartExecutionCommand)).to.have.lengthOf(1);
            const publishCall = sfnClientMock.commandCalls(StartExecutionCommand)[0];
            expect(publishCall.args[0].input.stateMachineArn).to.equal('test-publish-workflow');
        });

        it('should handle subtitle configuration from metadata file', async () => {
            // Mock S3 response with metadata file containing subtitle config
            const metadataContent = JSON.stringify({
                srcVideo: 'test-video.mp4',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr', 'de']
                }
            });

            s3ClientMock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: async () => metadataContent
                }
            });

            const metadataEvent = {
                guid: 'test-guid',
                workflowTrigger: 'Metadata',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-metadata.json'
                        }
                    }
                }]
            };

            const validatedInput = await inputValidateLambda.handler(metadataEvent);
            
            // Verify metadata overrides default subtitle configuration
            expect(validatedInput.subtitleConfig.enabled).to.be.true;
            expect(validatedInput.subtitleConfig.primaryLanguage).to.equal('en');
            expect(validatedInput.subtitleConfig.targetLanguages).to.deep.equal(['es', 'fr', 'de']);
        });

        it('should handle disabled subtitle processing', async () => {
            // Set subtitle processing to disabled
            process.env.SUBTITLE_ENABLED = 'false';

            const inputEvent = {
                guid: 'test-guid',
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
            expect(validatedInput.subtitleConfig.enabled).to.be.false;

            // Subtitle processor should still be triggered but will skip processing
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });
            
            const subtitleTriggerEvent = {
                guid: 'test-guid',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: {
                    enabled: false,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en']
                },
                subtitleTrigger: true
            };

            const response = await stepFunctionsLambda.handler(subtitleTriggerEvent);
            expect(response).to.equal('success');
        });
    });

    describe('Error Handling Integration', () => {
        it('should continue main workflow when subtitle processing fails', async () => {
            // Mock subtitle processor failure
            sfnClientMock.on(StartExecutionCommand).rejects(new Error('Subtitle processing failed'));

            const subtitleTriggerEvent = {
                guid: 'test-guid',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en', 'es']
                },
                subtitleTrigger: true
            };

            // Should throw error but not break the main workflow
            try {
                await stepFunctionsLambda.handler(subtitleTriggerEvent);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.equal('Subtitle processing failed');
            }
        });

        it('should handle invalid subtitle configuration gracefully', async () => {
            const invalidConfigEvent = {
                guid: 'test-guid',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        object: {
                            key: 'test-video.mp4'
                        }
                    }
                }]
            };

            // Set invalid environment variables
            process.env.SUBTITLE_TARGET_LANGUAGES = '';
            
            const validatedInput = await inputValidateLambda.handler(invalidConfigEvent);
            
            // Should handle empty target languages gracefully
            expect(validatedInput.subtitleConfig.targetLanguages).to.be.an('array');
            expect(validatedInput.subtitleConfig.targetLanguages).to.have.lengthOf(1);
            expect(validatedInput.subtitleConfig.targetLanguages[0]).to.equal('');
        });
    });

    describe('Data Flow Validation', () => {
        it('should pass correct data between workflow steps', async () => {
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });

            const subtitleTriggerEvent = {
                guid: 'test-guid-123',
                srcVideo: 'sample-video.mp4',
                srcBucket: 'source-bucket-test',
                destBucket: 'dest-bucket-test',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr', 'de', 'it']
                },
                subtitleTrigger: true
            };

            await stepFunctionsLambda.handler(subtitleTriggerEvent);

            // Verify the correct data was passed to the state machine
            const call = sfnClientMock.commandCalls(StartExecutionCommand)[0];
            const inputData = JSON.parse(call.args[0].input.input);
            
            expect(inputData.guid).to.equal('test-guid-123');
            expect(inputData.srcVideo).to.equal('sample-video.mp4');
            expect(inputData.srcBucket).to.equal('source-bucket-test');
            expect(inputData.destBucket).to.equal('dest-bucket-test');
            expect(inputData.subtitleConfig.enabled).to.be.true;
            expect(inputData.subtitleConfig.primaryLanguage).to.equal('en');
            expect(inputData.subtitleConfig.targetLanguages).to.deep.equal(['es', 'fr', 'de', 'it']);
            expect(inputData.subtitleTrigger).to.be.true;
        });

        it('should generate unique execution names for subtitle processor', async () => {
            sfnClientMock.on(StartExecutionCommand).resolves({ executionArn: 'test-arn' });

            const event1 = {
                guid: 'guid-1',
                srcVideo: 'video1.mp4',
                subtitleTrigger: true
            };

            const event2 = {
                guid: 'guid-2',
                srcVideo: 'video2.mp4',
                subtitleTrigger: true
            };

            await stepFunctionsLambda.handler(event1);
            await stepFunctionsLambda.handler(event2);

            const calls = sfnClientMock.commandCalls(StartExecutionCommand);
            expect(calls).to.have.lengthOf(2);
            
            // Verify unique execution names
            expect(calls[0].args[0].input.name).to.equal('guid-1-subtitle');
            expect(calls[1].args[0].input.name).to.equal('guid-2-subtitle');
        });
    });
});
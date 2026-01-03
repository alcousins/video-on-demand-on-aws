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
const path = require('path');
const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = require('../index.js');

describe('#DYNAMODB UPDATE::', () => {
    const _event = {
        guid: 'SUCCESS',
        hello: 'from AWS mock'
    };

    const _subtitleEvent = {
        guid: 'SUBTITLE_SUCCESS',
        subtitleOperation: 'updateTranscriptionStatus',
        transcriptionStatus: 'COMPLETED',
        transcriptionData: {
            transcriptionJobId: 'job-123',
            detectedLanguage: 'en-US'
        }
    };

    process.env.ErrorHandler = 'error_handler';
    process.env.DynamoDBTable = 'test-table';

    const dynamoDBDocumentClientMock = mockClient(DynamoDBDocumentClient);
    const lambdaClientMock = mockClient(LambdaClient);
    
    afterEach(() => {
        dynamoDBDocumentClientMock.reset();
        lambdaClientMock.reset();
    });

    describe('Standard DynamoDB Updates', () => {
        it('should return "SUCCESS" when db put returns success', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(_event);
            expect(response.guid).to.equal('SUCCESS');
        });

        it('should return "DB ERROR" when db put fails', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).rejects('DB ERROR');
            lambdaClientMock.on(InvokeCommand).resolves();

            await lambda.handler(_event).catch(err => {
                expect(err.toString()).to.equal('Error: DB ERROR');
            });
        });
    });

    describe('Subtitle-Specific DynamoDB Updates', () => {
        it('should handle subtitle transcription status update', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(_subtitleEvent);
            expect(response.guid).to.equal('SUBTITLE_SUCCESS');
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.Key.guid).to.equal('SUBTITLE_SUCCESS');
            expect(updateCall.args[0].input.UpdateExpression).to.include('subtitleProcessingStatus = :status');
        });

        it('should handle subtitle translation status update', async () => {
            const translationEvent = {
                guid: 'TRANSLATION_SUCCESS',
                subtitleOperation: 'updateTranslationStatus',
                translationStatus: 'IN_PROGRESS',
                translationData: {
                    completedLanguages: ['en'],
                    totalLanguages: 3
                }
            };

            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(translationEvent);
            expect(response.guid).to.equal('TRANSLATION_SUCCESS');
        });

        it('should handle WebVTT status update with file information', async () => {
            const webvttEvent = {
                guid: 'WEBVTT_SUCCESS',
                subtitleOperation: 'updateWebVTTStatus',
                webvttStatus: 'COMPLETED',
                uploadedFiles: [
                    {
                        language: 'en',
                        s3Location: 's3://bucket/video.en.vtt',
                        cloudFrontUrl: 'https://cdn.example.com/video.en.vtt'
                    }
                ]
            };

            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(webvttEvent);
            expect(response.guid).to.equal('WEBVTT_SUCCESS');
        });

        it('should handle subtitle configuration update', async () => {
            const configEvent = {
                guid: 'CONFIG_SUCCESS',
                subtitleOperation: 'updateSubtitleConfiguration',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en', 'es']
                }
            };

            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(configEvent);
            expect(response.guid).to.equal('CONFIG_SUCCESS');
        });

        it('should handle MediaConvert completion update', async () => {
            const mediaConvertEvent = {
                guid: 'MEDIACONVERT_SUCCESS',
                subtitleOperation: 'updateMediaConvertCompletion',
                mediaConvertData: {
                    subtitleFiles: {
                        'en': 's3://final-bucket/video.en.vtt'
                    },
                    processingStartTime: '2023-01-01T00:00:00.000Z'
                }
            };

            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(mediaConvertEvent);
            expect(response.guid).to.equal('MEDIACONVERT_SUCCESS');
        });

        it('should handle subtitle error update', async () => {
            const errorEvent = {
                guid: 'ERROR_SUCCESS',
                subtitleOperation: 'updateSubtitleError',
                errorDetails: 'Test error message',
                correlationId: 'corr-123'
            };

            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(errorEvent);
            expect(response.guid).to.equal('ERROR_SUCCESS');
        });

        it('should handle performance metrics update', async () => {
            const metricsEvent = {
                guid: 'METRICS_SUCCESS',
                subtitleOperation: 'updatePerformanceMetrics',
                performanceMetrics: {
                    transcriptionDurationSeconds: 120,
                    translationDurationSeconds: 45
                }
            };

            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();

            const response = await lambda.handler(metricsEvent);
            expect(response.guid).to.equal('METRICS_SUCCESS');
        });

        it('should throw error for unknown subtitle operation', async () => {
            const unknownEvent = {
                guid: 'UNKNOWN_OPERATION',
                subtitleOperation: 'unknownOperation'
            };

            lambdaClientMock.on(InvokeCommand).resolves();

            await lambda.handler(unknownEvent).catch(err => {
                expect(err.message).to.include('Unknown subtitle operation');
            });
        });
    });
});

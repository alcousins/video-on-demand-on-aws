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
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const {
    SUBTITLE_DB_FIELDS,
    createSubtitleProcessingUpdate,
    updateTranscriptionStatus,
    updateTranslationStatus,
    updateWebVTTStatus,
    updateSubtitleConfiguration,
    updateMediaConvertCompletion,
    getSubtitleProcessingStatus,
    updateSubtitleError,
    updatePerformanceMetrics
} = require('./subtitle-db-utils.js');

describe('#SUBTITLE DB UTILS::', () => {
    const dynamoDBDocumentClientMock = mockClient(DynamoDBDocumentClient);
    
    beforeEach(() => {
        process.env.DynamoDBTable = 'test-table';
        dynamoDBDocumentClientMock.reset();
    });

    // Helper function to create a properly mocked DynamoDB client
    function createMockDocClient() {
        const dynamoClient = new DynamoDBClient({});
        return DynamoDBDocumentClient.from(dynamoClient);
    }

    describe('createSubtitleProcessingUpdate', () => {
        it('should create basic update parameters with status and timestamps', () => {
            const guid = 'test-guid';
            const status = 'transcribing';
            
            const params = createSubtitleProcessingUpdate(guid, status);
            
            expect(params.TableName).to.equal('test-table');
            expect(params.Key.guid).to.equal(guid);
            expect(params.UpdateExpression).to.include('subtitleProcessingStatus = :status');
            expect(params.UpdateExpression).to.include('subtitleProcessingLastUpdated = :lastUpdated');
            expect(params.UpdateExpression).to.include('subtitleProcessingStartTime = :startTime');
            expect(params.ExpressionAttributeValues[':status']).to.equal(status);
        });

        it('should set end time for completed status', () => {
            const guid = 'test-guid';
            const status = 'completed';
            
            const params = createSubtitleProcessingUpdate(guid, status);
            
            expect(params.UpdateExpression).to.include('subtitleProcessingEndTime = :endTime');
            expect(params.ExpressionAttributeValues[':endTime']).to.be.a('string');
        });

        it('should include error details when provided', () => {
            const guid = 'test-guid';
            const status = 'failed';
            const errorDetails = 'Test error message';
            
            const params = createSubtitleProcessingUpdate(guid, status, { errorDetails });
            
            expect(params.UpdateExpression).to.include('subtitleErrorDetails = :errorDetails');
            expect(params.UpdateExpression).to.include('subtitleLastErrorTimestamp = :errorTimestamp');
            expect(params.UpdateExpression).to.include('subtitleErrorCount = if_not_exists(subtitleErrorCount, :zero) + :one');
            expect(params.ExpressionAttributeValues[':errorDetails']).to.equal(errorDetails);
        });

        it('should include additional fields with subtitle prefix', () => {
            const guid = 'test-guid';
            const status = 'transcribing';
            const additionalFields = {
                transcriptionJobId: 'job-123',
                detectedLanguage: 'en-US'
            };
            
            const params = createSubtitleProcessingUpdate(guid, status, { additionalFields });
            
            expect(params.UpdateExpression).to.include('subtitleTranscriptionJobId = :additionalValue0');
            expect(params.UpdateExpression).to.include('subtitleDetectedLanguage = :additionalValue1');
            expect(params.ExpressionAttributeValues[':additionalValue0']).to.equal('job-123');
            expect(params.ExpressionAttributeValues[':additionalValue1']).to.equal('en-US');
        });
    });

    describe('updateTranscriptionStatus', () => {
        it('should update transcription status to completed', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const transcriptionStatus = 'COMPLETED';
            const transcriptionData = {
                transcriptionJobId: 'job-123',
                detectedLanguage: 'en-US'
            };
            
            await updateTranscriptionStatus(docClient, guid, transcriptionStatus, transcriptionData);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.Key.guid).to.equal(guid);
            expect(updateCall.args[0].input.UpdateExpression).to.include('subtitleProcessingStatus = :status');
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('completed');
        });

        it('should update transcription status to failed with error details', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const transcriptionStatus = 'FAILED';
            const transcriptionData = {
                failureReason: 'Audio quality too low'
            };
            
            await updateTranscriptionStatus(docClient, guid, transcriptionStatus, transcriptionData);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('failed');
            expect(updateCall.args[0].input.UpdateExpression).to.include('subtitleErrorDetails = :errorDetails');
        });
    });

    describe('updateTranslationStatus', () => {
        it('should update translation status with progress data', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const translationStatus = 'IN_PROGRESS';
            const translationData = {
                completedLanguages: ['en', 'es'],
                totalLanguages: 3
            };
            
            await updateTranslationStatus(docClient, guid, translationStatus, translationData);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.Key.guid).to.equal(guid);
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('translating');
        });
    });

    describe('updateWebVTTStatus', () => {
        it('should update WebVTT status with uploaded files information', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const webvttStatus = 'COMPLETED';
            const uploadedFiles = [
                {
                    language: 'en',
                    s3Location: 's3://bucket/path/video.en.vtt',
                    cloudFrontUrl: 'https://cdn.example.com/video.en.vtt'
                },
                {
                    language: 'es',
                    s3Location: 's3://bucket/path/video.es.vtt',
                    cloudFrontUrl: 'https://cdn.example.com/video.es.vtt'
                }
            ];
            
            await updateWebVTTStatus(docClient, guid, webvttStatus, uploadedFiles);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('completed');
            
            // Check that file information is included
            const updateExpression = updateCall.args[0].input.UpdateExpression;
            expect(updateExpression).to.include('subtitleFinalFiles');
            expect(updateExpression).to.include('subtitleCloudFrontUrls');
            expect(updateExpression).to.include('subtitleFileCount');
            expect(updateExpression).to.include('subtitleSupportedLanguages');
        });

        it('should handle WebVTT generation failure', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const webvttStatus = 'FAILED';
            const errorDetails = 'Failed to generate WebVTT files';
            
            await updateWebVTTStatus(docClient, guid, webvttStatus, null, errorDetails);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('failed');
            expect(updateCall.args[0].input.UpdateExpression).to.include('subtitleErrorDetails = :errorDetails');
        });
    });

    describe('updateSubtitleConfiguration', () => {
        it('should update subtitle configuration', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const config = {
                enabled: true,
                primaryLanguage: 'auto',
                targetLanguages: ['en', 'es', 'fr']
            };
            
            await updateSubtitleConfiguration(docClient, guid, config);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.Key.guid).to.equal(guid);
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('pending');
            
            const updateExpression = updateCall.args[0].input.UpdateExpression;
            expect(updateExpression).to.include('subtitleProcessingEnabled');
            expect(updateExpression).to.include('subtitlePrimaryLanguage');
            expect(updateExpression).to.include('subtitleTargetLanguages');
            expect(updateExpression).to.include('subtitleConfig');
        });
    });

    describe('updateMediaConvertCompletion', () => {
        it('should update MediaConvert completion with final file locations', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const mediaConvertData = {
                subtitleFiles: {
                    'en': 's3://final-bucket/video.en.vtt',
                    'es': 's3://final-bucket/video.es.vtt'
                },
                cloudFrontUrls: {
                    'en': 'https://cdn.example.com/video.en.vtt',
                    'es': 'https://cdn.example.com/video.es.vtt'
                },
                processingStartTime: '2023-01-01T00:00:00.000Z'
            };
            
            await updateMediaConvertCompletion(docClient, guid, mediaConvertData);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('completed');
            
            const updateExpression = updateCall.args[0].input.UpdateExpression;
            expect(updateExpression).to.include('subtitleFinalFiles');
            expect(updateExpression).to.include('subtitleCloudFrontUrls');
            expect(updateExpression).to.include('subtitleProcessingDurationSeconds');
        });
    });

    describe('getSubtitleProcessingStatus', () => {
        it('should retrieve subtitle processing status', async () => {
            const mockItem = {
                guid: 'test-guid',
                subtitleProcessingStatus: 'completed',
                subtitleProcessingEnabled: true,
                subtitleTargetLanguages: ['en', 'es'],
                subtitleFinalFiles: {
                    'en': 's3://bucket/video.en.vtt',
                    'es': 's3://bucket/video.es.vtt'
                }
            };
            
            dynamoDBDocumentClientMock.on(GetCommand).resolves({ Item: mockItem });
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            
            const result = await getSubtitleProcessingStatus(docClient, guid);
            
            expect(result).to.be.an('object');
            expect(result.PROCESSING_STATUS).to.equal('completed');
            expect(result.PROCESSING_ENABLED).to.equal(true);
            expect(result.TARGET_LANGUAGES).to.deep.equal(['en', 'es']);
        });

        it('should return null for non-existent record', async () => {
            dynamoDBDocumentClientMock.on(GetCommand).resolves({});
            
            const docClient = createMockDocClient();
            const guid = 'non-existent-guid';
            
            const result = await getSubtitleProcessingStatus(docClient, guid);
            
            expect(result).to.be.null;
        });
    });

    describe('updateSubtitleError', () => {
        it('should update error details with correlation ID', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const errorDetails = 'Transcription service unavailable';
            const correlationId = 'corr-123';
            
            await updateSubtitleError(docClient, guid, errorDetails, correlationId);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            expect(updateCall.args[0].input.ExpressionAttributeValues[':status']).to.equal('failed');
            expect(updateCall.args[0].input.UpdateExpression).to.include('subtitleErrorDetails = :errorDetails');
            expect(updateCall.args[0].input.UpdateExpression).to.include('subtitleCorrelationId');
        });
    });

    describe('updatePerformanceMetrics', () => {
        it('should update performance metrics for all stages', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const performanceMetrics = {
                transcriptionDurationSeconds: 120,
                translationDurationSeconds: 45,
                webvttGenerationDurationSeconds: 15,
                totalProcessingDurationSeconds: 180
            };
            
            await updatePerformanceMetrics(docClient, guid, performanceMetrics);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            const updateExpression = updateCall.args[0].input.UpdateExpression;
            
            expect(updateExpression).to.include('subtitleTranscriptionDurationSeconds');
            expect(updateExpression).to.include('subtitleTranslationDurationSeconds');
            expect(updateExpression).to.include('subtitleWebvttGenerationDurationSeconds');
            expect(updateExpression).to.include('subtitleProcessingDurationSeconds');
        });

        it('should handle partial performance metrics', async () => {
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves();
            
            const docClient = createMockDocClient();
            const guid = 'test-guid';
            const performanceMetrics = {
                transcriptionDurationSeconds: 120
            };
            
            await updatePerformanceMetrics(docClient, guid, performanceMetrics);
            
            const updateCall = dynamoDBDocumentClientMock.commandCalls(UpdateCommand)[0];
            const updateExpression = updateCall.args[0].input.UpdateExpression;
            
            expect(updateExpression).to.include('subtitleTranscriptionDurationSeconds');
            expect(updateExpression).to.not.include('subtitleTranslationDurationSeconds');
        });
    });

    describe('SUBTITLE_DB_FIELDS constants', () => {
        it('should have all required field names', () => {
            expect(SUBTITLE_DB_FIELDS.PROCESSING_STATUS).to.equal('subtitleProcessingStatus');
            expect(SUBTITLE_DB_FIELDS.TRANSCRIPTION_JOB_ID).to.equal('subtitleTranscriptionJobId');
            expect(SUBTITLE_DB_FIELDS.TRANSLATION_STATUS).to.equal('subtitleTranslationStatus');
            expect(SUBTITLE_DB_FIELDS.WEBVTT_STATUS).to.equal('subtitleWebvttStatus');
            expect(SUBTITLE_DB_FIELDS.FINAL_SUBTITLE_FILES).to.equal('subtitleFinalFiles');
            expect(SUBTITLE_DB_FIELDS.ERROR_DETAILS).to.equal('subtitleErrorDetails');
        });
    });
});
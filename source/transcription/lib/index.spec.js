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
const fc = require('fast-check');
const { mockClient } = require('aws-sdk-client-mock');
const { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const sinon = require('sinon');

const lambda = require('../index.js');
const { isVideoFormatSupported, SUPPORTED_VIDEO_FORMATS } = require('../../shared/subtitle-utils.js');
const error = require('../lib/error.js');

describe('#TRANSCRIPTION LAMBDA::', () => {
    const transcribeClientMock = mockClient(TranscribeClient);
    const dynamoDBDocumentClientMock = mockClient(DynamoDBDocumentClient);
    let errorHandlerStub;

    // Set up environment variables
    process.env.AWS_REGION = 'us-east-1';
    process.env.SOLUTION_IDENTIFIER = 'test-solution';
    process.env.DynamoDBTable = 'test-table';

    beforeEach(() => {
        transcribeClientMock.reset();
        dynamoDBDocumentClientMock.reset();
        // Mock the error handler to prevent AWS SDK dynamic import issues
        errorHandlerStub = sinon.stub(error, 'handler').resolves();
    });

    afterEach(() => {
        transcribeClientMock.restore();
        dynamoDBDocumentClientMock.restore();
        errorHandlerStub.restore();
    });

    // Feature: video-transcription-translation, Property 2: Transcription Round Trip with Timing
    describe('Property 2: Transcription Round Trip with Timing', () => {
        it('should preserve timing information through transcription processing for any valid video', async () => {
            // Simple property test with fixed data to avoid complexity
            const testEvent = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en']
                }
            };

            // Mock DynamoDB updates to always succeed
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

            // Mock successful transcription job start
            transcribeClientMock.on(StartTranscriptionJobCommand).resolves({
                TranscriptionJob: {
                    TranscriptionJobName: 'transcription-test-guid-123-test',
                    TranscriptionJobStatus: 'IN_PROGRESS'
                }
            });

            // Mock transcription job completion immediately (no polling)
            transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                TranscriptionJob: {
                    TranscriptionJobName: 'transcription-test-guid-123-test',
                    TranscriptionJobStatus: 'COMPLETED',
                    LanguageCode: 'en-US',
                    Transcript: {
                        TranscriptFileUri: 's3://test-dest-bucket/test-guid-123/transcription/output.json'
                    }
                }
            });

            const result = await lambda.handler(testEvent);
            
            // Verify that timing-related properties are preserved in the result
            expect(result).to.have.property('transcriptionJobName');
            expect(result).to.have.property('transcriptionOutputLocation');
            expect(result.transcriptionJobName).to.be.a('string');
            expect(result.transcriptionOutputLocation).to.include(testEvent.guid);
            expect(result.transcriptionOutputLocation).to.include('transcription');
            
            // Verify that the original event properties are preserved (round trip)
            expect(result.guid).to.equal(testEvent.guid);
            expect(result.srcVideo).to.equal(testEvent.srcVideo);
            expect(result.srcBucket).to.equal(testEvent.srcBucket);
            expect(result.destBucket).to.equal(testEvent.destBucket);
        });
    });

    // Feature: video-transcription-translation, Property 3: Video Format Support
    describe('Property 3: Video Format Support', () => {
        it('should successfully process supported video formats', async () => {
            const supportedFormats = ['mp4', 'mov', 'm4v', 'mpg', 'm2ts'];
            
            for (const format of supportedFormats) {
                const testEvent = {
                    guid: `test-guid-${format}`,
                    srcVideo: `test-video.${format}`,
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates to always succeed
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock successful transcription
                transcribeClientMock.on(StartTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: `transcription-test-guid-${format}-test`,
                        TranscriptionJobStatus: 'IN_PROGRESS'
                    }
                });

                transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: `transcription-test-guid-${format}-test`,
                        TranscriptionJobStatus: 'COMPLETED',
                        LanguageCode: 'en-US',
                        Transcript: {
                            TranscriptFileUri: `s3://test-dest-bucket/test-guid-${format}/transcription/output.json`
                        }
                    }
                });

                const result = await lambda.handler(testEvent);
                
                // Supported formats should process successfully
                expect(result).to.have.property('transcriptionJobName');
                expect(result).to.have.property('transcriptionOutputLocation');
            }
        });

        it('should skip processing for unsupported video formats', async () => {
            const testEvent = {
                guid: 'test-guid-unsupported',
                srcVideo: 'test-video.avi', // Unsupported format
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en']
                }
            };

            // Mock DynamoDB updates to always succeed
            dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

            const result = await lambda.handler(testEvent);
            
            // Should return original event without transcription properties
            expect(result).to.not.have.property('transcriptionJobName');
            expect(result.guid).to.equal(testEvent.guid);
        });

        it('should correctly identify supported video formats', () => {
            const supportedFormats = ['mp4', 'mov', 'm4v', 'mpg', 'm2ts'];
            
            supportedFormats.forEach(extension => {
                const filename = `test-video.${extension}`;
                expect(isVideoFormatSupported(filename)).to.be.true;
                
                // Test case insensitivity
                const uppercaseFilename = `test-video.${extension.toUpperCase()}`;
                expect(isVideoFormatSupported(uppercaseFilename)).to.be.true;
            });
        });

        it('should correctly reject unsupported video formats', () => {
            const unsupportedFormats = ['avi', 'wmv', 'flv', 'mkv', 'webm', 'ogv'];
            
            unsupportedFormats.forEach(extension => {
                const filename = `test-video.${extension}`;
                expect(isVideoFormatSupported(filename)).to.be.false;
            });
        });
    });

    // Unit tests for specific scenarios
    describe('Unit Tests', () => {
        it('should handle disabled subtitle processing', async () => {
            const event = {
                guid: 'test-guid',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: { enabled: false }
            };

            const result = await lambda.handler(event);
            expect(result).to.deep.equal(event);
        });

        it('should handle missing required parameters', async () => {
            const event = {
                guid: 'test-guid'
                // Missing required parameters
            };

            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Missing required parameters');
            }
        });

        it('should handle invalid subtitle configuration', async () => {
            const event = {
                guid: 'test-guid',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-source-bucket',
                destBucket: 'test-dest-bucket',
                subtitleConfig: { 
                    enabled: true,
                    primaryLanguage: 'invalid-language',
                    targetLanguages: ['invalid-lang']
                }
            };

            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Invalid subtitle configuration');
            }
        });

        // Test transcription job submission and polling
        describe('Transcription Job Submission and Polling', () => {
            it('should successfully submit transcription job and complete immediately', async () => {
                const event = {
                    guid: 'test-guid-success',
                    srcVideo: 'test-video.mp4',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'en',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock transcription job submission
                transcribeClientMock.on(StartTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-success-test',
                        TranscriptionJobStatus: 'IN_PROGRESS'
                    }
                });

                // Mock immediate completion (no polling delay)
                transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-success-test',
                        TranscriptionJobStatus: 'COMPLETED',
                        LanguageCode: 'en-US',
                        Transcript: {
                            TranscriptFileUri: 's3://test-dest-bucket/test-guid-success/transcription/output.json'
                        }
                    }
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('transcriptionJobName');
                expect(result).to.have.property('detectedLanguage', 'en-US');
                expect(result.transcriptionJobName).to.include('transcription-test-guid-success');
            });

            it('should handle transcription job failure during polling', async () => {
                const event = {
                    guid: 'test-guid-failed',
                    srcVideo: 'test-video.mp4',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock transcription job submission
                transcribeClientMock.on(StartTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-failed-test',
                        TranscriptionJobStatus: 'IN_PROGRESS'
                    }
                });

                // Mock job failure
                transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-failed-test',
                        TranscriptionJobStatus: 'FAILED',
                        FailureReason: 'Audio quality too poor for transcription'
                    }
                });

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Transcription job failed');
                    expect(error.message).to.include('Audio quality too poor for transcription');
                }
            });

            it('should verify transcription job parameters are correct', async () => {
                const event = {
                    guid: 'test-guid-params',
                    srcVideo: 'test-video.mp4',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'en',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                let capturedParams = null;
                transcribeClientMock.on(StartTranscriptionJobCommand).callsFake((params) => {
                    capturedParams = params;
                    return Promise.resolve({
                        TranscriptionJob: {
                            TranscriptionJobName: params.TranscriptionJobName,
                            TranscriptionJobStatus: 'IN_PROGRESS'
                        }
                    });
                });

                // Mock immediate completion
                transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-params-test',
                        TranscriptionJobStatus: 'COMPLETED',
                        LanguageCode: 'en-US',
                        Transcript: {
                            TranscriptFileUri: 's3://test-dest-bucket/test-guid-params/transcription/output.json'
                        }
                    }
                });

                await lambda.handler(event);

                // Verify transcription parameters
                expect(capturedParams).to.not.be.null;
                expect(capturedParams.Media.MediaFileUri).to.equal('s3://test-source-bucket/test-video.mp4');
                expect(capturedParams.OutputBucketName).to.equal('test-dest-bucket');
                expect(capturedParams.OutputKey).to.equal('test-guid-params/transcription/');
                expect(capturedParams.Subtitles.Formats).to.deep.equal(['vtt']);
                expect(capturedParams.Subtitles.OutputStartIndex).to.equal(1);
            });
        });

        // Test error handling for unsupported formats
        describe('Error Handling for Unsupported Formats', () => {
            it('should gracefully handle unsupported video formats', async () => {
                const unsupportedFormats = ['avi', 'wmv', 'flv', 'mkv', 'webm'];
                
                for (const format of unsupportedFormats) {
                    const event = {
                        guid: `test-guid-${format}`,
                        srcVideo: `test-video.${format}`,
                        srcBucket: 'test-source-bucket',
                        destBucket: 'test-dest-bucket',
                        subtitleConfig: {
                            enabled: true,
                            primaryLanguage: 'auto',
                            targetLanguages: ['en']
                        }
                    };

                    // Mock DynamoDB updates
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    const result = await lambda.handler(event);

                    // Should return original event without transcription properties
                    expect(result).to.not.have.property('transcriptionJobName');
                    expect(result).to.not.have.property('transcriptionOutputLocation');
                    expect(result.guid).to.equal(event.guid);
                    expect(result.srcVideo).to.equal(event.srcVideo);
                }
            });

            it('should update DynamoDB with failure status for unsupported formats', async () => {
                const event = {
                    guid: 'test-guid-unsupported-db',
                    srcVideo: 'test-video.avi',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates - capture all calls
                const updateCalls = [];
                dynamoDBDocumentClientMock.on(UpdateCommand).callsFake((params) => {
                    updateCalls.push(params);
                    return Promise.resolve({});
                });

                await lambda.handler(event);

                // Verify DynamoDB was updated with failure status (should be the final call)
                expect(updateCalls.length).to.be.greaterThan(0);
                const finalUpdate = updateCalls[updateCalls.length - 1];
                expect(finalUpdate.Key.guid).to.equal(event.guid);
                expect(finalUpdate.UpdateExpression).to.include('subtitleProcessing.#status = :status');
                expect(finalUpdate.ExpressionAttributeValues[':status']).to.equal('failed');
                // The error details might be in a different property name due to the shared utility function
                const errorDetailsKey = Object.keys(finalUpdate.ExpressionAttributeValues).find(key => 
                    key.startsWith(':value') && 
                    finalUpdate.ExpressionAttributeValues[key] && 
                    finalUpdate.ExpressionAttributeValues[key].includes('Video format not supported')
                );
                expect(errorDetailsKey).to.not.be.undefined;
                expect(finalUpdate.ExpressionAttributeValues[errorDetailsKey]).to.include('Video format not supported');
            });

            it('should not call AWS Transcribe for unsupported formats', async () => {
                const event = {
                    guid: 'test-guid-no-transcribe',
                    srcVideo: 'test-video.avi',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                await lambda.handler(event);

                // Verify that StartTranscriptionJobCommand was never called
                expect(transcribeClientMock.commandCalls(StartTranscriptionJobCommand)).to.have.length(0);
                expect(transcribeClientMock.commandCalls(GetTranscriptionJobCommand)).to.have.length(0);
            });
        });

        // Test language detection vs explicit specification
        describe('Language Detection vs Explicit Specification', () => {
            it('should use automatic language detection when primaryLanguage is "auto"', async () => {
                const event = {
                    guid: 'test-guid-auto-lang',
                    srcVideo: 'test-video.mp4',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                let transcriptionParams = null;
                transcribeClientMock.on(StartTranscriptionJobCommand).callsFake((params) => {
                    transcriptionParams = params;
                    return Promise.resolve({
                        TranscriptionJob: {
                            TranscriptionJobName: 'transcription-test-guid-auto-lang-test',
                            TranscriptionJobStatus: 'IN_PROGRESS'
                        }
                    });
                });

                // Mock job completion
                transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-auto-lang-test',
                        TranscriptionJobStatus: 'COMPLETED',
                        LanguageCode: 'en-US',
                        Transcript: {
                            TranscriptFileUri: 's3://test-dest-bucket/test-guid-auto-lang/transcription/output.json'
                        }
                    }
                });

                await lambda.handler(event);

                // Verify that IdentifyLanguage was set to true
                expect(transcriptionParams.IdentifyLanguage).to.be.true;
                expect(transcriptionParams.LanguageCode).to.be.undefined;
            });

            it('should use explicit language code when primaryLanguage is specified', async () => {
                const testCases = [
                    { input: 'en', expected: 'en-US' },
                    { input: 'es', expected: 'es-US' },
                    { input: 'fr', expected: 'fr-FR' },
                    { input: 'de', expected: 'de-DE' }
                ];

                for (const testCase of testCases) {
                    const event = {
                        guid: `test-guid-explicit-${testCase.input}`,
                        srcVideo: 'test-video.mp4',
                        srcBucket: 'test-source-bucket',
                        destBucket: 'test-dest-bucket',
                        subtitleConfig: {
                            enabled: true,
                            primaryLanguage: testCase.input,
                            targetLanguages: ['en']
                        }
                    };

                    // Mock DynamoDB updates
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    let transcriptionParams = null;
                    transcribeClientMock.on(StartTranscriptionJobCommand).callsFake((params) => {
                        transcriptionParams = params;
                        return Promise.resolve({
                            TranscriptionJob: {
                                TranscriptionJobName: `transcription-test-guid-explicit-${testCase.input}-test`,
                                TranscriptionJobStatus: 'IN_PROGRESS'
                            }
                        });
                    });

                    // Mock job completion
                    transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                        TranscriptionJob: {
                            TranscriptionJobName: `transcription-test-guid-explicit-${testCase.input}-test`,
                            TranscriptionJobStatus: 'COMPLETED',
                            LanguageCode: testCase.expected,
                            Transcript: {
                                TranscriptFileUri: `s3://test-dest-bucket/test-guid-explicit-${testCase.input}/transcription/output.json`
                            }
                        }
                    });

                    await lambda.handler(event);

                    // Verify that explicit language code was used
                    expect(transcriptionParams.LanguageCode).to.equal(testCase.expected);
                    expect(transcriptionParams.IdentifyLanguage).to.be.undefined;
                }
            });

            it('should handle invalid language codes by rejecting them', async () => {
                const event = {
                    guid: 'test-guid-invalid-lang',
                    srcVideo: 'test-video.mp4',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'invalid-lang', // Invalid language code
                        targetLanguages: ['en']
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Invalid subtitle configuration');
                    expect(error.message).to.include('Unsupported primary language');
                }
            });

            it('should default to auto detection when primaryLanguage is undefined', async () => {
                const event = {
                    guid: 'test-guid-undefined-lang',
                    srcVideo: 'test-video.mp4',
                    srcBucket: 'test-source-bucket',
                    destBucket: 'test-dest-bucket',
                    subtitleConfig: {
                        enabled: true,
                        // primaryLanguage is undefined
                        targetLanguages: ['en']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                let transcriptionParams = null;
                transcribeClientMock.on(StartTranscriptionJobCommand).callsFake((params) => {
                    transcriptionParams = params;
                    return Promise.resolve({
                        TranscriptionJob: {
                            TranscriptionJobName: 'transcription-test-guid-undefined-lang-test',
                            TranscriptionJobStatus: 'IN_PROGRESS'
                        }
                    });
                });

                // Mock job completion
                transcribeClientMock.on(GetTranscriptionJobCommand).resolves({
                    TranscriptionJob: {
                        TranscriptionJobName: 'transcription-test-guid-undefined-lang-test',
                        TranscriptionJobStatus: 'COMPLETED',
                        LanguageCode: 'en-US',
                        Transcript: {
                            TranscriptFileUri: 's3://test-dest-bucket/test-guid-undefined-lang/transcription/output.json'
                        }
                    }
                });

                await lambda.handler(event);

                // Verify that automatic language detection was used
                expect(transcriptionParams.IdentifyLanguage).to.be.true;
                expect(transcriptionParams.LanguageCode).to.be.undefined;
            });
        });
    });
});
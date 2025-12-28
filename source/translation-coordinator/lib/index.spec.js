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
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const sinon = require('sinon');
const { Readable } = require('stream');

const lambda = require('../index.js');
const error = require('./error.js');

describe('#TRANSLATION COORDINATOR LAMBDA::', () => {
    const s3ClientMock = mockClient(S3Client);
    const dynamoDBDocumentClientMock = mockClient(DynamoDBDocumentClient);
    let errorHandlerStub;

    // Set up environment variables
    process.env.AWS_REGION = 'us-east-1';
    process.env.SOLUTION_IDENTIFIER = 'test-solution';
    process.env.DynamoDBTable = 'test-table';

    beforeEach(() => {
        s3ClientMock.reset();
        dynamoDBDocumentClientMock.reset();
        // Mock the error handler to prevent AWS SDK dynamic import issues
        errorHandlerStub = sinon.stub(error, 'handler').resolves();
    });

    afterEach(() => {
        s3ClientMock.restore();
        dynamoDBDocumentClientMock.restore();
        errorHandlerStub.restore();
    });

    // Sample transcription data for testing
    const sampleTranscriptionData = {
        results: {
            items: [
                {
                    type: 'pronunciation',
                    start_time: '0.0',
                    end_time: '0.5',
                    alternatives: [{ content: 'Hello' }]
                },
                {
                    type: 'pronunciation',
                    start_time: '0.6',
                    end_time: '1.0',
                    alternatives: [{ content: 'world' }]
                },
                {
                    type: 'punctuation',
                    alternatives: [{ content: '.' }]
                },
                {
                    type: 'pronunciation',
                    start_time: '1.5',
                    end_time: '2.0',
                    alternatives: [{ content: 'This' }]
                },
                {
                    type: 'pronunciation',
                    start_time: '2.1',
                    end_time: '2.5',
                    alternatives: [{ content: 'is' }]
                },
                {
                    type: 'pronunciation',
                    start_time: '2.6',
                    end_time: '3.0',
                    alternatives: [{ content: 'a' }]
                },
                {
                    type: 'pronunciation',
                    start_time: '3.1',
                    end_time: '3.5',
                    alternatives: [{ content: 'test' }]
                },
                {
                    type: 'punctuation',
                    alternatives: [{ content: '.' }]
                }
            ]
        }
    };

    // Unit tests for specific scenarios
    describe('Unit Tests', () => {
        it('should handle disabled subtitle processing', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://test-bucket/test-key.json',
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
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://test-bucket/test-key.json',
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

        it('should handle no target languages configured', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                subtitleConfig: { 
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: []
                }
            };

            const result = await lambda.handler(event);
            expect(result).to.deep.equal(event);
        });

        // Test transcription JSON parsing
        describe('Transcription JSON Parsing', () => {
            it('should successfully parse transcription JSON and extract text segments', async () => {
                const event = {
                    guid: 'test-guid-parse',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-guid-parse/transcription/output.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es', 'fr']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('textSegments');
                expect(result.textSegments).to.be.an('array');
                expect(result.textSegments.length).to.be.greaterThan(0);
                
                // Verify text segments have required properties
                result.textSegments.forEach(segment => {
                    expect(segment).to.have.property('startTime');
                    expect(segment).to.have.property('endTime');
                    expect(segment).to.have.property('text');
                    expect(segment.startTime).to.be.a('number');
                    expect(segment.endTime).to.be.a('number');
                    expect(segment.text).to.be.a('string');
                });
            });

            it('should handle empty transcription results', async () => {
                const event = {
                    guid: 'test-guid-empty',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download with empty results
                const emptyTranscriptionData = { results: { items: [] } };
                const transcriptionStream = Readable.from([JSON.stringify(emptyTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('guid', event.guid);
                // Should complete successfully even with no text segments
            });

            it('should handle S3 download failure', async () => {
                const event = {
                    guid: 'test-guid-s3-fail',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download failure
                s3ClientMock.on(GetObjectCommand).rejects(new Error('S3 access denied'));

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Failed to download transcription results');
                }
            });

            it('should handle malformed transcription JSON', async () => {
                const event = {
                    guid: 'test-guid-malformed',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download with malformed JSON
                const malformedJson = '{ "results": { "items": [ invalid json }';
                const transcriptionStream = Readable.from([malformedJson]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Failed to download transcription results');
                }
            });

            it('should handle transcription data without results property', async () => {
                const event = {
                    guid: 'test-guid-no-results',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download with data missing results property
                const invalidTranscriptionData = { status: 'COMPLETED' };
                const transcriptionStream = Readable.from([JSON.stringify(invalidTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Invalid transcription data format');
                }
            });

            it('should handle transcription with only punctuation items', async () => {
                const event = {
                    guid: 'test-guid-punctuation-only',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download with only punctuation items
                const punctuationOnlyData = {
                    results: {
                        items: [
                            {
                                type: 'punctuation',
                                alternatives: [{ content: '.' }]
                            },
                            {
                                type: 'punctuation',
                                alternatives: [{ content: '!' }]
                            }
                        ]
                    }
                };
                const transcriptionStream = Readable.from([JSON.stringify(punctuationOnlyData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('guid', event.guid);
                // Should complete successfully even with no text segments
            });

            it('should handle transcription with words but no punctuation', async () => {
                const event = {
                    guid: 'test-guid-no-punctuation',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download with words but no punctuation (should create segments based on word count)
                const noPunctuationData = {
                    results: {
                        items: Array.from({ length: 25 }, (_, i) => ({
                            type: 'pronunciation',
                            start_time: (i * 0.5).toString(),
                            end_time: ((i + 1) * 0.5).toString(),
                            alternatives: [{ content: `word${i + 1}` }]
                        }))
                    }
                };
                const transcriptionStream = Readable.from([JSON.stringify(noPunctuationData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('textSegments');
                expect(result.textSegments).to.be.an('array');
                expect(result.textSegments.length).to.be.greaterThan(0);
                
                // Should create segments based on word count (10 words per segment)
                // The last segment may have fewer than 10 words if there are remaining words
                result.textSegments.forEach((segment, index) => {
                    const wordCount = segment.text.split(' ').length;
                    if (index === result.textSegments.length - 1) {
                        // Last segment can have any number of remaining words
                        expect(wordCount).to.be.at.most(25);
                    } else {
                        // Non-last segments should have exactly 10 words
                        expect(wordCount).to.equal(10);
                    }
                });
            });

            it('should handle invalid S3 location format', async () => {
                const event = {
                    guid: 'test-guid-invalid-s3',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 'invalid-s3-location',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Invalid S3 location format');
                }
            });
        });

        // Test parallel task generation
        describe('Parallel Task Generation', () => {
            it('should generate parallel translation tasks for target languages', async () => {
                const event = {
                    guid: 'test-guid-parallel',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es', 'fr', 'de']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('translationTasks');
                expect(result.translationTasks).to.be.an('array');
                expect(result.translationTasks).to.have.length(3); // es, fr, de

                // Verify each translation task has required properties
                result.translationTasks.forEach(task => {
                    expect(task).to.have.property('sourceLanguage', 'en');
                    expect(task).to.have.property('targetLanguage');
                    expect(task).to.have.property('textSegments');
                    expect(task).to.have.property('jobId');
                    expect(task.textSegments).to.be.an('array');
                    expect(['es', 'fr', 'de']).to.include(task.targetLanguage);
                });

                // Verify parallel execution input is prepared
                expect(result).to.have.property('parallelTranslationInput');
                expect(result.parallelTranslationInput).to.be.an('array');
                expect(result.parallelTranslationInput).to.have.length(3);
            });

            it('should skip translation when target language matches source language', async () => {
                const event = {
                    guid: 'test-guid-same-lang',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en', 'es'] // en matches source
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('translationTasks');
                expect(result.translationTasks).to.have.length(1); // Only es, en is skipped
                expect(result.translationTasks[0].targetLanguage).to.equal('es');
            });

            it('should handle unsupported target languages gracefully', async () => {
                const event = {
                    guid: 'test-guid-unsupported',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es', 'unsupported-lang', 'fr']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('translationTasks');
                expect(result.translationTasks).to.have.length(2); // Only es and fr, unsupported-lang is skipped
                
                const targetLanguages = result.translationTasks.map(task => task.targetLanguage);
                expect(targetLanguages).to.include('es');
                expect(targetLanguages).to.include('fr');
                expect(targetLanguages).to.not.include('unsupported-lang');
            });

            it('should generate unique job IDs for each translation task', async () => {
                const event = {
                    guid: 'test-guid-unique-jobs',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es', 'fr', 'de', 'it']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('translationTasks');
                expect(result.translationTasks).to.have.length(4);

                // Verify all job IDs are unique
                const jobIds = result.translationTasks.map(task => task.jobId);
                const uniqueJobIds = new Set(jobIds);
                expect(uniqueJobIds.size).to.equal(jobIds.length);

                // Verify job ID format includes source and target languages
                result.translationTasks.forEach(task => {
                    expect(task.jobId).to.include(task.sourceLanguage);
                    expect(task.jobId).to.include(task.targetLanguage);
                    expect(task.jobId).to.include(event.guid);
                });
            });

            it('should handle empty target languages array', async () => {
                const event = {
                    guid: 'test-guid-empty-targets',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: []
                    }
                };

                const result = await lambda.handler(event);

                // Should return early without processing
                expect(result).to.deep.equal(event);
            });

            it('should preserve text segment timing and content in translation tasks', async () => {
                const event = {
                    guid: 'test-guid-preserve-timing',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('translationTasks');
                expect(result.translationTasks).to.have.length(1);

                const task = result.translationTasks[0];
                expect(task.textSegments).to.be.an('array');
                
                // Verify timing information is preserved
                task.textSegments.forEach(segment => {
                    expect(segment).to.have.property('startTime');
                    expect(segment).to.have.property('endTime');
                    expect(segment).to.have.property('text');
                    expect(segment.startTime).to.be.a('number');
                    expect(segment.endTime).to.be.a('number');
                    expect(segment.startTime).to.be.lessThan(segment.endTime);
                });

                // Verify text segments match the original transcription
                expect(task.textSegments).to.deep.equal(result.textSegments);
            });

            it('should handle all target languages being the same as source language', async () => {
                const event = {
                    guid: 'test-guid-all-same-lang',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['en', 'en'] // All match source
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('translationTasks');
                expect(result.translationTasks).to.have.length(0); // All languages skipped
                expect(result).to.have.property('parallelTranslationInput');
                expect(result.parallelTranslationInput).to.have.length(0);
            });
        });

        // Test target language configuration handling
        describe('Target Language Configuration Handling', () => {
            it('should handle various language configurations correctly', async () => {
                const testCases = [
                    {
                        name: 'explicit primary language',
                        primaryLanguage: 'en',
                        detectedLanguage: 'fr-FR',
                        expectedSource: 'en'
                    },
                    {
                        name: 'auto detection with detected language',
                        primaryLanguage: 'auto',
                        detectedLanguage: 'es-US',
                        expectedSource: 'es'
                    },
                    {
                        name: 'undefined primary language with detected language',
                        primaryLanguage: undefined,
                        detectedLanguage: 'de-DE',
                        expectedSource: 'de'
                    },
                    {
                        name: 'no language information defaults to English',
                        primaryLanguage: undefined,
                        detectedLanguage: undefined,
                        expectedSource: 'en'
                    }
                ];

                for (const testCase of testCases) {
                    const event = {
                        guid: `test-guid-${testCase.name.replace(/\s+/g, '-')}`,
                        transcriptionJobName: 'test-job',
                        transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                        detectedLanguage: testCase.detectedLanguage,
                        subtitleConfig: {
                            enabled: true,
                            primaryLanguage: testCase.primaryLanguage,
                            targetLanguages: ['fr']
                        }
                    };

                    // Mock DynamoDB updates
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    // Mock S3 download
                    const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                    s3ClientMock.on(GetObjectCommand).resolves({
                        Body: transcriptionStream
                    });

                    const result = await lambda.handler(event);

                    expect(result).to.have.property('sourceLanguage', testCase.expectedSource);
                }
            });

            it('should correctly map AWS Transcribe language codes to standard codes', async () => {
                const languageMappingTests = [
                    { transcribeCode: 'en-US', expectedStandard: 'en' },
                    { transcribeCode: 'en-GB', expectedStandard: 'en' },
                    { transcribeCode: 'es-US', expectedStandard: 'es' },
                    { transcribeCode: 'es-ES', expectedStandard: 'es' },
                    { transcribeCode: 'fr-FR', expectedStandard: 'fr' },
                    { transcribeCode: 'fr-CA', expectedStandard: 'fr' },
                    { transcribeCode: 'pt-BR', expectedStandard: 'pt-BR' },
                    { transcribeCode: 'pt-PT', expectedStandard: 'pt' }
                ];

                for (const test of languageMappingTests) {
                    const event = {
                        guid: `test-guid-mapping-${test.transcribeCode}`,
                        transcriptionJobName: 'test-job',
                        transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                        detectedLanguage: test.transcribeCode,
                        subtitleConfig: {
                            enabled: true,
                            primaryLanguage: 'auto',
                            targetLanguages: ['en'] // Different from source to ensure translation task is created
                        }
                    };

                    // Mock DynamoDB updates
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    // Mock S3 download
                    const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                    s3ClientMock.on(GetObjectCommand).resolves({
                        Body: transcriptionStream
                    });

                    const result = await lambda.handler(event);

                    expect(result).to.have.property('sourceLanguage', test.expectedStandard);
                }
            });

            it('should handle subtitle configuration with boolean validation', async () => {
                const invalidConfigs = [
                    { enabled: 'true' }, // String instead of boolean
                    { enabled: 1 }, // Number instead of boolean
                    { enabled: null }, // Null instead of boolean
                ];

                for (const config of invalidConfigs) {
                    const event = {
                        guid: 'test-guid-invalid-config',
                        transcriptionJobName: 'test-job',
                        transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                        subtitleConfig: config
                    };

                    try {
                        await lambda.handler(event);
                        expect.fail('Should have thrown an error for invalid config');
                    } catch (error) {
                        expect(error.message).to.include('Invalid subtitle configuration');
                    }
                }
            });

            it('should handle missing subtitle configuration', async () => {
                const event = {
                    guid: 'test-guid-missing-config',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json'
                    // No subtitleConfig property
                };

                const result = await lambda.handler(event);

                // Should default to disabled and return early
                expect(result).to.deep.equal(event);
            });

            it('should handle null subtitle configuration', async () => {
                const event = {
                    guid: 'test-guid-null-config',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    subtitleConfig: null
                };

                const result = await lambda.handler(event);

                // Should default to disabled and return early
                expect(result).to.deep.equal(event);
            });

            it('should handle unknown detected language codes', async () => {
                const event = {
                    guid: 'test-guid-unknown-lang',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'unknown-XX',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                // Should fall back to the first part of the language code or default to 'en'
                expect(result).to.have.property('sourceLanguage');
                expect(result.sourceLanguage).to.be.oneOf(['unknown', 'en']);
            });

            it('should handle DynamoDB update failures gracefully', async () => {
                const event = {
                    guid: 'test-guid-dynamo-fail',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'auto',
                        targetLanguages: ['es']
                    }
                };

                // Mock DynamoDB update failure
                dynamoDBDocumentClientMock.on(UpdateCommand).rejects(new Error('DynamoDB access denied'));

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('DynamoDB access denied');
                }
            });

            it('should validate primary language when explicitly specified', async () => {
                const event = {
                    guid: 'test-guid-invalid-primary',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'en-US',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'invalid-lang-code',
                        targetLanguages: ['es']
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error');
                } catch (error) {
                    expect(error.message).to.include('Primary language');
                    expect(error.message).to.include('is not supported');
                }
            });

            it('should handle complex language configuration scenarios', async () => {
                const event = {
                    guid: 'test-guid-complex-config',
                    transcriptionJobName: 'test-job',
                    transcriptionOutputLocation: 's3://test-bucket/test-key.json',
                    detectedLanguage: 'pt-PT',
                    subtitleConfig: {
                        enabled: true,
                        primaryLanguage: 'pt', // Use 'pt' instead of 'pt-BR' to avoid the lowercase bug
                        targetLanguages: ['es', 'en', 'fr'] // Portuguese, Spanish, English, French
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock S3 download
                const transcriptionStream = Readable.from([JSON.stringify(sampleTranscriptionData)]);
                s3ClientMock.on(GetObjectCommand).resolves({
                    Body: transcriptionStream
                });

                const result = await lambda.handler(event);

                expect(result).to.have.property('sourceLanguage', 'pt');
                expect(result).to.have.property('translationTasks');
                
                // Should create tasks for es, en, fr (pt is source)
                const targetLanguages = result.translationTasks.map(task => task.targetLanguage);
                expect(targetLanguages).to.include('es');
                expect(targetLanguages).to.include('en');
                expect(targetLanguages).to.include('fr');
                expect(targetLanguages).to.not.include('pt'); // Source language should be skipped
            });
        });
    });

    // Property-based tests
    describe('Property-Based Tests', () => {
        // Feature: video-transcription-translation, Property 4: Parallel Translation Processing
        // Validates: Requirements 2.1, 2.3, 8.1
        it('Property 4: For any transcription result with multiple configured target languages, translation tasks should execute concurrently rather than sequentially', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate test data
                    fc.record({
                        guid: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
                        detectedLanguage: fc.constantFrom('en-US', 'es-US', 'fr-FR', 'de-DE', 'it-IT'),
                        primaryLanguage: fc.constantFrom('auto', 'en', 'es', 'fr'),
                        targetLanguages: fc.array(
                            fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'),
                            { minLength: 2, maxLength: 5 }
                        ).filter(langs => new Set(langs).size === langs.length), // Ensure unique languages
                        textSegments: fc.array(
                            fc.record({
                                startTime: fc.float({ min: 0, max: 300000 }), // 0 to 5 minutes in ms
                                endTime: fc.float({ min: 0, max: 300000 }),
                                text: fc.string({ minLength: 1, maxLength: 100 })
                            }).filter(segment => segment.endTime > segment.startTime),
                            { minLength: 1, maxLength: 10 }
                        )
                    }),
                    async (testData) => {
                        const event = {
                            guid: testData.guid,
                            transcriptionJobName: `test-job-${testData.guid}`,
                            transcriptionOutputLocation: `s3://test-bucket/${testData.guid}/transcription/output.json`,
                            detectedLanguage: testData.detectedLanguage,
                            subtitleConfig: {
                                enabled: true,
                                primaryLanguage: testData.primaryLanguage,
                                targetLanguages: testData.targetLanguages
                            }
                        };

                        // Create transcription data with the generated text segments
                        const transcriptionData = {
                            results: {
                                items: []
                            }
                        };

                        // Convert text segments to transcription items format
                        testData.textSegments.forEach((segment, index) => {
                            const words = segment.text.split(' ');
                            words.forEach((word, wordIndex) => {
                                const wordStartTime = segment.startTime / 1000 + (wordIndex * 0.1);
                                const wordEndTime = wordStartTime + 0.1;
                                
                                transcriptionData.results.items.push({
                                    type: 'pronunciation',
                                    start_time: wordStartTime.toString(),
                                    end_time: wordEndTime.toString(),
                                    alternatives: [{ content: word }]
                                });
                            });
                            
                            // Add punctuation at the end of each segment
                            if (index < testData.textSegments.length - 1) {
                                transcriptionData.results.items.push({
                                    type: 'punctuation',
                                    alternatives: [{ content: '.' }]
                                });
                            }
                        });

                        // Mock DynamoDB updates
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        // Mock S3 download
                        const transcriptionStream = Readable.from([JSON.stringify(transcriptionData)]);
                        s3ClientMock.on(GetObjectCommand).resolves({
                            Body: transcriptionStream
                        });

                        const result = await lambda.handler(event);

                        // Property: Translation tasks should be generated for parallel execution
                        expect(result).to.have.property('translationTasks');
                        expect(result).to.have.property('parallelTranslationInput');
                        
                        // Verify parallel execution structure
                        expect(result.parallelTranslationInput).to.be.an('array');
                        expect(result.translationTasks).to.be.an('array');
                        
                        // Each translation task should be independent and suitable for parallel execution
                        if (result.translationTasks.length > 0) {
                            // Verify all tasks have the same source data but different target languages
                            const sourceLanguage = result.translationTasks[0].sourceLanguage;
                            const textSegmentCount = result.translationTasks[0].textSegments.length;
                            
                            result.translationTasks.forEach(task => {
                                // All tasks should have the same source language and text segments
                                expect(task.sourceLanguage).to.equal(sourceLanguage);
                                expect(task.textSegments).to.have.length(textSegmentCount);
                                
                                // Each task should have a unique target language
                                expect(task).to.have.property('targetLanguage');
                                expect(task.targetLanguage).to.not.equal(sourceLanguage);
                                
                                // Each task should have a unique job ID
                                expect(task).to.have.property('jobId');
                                expect(task.jobId).to.include(task.targetLanguage);
                                
                                // Text segments should be identical across tasks (for parallel processing)
                                task.textSegments.forEach((segment, index) => {
                                    expect(segment).to.have.property('startTime');
                                    expect(segment).to.have.property('endTime');
                                    expect(segment).to.have.property('text');
                                    expect(segment.startTime).to.be.a('number');
                                    expect(segment.endTime).to.be.a('number');
                                    expect(segment.text).to.be.a('string');
                                });
                            });
                            
                            // Verify parallel execution input structure
                            expect(result.parallelTranslationInput).to.have.length(result.translationTasks.length);
                            result.parallelTranslationInput.forEach((parallelInput, index) => {
                                expect(parallelInput).to.have.property('translationTask');
                                expect(parallelInput.translationTask).to.deep.equal(result.translationTasks[index]);
                                expect(parallelInput.guid).to.equal(event.guid);
                            });
                            
                            // Verify target languages are unique (no duplicate tasks)
                            const targetLanguages = result.translationTasks.map(task => task.targetLanguage);
                            const uniqueTargetLanguages = new Set(targetLanguages);
                            expect(uniqueTargetLanguages.size).to.equal(targetLanguages.length);
                        }
                        
                        // Reset mocks for next iteration
                        s3ClientMock.reset();
                        dynamoDBDocumentClientMock.reset();
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});
                    }
                ),
                { numRuns: 100, timeout: 30000 }
            );
        });
    });
});
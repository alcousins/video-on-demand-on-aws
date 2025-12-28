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
const { TranslateClient, TranslateTextCommand } = require('@aws-sdk/client-translate');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const sinon = require('sinon');

const lambda = require('../index.js');
const error = require('./error.js');

describe('#TRANSLATION WORKER LAMBDA::', () => {
    const translateClientMock = mockClient(TranslateClient);
    const dynamoDBDocumentClientMock = mockClient(DynamoDBDocumentClient);
    let errorHandlerStub;

    // Set up environment variables
    process.env.AWS_REGION = 'us-east-1';
    process.env.SOLUTION_IDENTIFIER = 'test-solution';
    process.env.DynamoDBTable = 'test-table';

    beforeEach(() => {
        translateClientMock.reset();
        dynamoDBDocumentClientMock.reset();
        // Mock the error handler to prevent AWS SDK dynamic import issues
        errorHandlerStub = sinon.stub(error, 'handler').resolves();
    });

    afterEach(() => {
        translateClientMock.restore();
        dynamoDBDocumentClientMock.restore();
        errorHandlerStub.restore();
    });

    // Unit Tests
    describe('Unit Tests', () => {
        describe('Translation with timing preservation', () => {
            it('should preserve timing information during translation', async () => {
                const event = {
                    guid: 'test-guid-123',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Hello world' },
                            { startTime: 4000, endTime: 6000, text: 'How are you?' },
                            { startTime: 7000, endTime: 9000, text: 'Goodbye' }
                        ],
                        jobId: 'translation-en-es-test-guid-123'
                    }
                };

                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock AWS Translate responses
                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Hello world',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                }).resolves({
                    TranslatedText: 'Hola mundo',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                translateClientMock.on(TranslateTextCommand, {
                    Text: 'How are you?',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                }).resolves({
                    TranslatedText: '¿Cómo estás?',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Goodbye',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                }).resolves({
                    TranslatedText: 'Adiós',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                const result = await lambda.handler(event);

                // Verify timing information is preserved
                expect(result.translatedSegments).to.have.length(3);
                
                expect(result.translatedSegments[0]).to.deep.include({
                    startTime: 1000,
                    endTime: 3000,
                    text: 'Hola mundo',
                    originalText: 'Hello world'
                });

                expect(result.translatedSegments[1]).to.deep.include({
                    startTime: 4000,
                    endTime: 6000,
                    text: '¿Cómo estás?',
                    originalText: 'How are you?'
                });

                expect(result.translatedSegments[2]).to.deep.include({
                    startTime: 7000,
                    endTime: 9000,
                    text: 'Adiós',
                    originalText: 'Goodbye'
                });

                // Verify translation result metadata
                expect(result.translationResult).to.deep.include({
                    sourceLanguage: 'en',
                    targetLanguage: 'es',
                    segmentCount: 3,
                    status: 'COMPLETED'
                });
            });

            it('should handle segments with precise timing boundaries', async () => {
                const event = {
                    guid: 'test-guid-timing',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'fr',
                        textSegments: [
                            { startTime: 0, endTime: 1, text: 'Start' },
                            { startTime: 1, endTime: 1.5, text: 'Middle' },
                            { startTime: 1.5, endTime: 2, text: 'End' }
                        ],
                        jobId: 'translation-timing-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});
                
                // Mock translations for precise timing test
                translateClientMock.on(TranslateTextCommand).resolves({
                    TranslatedText: 'Traduit',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'fr'
                });

                const result = await lambda.handler(event);

                // Verify precise timing preservation
                expect(result.translatedSegments[0]).to.include({ startTime: 0, endTime: 1 });
                expect(result.translatedSegments[1]).to.include({ startTime: 1, endTime: 1.5 });
                expect(result.translatedSegments[2]).to.include({ startTime: 1.5, endTime: 2 });
            });
        });

        describe('Error handling for unsupported languages', () => {
            it('should reject unsupported source language', async () => {
                const event = {
                    guid: 'test-guid-unsupported',
                    translationTask: {
                        sourceLanguage: 'unsupported-lang',
                        targetLanguage: 'en',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Test text' }
                        ],
                        jobId: 'translation-unsupported-test'
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for unsupported source language');
                } catch (err) {
                    expect(err.message).to.include('Unsupported source language: unsupported-lang');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should reject unsupported target language', async () => {
                const event = {
                    guid: 'test-guid-unsupported-target',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'unsupported-target',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Test text' }
                        ],
                        jobId: 'translation-unsupported-target-test'
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for unsupported target language');
                } catch (err) {
                    expect(err.message).to.include('Unsupported target language: unsupported-target');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should handle AWS Translate UnsupportedLanguagePairException', async () => {
                const event = {
                    guid: 'test-guid-pair-error',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Test text' }
                        ],
                        jobId: 'translation-pair-error-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock AWS Translate to throw UnsupportedLanguagePairException
                const unsupportedError = new Error('Unsupported language pair');
                unsupportedError.name = 'UnsupportedLanguagePairException';
                translateClientMock.on(TranslateTextCommand).rejects(unsupportedError);

                // The function should complete successfully but preserve original text for failed segments
                const result = await lambda.handler(event);

                // Should complete with status COMPLETED but with translation errors
                expect(result.translationResult.status).to.equal('COMPLETED');
                expect(result.translatedSegments).to.have.length(1);
                
                // Failed segment should preserve original text and include error
                expect(result.translatedSegments[0]).to.deep.include({
                    startTime: 1000,
                    endTime: 3000,
                    text: 'Test text', // Original text preserved
                    originalText: 'Test text'
                });
                expect(result.translatedSegments[0]).to.have.property('translationError');
                expect(result.translatedSegments[0].translationError).to.include('Unsupported language pair: en to es');
            });

            it('should handle individual segment translation failures gracefully', async () => {
                const event = {
                    guid: 'test-guid-partial-failure',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Success text' },
                            { startTime: 4000, endTime: 6000, text: 'Failure text' },
                            { startTime: 7000, endTime: 9000, text: 'Another success' }
                        ],
                        jobId: 'translation-partial-failure-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock successful translation for first and third segments
                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Success text',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                }).resolves({
                    TranslatedText: 'Texto exitoso',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Another success',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                }).resolves({
                    TranslatedText: 'Otro éxito',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                // Mock failure for second segment
                const translationError = new Error('Translation service error');
                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Failure text',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                }).rejects(translationError);

                const result = await lambda.handler(event);

                // Should complete successfully with partial translations
                expect(result.translationResult.status).to.equal('COMPLETED');
                expect(result.translatedSegments).to.have.length(3);

                // First segment should be translated
                expect(result.translatedSegments[0]).to.deep.include({
                    startTime: 1000,
                    endTime: 3000,
                    text: 'Texto exitoso',
                    originalText: 'Success text'
                });

                // Second segment should preserve original text with error
                expect(result.translatedSegments[1]).to.deep.include({
                    startTime: 4000,
                    endTime: 6000,
                    text: 'Failure text', // Original text preserved
                    originalText: 'Failure text'
                });
                expect(result.translatedSegments[1]).to.have.property('translationError');

                // Third segment should be translated
                expect(result.translatedSegments[2]).to.deep.include({
                    startTime: 7000,
                    endTime: 9000,
                    text: 'Otro éxito',
                    originalText: 'Another success'
                });
            });
        });

        describe('Translation quality and character encoding', () => {
            it('should handle special characters and Unicode properly', async () => {
                const event = {
                    guid: 'test-guid-unicode',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'zh',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Hello! How are you? 😊' },
                            { startTime: 4000, endTime: 6000, text: 'Special chars: áéíóú ñ ç' },
                            { startTime: 7000, endTime: 9000, text: 'Numbers & symbols: 123 $%&' }
                        ],
                        jobId: 'translation-unicode-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock translations with Unicode characters
                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Hello! How are you? 😊',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'zh'
                }).resolves({
                    TranslatedText: '你好！你好吗？😊',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'zh'
                });

                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Special chars: áéíóú ñ ç',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'zh'
                }).resolves({
                    TranslatedText: '特殊字符：áéíóú ñ ç',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'zh'
                });

                translateClientMock.on(TranslateTextCommand, {
                    Text: 'Numbers & symbols: 123 $%&',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'zh'
                }).resolves({
                    TranslatedText: '数字和符号：123 $%&',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'zh'
                });

                const result = await lambda.handler(event);

                // Verify Unicode characters are preserved
                expect(result.translatedSegments[0].text).to.equal('你好！你好吗？😊');
                expect(result.translatedSegments[1].text).to.equal('特殊字符：áéíóú ñ ç');
                expect(result.translatedSegments[2].text).to.equal('数字和符号：123 $%&');

                // Verify original text with special characters is preserved
                expect(result.translatedSegments[0].originalText).to.equal('Hello! How are you? 😊');
                expect(result.translatedSegments[1].originalText).to.equal('Special chars: áéíóú ñ ç');
                expect(result.translatedSegments[2].originalText).to.equal('Numbers & symbols: 123 $%&');
            });

            it('should handle empty and whitespace-only text segments validation', async () => {
                const event = {
                    guid: 'test-guid-empty',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: '   ' } // Whitespace only
                        ],
                        jobId: 'translation-empty-test'
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for whitespace-only text');
                } catch (err) {
                    expect(err.message).to.include('text cannot be empty or whitespace only');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should handle very long text segments', async () => {
                const longText = 'A'.repeat(5000); // 5000 character string
                const event = {
                    guid: 'test-guid-long-text',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 10000, text: longText }
                        ],
                        jobId: 'translation-long-text-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock AWS Translate to throw TextSizeLimitExceededException
                const sizeError = new Error('Text too long');
                sizeError.name = 'TextSizeLimitExceededException';
                translateClientMock.on(TranslateTextCommand).rejects(sizeError);

                // The function should complete successfully but preserve original text for failed segments
                const result = await lambda.handler(event);

                // Should complete with status COMPLETED but with translation errors
                expect(result.translationResult.status).to.equal('COMPLETED');
                expect(result.translatedSegments).to.have.length(1);
                
                // Failed segment should preserve original text and include error
                expect(result.translatedSegments[0]).to.deep.include({
                    startTime: 1000,
                    endTime: 10000,
                    text: longText, // Original text preserved
                    originalText: longText
                });
                expect(result.translatedSegments[0]).to.have.property('translationError');
                expect(result.translatedSegments[0].translationError).to.include('Text too long for translation: 5000 characters');
            });

            it('should skip translation when source and target languages are the same', async () => {
                const event = {
                    guid: 'test-guid-same-lang',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'en',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Same language text' }
                        ],
                        jobId: 'translation-same-lang-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Should complete without calling AWS Translate
                expect(result.translationResult.status).to.equal('COMPLETED');
                expect(result.translatedSegments[0]).to.deep.include({
                    startTime: 1000,
                    endTime: 3000,
                    text: 'Same language text', // Should be unchanged
                    originalText: 'Same language text'
                });

                // Verify AWS Translate was not called
                expect(translateClientMock.calls()).to.have.length(0);
            });

            it('should handle rate limiting errors with appropriate error messages', async () => {
                const event = {
                    guid: 'test-guid-rate-limit',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Rate limited text' }
                        ],
                        jobId: 'translation-rate-limit-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                // Mock AWS Translate to throw TooManyRequestsException
                const rateLimitError = new Error('Too many requests');
                rateLimitError.name = 'TooManyRequestsException';
                translateClientMock.on(TranslateTextCommand).rejects(rateLimitError);

                // The function should complete successfully but preserve original text for failed segments
                const result = await lambda.handler(event);

                // Should complete with status COMPLETED but with translation errors
                expect(result.translationResult.status).to.equal('COMPLETED');
                expect(result.translatedSegments).to.have.length(1);
                
                // Failed segment should preserve original text and include error
                expect(result.translatedSegments[0]).to.deep.include({
                    startTime: 1000,
                    endTime: 3000,
                    text: 'Rate limited text', // Original text preserved
                    originalText: 'Rate limited text'
                });
                expect(result.translatedSegments[0]).to.have.property('translationError');
                expect(result.translatedSegments[0].translationError).to.include('Translation rate limit exceeded, please retry later');
            });
        });

        describe('Input validation', () => {
            it('should reject missing translationTask', async () => {
                const event = {
                    guid: 'test-guid-missing-task'
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for missing translationTask');
                } catch (err) {
                    expect(err.message).to.include('Missing required parameter: translationTask');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should reject invalid text segment timing', async () => {
                const event = {
                    guid: 'test-guid-invalid-timing',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 5000, endTime: 3000, text: 'Invalid timing' } // endTime < startTime
                        ],
                        jobId: 'translation-invalid-timing-test'
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for invalid timing');
                } catch (err) {
                    expect(err.message).to.include('startTime must be less than endTime');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should reject empty textSegments array', async () => {
                const event = {
                    guid: 'test-guid-empty-segments',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [],
                        jobId: 'translation-empty-segments-test'
                    }
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for empty textSegments');
                } catch (err) {
                    expect(err.message).to.include('textSegments array cannot be empty');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });
        });

        describe('DynamoDB integration', () => {
            it('should update DynamoDB with translation status', async () => {
                const event = {
                    guid: 'test-guid-dynamo',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Test text' }
                        ],
                        jobId: 'translation-dynamo-test'
                    }
                };

                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});
                translateClientMock.on(TranslateTextCommand).resolves({
                    TranslatedText: 'Texto de prueba',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                await lambda.handler(event);

                // Verify DynamoDB was called to update status
                const dynamoCalls = dynamoDBDocumentClientMock.calls();
                expect(dynamoCalls.length).to.be.greaterThan(0);
                
                // Check that status updates were made
                const updateCalls = dynamoCalls.filter(call => call.args[0].input.UpdateExpression);
                expect(updateCalls.length).to.be.greaterThan(0);
            });

            it('should handle DynamoDB update failures gracefully', async () => {
                const event = {
                    guid: 'test-guid-dynamo-fail',
                    translationTask: {
                        sourceLanguage: 'en',
                        targetLanguage: 'es',
                        textSegments: [
                            { startTime: 1000, endTime: 3000, text: 'Test text' }
                        ],
                        jobId: 'translation-dynamo-fail-test'
                    }
                };

                // Mock DynamoDB to fail
                dynamoDBDocumentClientMock.on(UpdateCommand).rejects(new Error('DynamoDB error'));
                translateClientMock.on(TranslateTextCommand).resolves({
                    TranslatedText: 'Texto de prueba',
                    SourceLanguageCode: 'en',
                    TargetLanguageCode: 'es'
                });

                // Should still complete translation successfully despite DynamoDB failure
                const result = await lambda.handler(event);
                expect(result.translationResult.status).to.equal('COMPLETED');
                expect(result.translatedSegments[0].text).to.equal('Texto de prueba');
            });
        });
    });

    // Property-based tests
    describe('Property-Based Tests', () => {
        // Feature: video-transcription-translation, Property 5: Language Support Coverage
        // Validates: Requirements 2.4
        it('Property 5: For any text content, translation should succeed for all specified supported languages', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate test data
                    fc.record({
                        guid: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
                        sourceLanguage: fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'ja', 'ko', 'zh', 'ar'),
                        targetLanguage: fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'ja', 'ko', 'zh', 'ar'),
                        textSegments: fc.array(
                            fc.record({
                                startTime: fc.float({ min: 0, max: 300000 }), // 0 to 5 minutes in ms
                                endTime: fc.float({ min: 0, max: 300000 }),
                                text: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)
                            }).filter(segment => segment.endTime > segment.startTime),
                            { minLength: 1, maxLength: 10 }
                        )
                    }).filter(data => data.sourceLanguage !== data.targetLanguage), // Ensure different languages for actual translation
                    async (testData) => {
                        const event = {
                            guid: testData.guid,
                            translationTask: {
                                sourceLanguage: testData.sourceLanguage,
                                targetLanguage: testData.targetLanguage,
                                textSegments: testData.textSegments,
                                jobId: `translation-${testData.sourceLanguage}-${testData.targetLanguage}-${testData.guid}`
                            }
                        };

                        // Mock DynamoDB updates
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        // Mock AWS Translate responses for all text segments
                        testData.textSegments.forEach((segment, index) => {
                            translateClientMock.on(TranslateTextCommand, {
                                Text: segment.text,
                                SourceLanguageCode: mapLanguageCodeForTranslate(testData.sourceLanguage),
                                TargetLanguageCode: mapLanguageCodeForTranslate(testData.targetLanguage)
                            }).resolves({
                                TranslatedText: `translated_${segment.text}_${testData.targetLanguage}`,
                                SourceLanguageCode: mapLanguageCodeForTranslate(testData.sourceLanguage),
                                TargetLanguageCode: mapLanguageCodeForTranslate(testData.targetLanguage)
                            });
                        });

                        const result = await lambda.handler(event);

                        // Property: Translation should succeed for all supported languages
                        expect(result).to.have.property('translatedSegments');
                        expect(result).to.have.property('translationResult');
                        
                        // Verify translation result structure
                        expect(result.translationResult).to.have.property('sourceLanguage', testData.sourceLanguage);
                        expect(result.translationResult).to.have.property('targetLanguage', testData.targetLanguage);
                        expect(result.translationResult).to.have.property('segmentCount', testData.textSegments.length);
                        expect(result.translationResult).to.have.property('status', 'COMPLETED');
                        
                        // Verify translated segments preserve timing and structure
                        expect(result.translatedSegments).to.be.an('array');
                        expect(result.translatedSegments).to.have.length(testData.textSegments.length);
                        
                        result.translatedSegments.forEach((translatedSegment, index) => {
                            const originalSegment = testData.textSegments[index];
                            
                            // Timing information must be preserved
                            expect(translatedSegment).to.have.property('startTime', originalSegment.startTime);
                            expect(translatedSegment).to.have.property('endTime', originalSegment.endTime);
                            
                            // Translated text should be present and different from original (unless same language)
                            expect(translatedSegment).to.have.property('text');
                            expect(translatedSegment.text).to.be.a('string');
                            expect(translatedSegment.text.length).to.be.greaterThan(0);
                            
                            // Original text should be preserved for reference
                            expect(translatedSegment).to.have.property('originalText', originalSegment.text);
                            
                            // For different languages, translated text should be different from original
                            if (testData.sourceLanguage !== testData.targetLanguage) {
                                expect(translatedSegment.text).to.include(`translated_${originalSegment.text}_${testData.targetLanguage}`);
                            }
                            
                            // Should not have translation errors for supported languages
                            expect(translatedSegment).to.not.have.property('translationError');
                        });
                        
                        // Verify the event structure is preserved
                        expect(result.guid).to.equal(testData.guid);
                        expect(result.translationTask).to.deep.equal(event.translationTask);
                        
                        // Reset mocks for next iteration
                        translateClientMock.reset();
                        dynamoDBDocumentClientMock.reset();
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});
                    }
                ),
                { numRuns: 100, timeout: 30000 }
            );
        });
    });
});

/**
 * Maps internal language codes to AWS Translate language codes
 * This is a copy of the function from the main module for testing purposes
 * @param {string} languageCode - Internal language code
 * @returns {string} AWS Translate language code
 */
function mapLanguageCodeForTranslate(languageCode) {
    // AWS Translate uses slightly different language codes
    const languageMapping = {
        'en': 'en',
        'es': 'es',
        'fr': 'fr',
        'de': 'de',
        'it': 'it',
        'pt': 'pt',
        'pt-BR': 'pt', // AWS Translate uses 'pt' for both Portuguese variants
        'ja': 'ja',
        'ko': 'ko',
        'zh': 'zh', // AWS Translate uses 'zh' for Chinese
        'ar': 'ar'
    };

    return languageMapping[languageCode] || languageCode;
}
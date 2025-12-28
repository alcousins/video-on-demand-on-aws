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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const sinon = require('sinon');

const lambda = require('../index.js');
const error = require('./error.js');

describe('#WEBVTT GENERATOR LAMBDA::', () => {
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

    // Unit Tests
    describe('Unit Tests', () => {
        describe('WebVTT format compliance', () => {
            it('should generate valid WebVTT files with proper headers', async () => {
                const event = {
                    guid: 'test-guid-123',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'es',
                                segmentCount: 2,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Hola mundo', originalText: 'Hello world' },
                                { startTime: 4000, endTime: 6000, text: '¿Cómo estás?', originalText: 'How are you?' }
                            ]
                        }
                    ]
                };

                // Mock S3 upload
                s3ClientMock.on(PutObjectCommand).resolves({});
                // Mock DynamoDB updates
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify WebVTT files were generated
                expect(result.webvttFiles).to.be.an('array');
                expect(result.webvttFiles).to.have.length(1);

                const webvttFile = result.webvttFiles[0];
                expect(webvttFile).to.have.property('language', 'es');
                expect(webvttFile).to.have.property('filename', 'test-video.es.vtt');
                expect(webvttFile).to.have.property('s3Location');
                expect(webvttFile).to.have.property('size');
                expect(webvttFile).to.have.property('checksum');

                // Verify S3 upload was called with correct parameters
                const s3Calls = s3ClientMock.calls();
                expect(s3Calls).to.have.length(1);
                
                const uploadCall = s3Calls[0];
                expect(uploadCall.args[0].input.Bucket).to.equal('test-dest-bucket');
                expect(uploadCall.args[0].input.Key).to.equal('test-guid-123/subtitles/test-video.es.vtt');
                expect(uploadCall.args[0].input.ContentType).to.equal('text/vtt');
                expect(uploadCall.args[0].input.ContentEncoding).to.equal('utf-8');

                // Verify WebVTT content structure
                const webvttContent = uploadCall.args[0].input.Body;
                expect(webvttContent).to.be.a('string');
                expect(webvttContent).to.include('WEBVTT');
                expect(webvttContent).to.include('Kind: subtitles');
                expect(webvttContent).to.include('Language: es');
                expect(webvttContent).to.include('00:00:01.000 --> 00:00:03.000');
                expect(webvttContent).to.include('Hola mundo');
                expect(webvttContent).to.include('00:00:04.000 --> 00:00:06.000');
                expect(webvttContent).to.include('¿Cómo estás?');
            });

            it('should generate separate files for each language with consistent naming', async () => {
                const event = {
                    guid: 'test-guid-multi-lang',
                    srcVideo: 'sample-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'es',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Hola', originalText: 'Hello' }
                            ]
                        },
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'fr',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Bonjour', originalText: 'Hello' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify multiple WebVTT files were generated
                expect(result.webvttFiles).to.have.length(2);

                // Check Spanish file
                const spanishFile = result.webvttFiles.find(f => f.language === 'es');
                expect(spanishFile).to.exist;
                expect(spanishFile.filename).to.equal('sample-video.es.vtt');
                expect(spanishFile.s3Key).to.equal('test-guid-multi-lang/subtitles/sample-video.es.vtt');

                // Check French file
                const frenchFile = result.webvttFiles.find(f => f.language === 'fr');
                expect(frenchFile).to.exist;
                expect(frenchFile.filename).to.equal('sample-video.fr.vtt');
                expect(frenchFile.s3Key).to.equal('test-guid-multi-lang/subtitles/sample-video.fr.vtt');

                // Verify S3 uploads for both files
                const s3Calls = s3ClientMock.calls();
                expect(s3Calls).to.have.length(2);
            });

            it('should validate WebVTT syntax before storing files', async () => {
                const event = {
                    guid: 'test-guid-validation',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'en',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Valid text', originalText: 'Valid text' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify file was generated successfully (validation passed)
                expect(result.webvttFiles).to.have.length(1);
                expect(result.webvttGeneration.status).to.equal('COMPLETED');

                // Verify the generated content follows WebVTT format
                const s3Calls = s3ClientMock.calls();
                const webvttContent = s3Calls[0].args[0].input.Body;
                
                // Check WebVTT structure
                const lines = webvttContent.split('\n');
                expect(lines[0]).to.equal('WEBVTT');
                expect(webvttContent).to.match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
            });
        });

        describe('UTF-8 encoding and character handling', () => {
            it('should handle special characters and Unicode properly', async () => {
                const event = {
                    guid: 'test-guid-unicode',
                    srcVideo: 'unicode-test.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'zh',
                                segmentCount: 3,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: '你好世界 😊', originalText: 'Hello world 😊' },
                                { startTime: 4000, endTime: 6000, text: 'Spëcîál chärs: áéíóú', originalText: 'Special chars: áéíóú' },
                                { startTime: 7000, endTime: 9000, text: '数字: 123 符号: $%&', originalText: 'Numbers: 123 symbols: $%&' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify file was generated
                expect(result.webvttFiles).to.have.length(1);

                // Check S3 upload parameters
                const s3Calls = s3ClientMock.calls();
                const uploadCall = s3Calls[0];
                expect(uploadCall.args[0].input.ContentEncoding).to.equal('utf-8');

                // Verify Unicode characters are preserved in WebVTT content
                const webvttContent = uploadCall.args[0].input.Body;
                expect(webvttContent).to.include('你好世界 😊');
                expect(webvttContent).to.include('Spëcîál chärs: áéíóú');
                expect(webvttContent).to.include('数字: 123 符号: $%&');

                // Verify no replacement characters (indicates proper UTF-8 handling)
                expect(webvttContent).to.not.include('\uFFFD');
            });

            it('should clean and escape problematic characters for WebVTT format', async () => {
                const event = {
                    guid: 'test-guid-escape',
                    srcVideo: 'escape-test.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'en',
                                segmentCount: 2,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Text with --> arrow', originalText: 'Text with --> arrow' },
                                { startTime: 4000, endTime: 6000, text: 'NOTE This is a note', originalText: 'NOTE This is a note' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify file was generated
                expect(result.webvttFiles).to.have.length(1);

                // Check that problematic characters were escaped
                const s3Calls = s3ClientMock.calls();
                const webvttContent = s3Calls[0].args[0].input.Body;
                
                // WebVTT timestamp separator should be escaped in text
                expect(webvttContent).to.include('Text with → arrow');
                expect(webvttContent).to.not.include('Text with --> arrow');
                
                // NOTE keyword should be escaped when at line start
                expect(webvttContent).to.include('Note: This is a note');
                expect(webvttContent).to.not.match(/^NOTE This is a note/m);
            });

            it('should handle very long text segments by truncating appropriately', async () => {
                const longText = 'A'.repeat(600); // Text longer than 500 character limit
                const event = {
                    guid: 'test-guid-long-text',
                    srcVideo: 'long-text.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'en',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 10000, text: longText, originalText: longText }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify file was generated
                expect(result.webvttFiles).to.have.length(1);

                // Check that text was truncated
                const s3Calls = s3ClientMock.calls();
                const webvttContent = s3Calls[0].args[0].input.Body;
                
                // Should contain truncated text with ellipsis
                expect(webvttContent).to.include('...');
                
                // Should not contain the full original text
                expect(webvttContent).to.not.include(longText);
                
                // Truncated text should be around 500 characters
                const lines = webvttContent.split('\n');
                const textLine = lines.find(line => line.includes('A') && line.includes('...'));
                expect(textLine).to.exist;
                expect(textLine.length).to.be.at.most(500);
            });
        });

        describe('File naming conventions', () => {
            it('should use consistent naming patterns for different video file types', async () => {
                const testCases = [
                    { srcVideo: 'video.mp4', expectedBase: 'video' },
                    { srcVideo: 'my-video.mov', expectedBase: 'my-video' },
                    { srcVideo: 'test_video.m4v', expectedBase: 'test_video' },
                    { srcVideo: 'sample.video.mpg', expectedBase: 'sample.video' },
                    { srcVideo: 'complex.name.with.dots.m2ts', expectedBase: 'complex.name.with.dots' }
                ];

                for (const testCase of testCases) {
                    const event = {
                        guid: `test-guid-${testCase.expectedBase}`,
                        srcVideo: testCase.srcVideo,
                        destBucket: 'test-dest-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'es',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1000, endTime: 3000, text: 'Test', originalText: 'Test' }
                                ]
                            }
                        ]
                    };

                    s3ClientMock.reset();
                    dynamoDBDocumentClientMock.reset();
                    s3ClientMock.on(PutObjectCommand).resolves({});
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    const result = await lambda.handler(event);

                    // Verify filename follows expected pattern
                    expect(result.webvttFiles).to.have.length(1);
                    expect(result.webvttFiles[0].filename).to.equal(`${testCase.expectedBase}.es.vtt`);
                }
            });

            it('should generate correct S3 keys following directory structure', async () => {
                const event = {
                    guid: 'test-guid-s3-key',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'fr',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Bonjour', originalText: 'Hello' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify S3 key structure
                expect(result.webvttFiles[0].s3Key).to.equal('test-guid-s3-key/subtitles/test-video.fr.vtt');
                expect(result.webvttFiles[0].s3Location).to.equal('s3://test-dest-bucket/test-guid-s3-key/subtitles/test-video.fr.vtt');

                // Verify S3 upload used correct key
                const s3Calls = s3ClientMock.calls();
                expect(s3Calls[0].args[0].input.Key).to.equal('test-guid-s3-key/subtitles/test-video.fr.vtt');
            });
        });

        describe('Error handling', () => {
            it('should handle missing required parameters', async () => {
                const event = {
                    // Missing guid
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: []
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for missing guid');
                } catch (err) {
                    expect(err.message).to.include('Missing or invalid required parameter: guid');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should handle empty translated segments', async () => {
                const event = {
                    guid: 'test-guid-empty',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: []
                };

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for empty translatedSegments');
                } catch (err) {
                    expect(err.message).to.include('translatedSegments array cannot be empty');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should handle S3 upload failures gracefully', async () => {
                const event = {
                    guid: 'test-guid-s3-fail',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'es',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Test', originalText: 'Test' }
                            ]
                        }
                    ]
                };

                // Mock S3 to fail
                s3ClientMock.on(PutObjectCommand).rejects(new Error('S3 upload failed'));
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                try {
                    await lambda.handler(event);
                    expect.fail('Should have thrown an error for S3 upload failure');
                } catch (err) {
                    expect(err.message).to.include('Failed to upload any WebVTT files to S3');
                    expect(errorHandlerStub.calledOnce).to.be.true;
                }
            });

            it('should skip unsupported languages and continue with valid ones', async () => {
                const event = {
                    guid: 'test-guid-mixed-langs',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'unsupported-lang',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Test', originalText: 'Test' }
                            ]
                        },
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'es',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Prueba', originalText: 'Test' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Should only generate file for supported language
                expect(result.webvttFiles).to.have.length(1);
                expect(result.webvttFiles[0].language).to.equal('es');
                expect(result.webvttGeneration.status).to.equal('COMPLETED');
            });

            it('should handle DynamoDB update failures gracefully', async () => {
                const event = {
                    guid: 'test-guid-dynamo-fail',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'es',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Test', originalText: 'Test' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                // Mock DynamoDB to fail
                dynamoDBDocumentClientMock.on(UpdateCommand).rejects(new Error('DynamoDB error'));

                // Should still complete WebVTT generation successfully despite DynamoDB failure
                const result = await lambda.handler(event);
                expect(result.webvttGeneration.status).to.equal('COMPLETED');
                expect(result.webvttFiles).to.have.length(1);
            });
        });

        describe('Metadata and checksums', () => {
            it('should generate correct file metadata and checksums', async () => {
                const event = {
                    guid: 'test-guid-metadata',
                    srcVideo: 'test-video.mp4',
                    destBucket: 'test-dest-bucket',
                    translatedSegments: [
                        {
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: 'es',
                                segmentCount: 1,
                                status: 'COMPLETED'
                            },
                            translatedSegments: [
                                { startTime: 1000, endTime: 3000, text: 'Hola', originalText: 'Hello' }
                            ]
                        }
                    ]
                };

                s3ClientMock.on(PutObjectCommand).resolves({});
                dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                const result = await lambda.handler(event);

                // Verify file metadata
                const webvttFile = result.webvttFiles[0];
                expect(webvttFile).to.have.property('size');
                expect(webvttFile.size).to.be.a('number');
                expect(webvttFile.size).to.be.greaterThan(0);

                expect(webvttFile).to.have.property('checksum');
                expect(webvttFile.checksum).to.be.a('string');
                expect(webvttFile.checksum).to.have.length(32); // MD5 hash length

                // Verify S3 metadata
                const s3Calls = s3ClientMock.calls();
                const uploadCall = s3Calls[0];
                const metadata = uploadCall.args[0].input.Metadata;
                
                expect(metadata).to.have.property('language', 'es');
                expect(metadata).to.have.property('guid', 'test-guid-metadata');
                expect(metadata).to.have.property('checksum', webvttFile.checksum);
                expect(metadata).to.have.property('generated-by', 'video-on-demand-webvtt-generator');
            });
        });

        describe('Storage Integration Unit Tests', () => {
            describe('S3 upload and directory organization', () => {
                it('should upload files to correct S3 bucket and key structure', async () => {
                    const event = {
                        guid: 'storage-test-guid',
                        srcVideo: 'storage-test.mp4',
                        destBucket: 'storage-test-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'fr',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 2000, endTime: 4000, text: 'Bonjour le monde', originalText: 'Hello world' }
                                ]
                            }
                        ]
                    };

                    s3ClientMock.on(PutObjectCommand).resolves({});
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    await lambda.handler(event);

                    // Verify S3 upload parameters
                    const s3Calls = s3ClientMock.calls();
                    expect(s3Calls).to.have.length(1);
                    
                    const uploadCall = s3Calls[0];
                    const uploadParams = uploadCall.args[0].input;
                    
                    // Test S3 bucket
                    expect(uploadParams.Bucket).to.equal('storage-test-bucket');
                    
                    // Test directory structure: {guid}/subtitles/{filename}
                    expect(uploadParams.Key).to.equal('storage-test-guid/subtitles/storage-test.fr.vtt');
                    
                    // Test content type for web delivery
                    expect(uploadParams.ContentType).to.equal('text/vtt');
                    expect(uploadParams.ContentEncoding).to.equal('utf-8');
                    
                    // Test file content is properly formatted
                    expect(uploadParams.Body).to.be.a('string');
                    expect(uploadParams.Body).to.include('WEBVTT');
                    expect(uploadParams.Body).to.include('Bonjour le monde');
                });

                it('should organize multiple language files in same directory structure', async () => {
                    const event = {
                        guid: 'multi-lang-storage',
                        srcVideo: 'multi-lang.mp4',
                        destBucket: 'multi-lang-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'es',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1000, endTime: 3000, text: 'Hola', originalText: 'Hello' }
                                ]
                            },
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'de',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1000, endTime: 3000, text: 'Hallo', originalText: 'Hello' }
                                ]
                            }
                        ]
                    };

                    s3ClientMock.on(PutObjectCommand).resolves({});
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    await lambda.handler(event);

                    // Verify both files uploaded to same directory structure
                    const s3Calls = s3ClientMock.calls();
                    expect(s3Calls).to.have.length(2);
                    
                    const spanishUpload = s3Calls.find(call => call.args[0].input.Key.includes('.es.'));
                    const germanUpload = s3Calls.find(call => call.args[0].input.Key.includes('.de.'));
                    
                    expect(spanishUpload).to.exist;
                    expect(germanUpload).to.exist;
                    
                    // Both should be in same directory under same GUID
                    expect(spanishUpload.args[0].input.Key).to.equal('multi-lang-storage/subtitles/multi-lang.es.vtt');
                    expect(germanUpload.args[0].input.Key).to.equal('multi-lang-storage/subtitles/multi-lang.de.vtt');
                    
                    // Both should use same bucket
                    expect(spanishUpload.args[0].input.Bucket).to.equal('multi-lang-bucket');
                    expect(germanUpload.args[0].input.Bucket).to.equal('multi-lang-bucket');
                });

                it('should handle S3 upload failures for individual files gracefully', async () => {
                    const event = {
                        guid: 'partial-fail-test',
                        srcVideo: 'partial-fail.mp4',
                        destBucket: 'partial-fail-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'es',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1000, endTime: 3000, text: 'Hola', originalText: 'Hello' }
                                ]
                            },
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'fr',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1000, endTime: 3000, text: 'Bonjour', originalText: 'Hello' }
                                ]
                            }
                        ]
                    };

                    // Mock S3 to fail for Spanish but succeed for French
                    s3ClientMock.on(PutObjectCommand)
                        .callsFakeOnce(() => {
                            throw new Error('S3 upload failed for Spanish');
                        })
                        .resolves({});
                    
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    const result = await lambda.handler(event);

                    // Should succeed with one file despite one failure
                    expect(result.webvttFiles).to.have.length(1);
                    expect(result.webvttFiles[0].language).to.equal('fr');
                    expect(result.webvttGeneration.status).to.equal('COMPLETED');
                });
            });

            describe('DynamoDB record updates', () => {
                it('should update DynamoDB with correct subtitle file locations and metadata', async () => {
                    const event = {
                        guid: 'dynamo-test-guid',
                        srcVideo: 'dynamo-test.mp4',
                        destBucket: 'dynamo-test-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'ja',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1500, endTime: 3500, text: 'こんにちは', originalText: 'Hello' }
                                ]
                            }
                        ]
                    };

                    s3ClientMock.on(PutObjectCommand).resolves({});
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    await lambda.handler(event);

                    // Verify DynamoDB updates
                    const dynamoCalls = dynamoDBDocumentClientMock.calls();
                    expect(dynamoCalls.length).to.be.greaterThan(0);
                    
                    // Find the completion update (should be the last one)
                    const completionUpdate = dynamoCalls[dynamoCalls.length - 1];
                    const updateParams = completionUpdate.args[0].input;
                    
                    // Verify table and key
                    expect(updateParams.TableName).to.equal(process.env.DynamoDBTable);
                    expect(updateParams.Key).to.deep.equal({ guid: 'dynamo-test-guid' });
                    
                    // Verify update expression includes status and file locations
                    expect(updateParams.UpdateExpression).to.include('subtitleProcessing');
                    expect(updateParams.UpdateExpression).to.include('lastUpdated');
                    
                    // Verify status is set to completed
                    const statusValue = Object.values(updateParams.ExpressionAttributeValues).find(val => 
                        val === 'COMPLETED' || val === 'completed'
                    );
                    expect(statusValue).to.exist;
                });

                it('should update DynamoDB with processing status during different phases', async () => {
                    const event = {
                        guid: 'status-test-guid',
                        srcVideo: 'status-test.mp4',
                        destBucket: 'status-test-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'ko',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 2000, endTime: 4000, text: '안녕하세요', originalText: 'Hello' }
                                ]
                            }
                        ]
                    };

                    s3ClientMock.on(PutObjectCommand).resolves({});
                    dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                    await lambda.handler(event);

                    // Verify multiple status updates occurred
                    const dynamoCalls = dynamoDBDocumentClientMock.calls();
                    expect(dynamoCalls.length).to.be.greaterThan(1);
                    
                    // Should have updates for: STARTING, UPLOADING, COMPLETED
                    const statusUpdates = dynamoCalls.map(call => {
                        const values = call.args[0].input.ExpressionAttributeValues;
                        return Object.values(values).find(val => 
                            typeof val === 'string' && 
                            ['STARTING', 'UPLOADING', 'COMPLETED', 'starting', 'uploading', 'completed'].includes(val)
                        );
                    }).filter(Boolean);
                    
                    expect(statusUpdates.length).to.be.greaterThan(1);
                    
                    // Normalize status values to uppercase for comparison
                    const normalizedStatuses = statusUpdates.map(status => status.toUpperCase());
                    expect(normalizedStatuses).to.include.members(['STARTING', 'UPLOADING', 'COMPLETED']);
                });

                it('should handle DynamoDB update failures gracefully without affecting file generation', async () => {
                    const event = {
                        guid: 'dynamo-fail-test',
                        srcVideo: 'dynamo-fail.mp4',
                        destBucket: 'dynamo-fail-bucket',
                        translatedSegments: [
                            {
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: 'zh',
                                    segmentCount: 1,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: [
                                    { startTime: 1000, endTime: 3000, text: '你好', originalText: 'Hello' }
                                ]
                            }
                        ]
                    };

                    s3ClientMock.on(PutObjectCommand).resolves({});
                    // Mock DynamoDB to fail
                    dynamoDBDocumentClientMock.on(UpdateCommand).rejects(new Error('DynamoDB connection failed'));

                    // Should still complete successfully despite DynamoDB failures
                    const result = await lambda.handler(event);
                    
                    expect(result.webvttFiles).to.have.length(1);
                    expect(result.webvttFiles[0].language).to.equal('zh');
                    expect(result.webvttGeneration.status).to.equal('COMPLETED');
                    
                    // Verify S3 upload still occurred
                    const s3Calls = s3ClientMock.calls();
                    expect(s3Calls).to.have.length(1);
                });
            });

            describe('CloudFront URL accessibility', () => {
                it('should generate correct CloudFront URLs when CloudFront domain is configured', async () => {
                    // Set CloudFront environment variable
                    const originalCloudFront = process.env.CloudFront;
                    process.env.CloudFront = 'test-distribution.cloudfront.net';

                    try {
                        const event = {
                            guid: 'cloudfront-test-guid',
                            srcVideo: 'cloudfront-test.mp4',
                            destBucket: 'cloudfront-test-bucket',
                            translatedSegments: [
                                {
                                    translationResult: {
                                        sourceLanguage: 'en',
                                        targetLanguage: 'ar',
                                        segmentCount: 1,
                                        status: 'COMPLETED'
                                    },
                                    translatedSegments: [
                                        { startTime: 1000, endTime: 3000, text: 'مرحبا', originalText: 'Hello' }
                                    ]
                                }
                            ]
                        };

                        s3ClientMock.on(PutObjectCommand).resolves({});
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        const result = await lambda.handler(event);

                        // Verify CloudFront URL generation
                        expect(result.webvttFiles).to.have.length(1);
                        const webvttFile = result.webvttFiles[0];
                        
                        expect(webvttFile).to.have.property('cloudFrontUrl');
                        expect(webvttFile.cloudFrontUrl).to.be.a('string');
                        
                        // Verify URL format
                        const expectedUrl = 'https://test-distribution.cloudfront.net/cloudfront-test-guid/subtitles/cloudfront-test.ar.vtt';
                        expect(webvttFile.cloudFrontUrl).to.equal(expectedUrl);
                        
                        // Verify URL is properly formatted for web access
                        expect(webvttFile.cloudFrontUrl).to.match(/^https:\/\/[a-z0-9.-]+\.cloudfront\.net\/[a-zA-Z0-9-_]+\/subtitles\/[^\/]+\.vtt$/);
                        
                    } finally {
                        // Restore original CloudFront environment variable
                        if (originalCloudFront) {
                            process.env.CloudFront = originalCloudFront;
                        } else {
                            delete process.env.CloudFront;
                        }
                    }
                });

                it('should handle missing CloudFront configuration gracefully', async () => {
                    // Ensure CloudFront is not configured
                    const originalCloudFront = process.env.CloudFront;
                    delete process.env.CloudFront;

                    try {
                        const event = {
                            guid: 'no-cloudfront-test',
                            srcVideo: 'no-cloudfront.mp4',
                            destBucket: 'no-cloudfront-bucket',
                            translatedSegments: [
                                {
                                    translationResult: {
                                        sourceLanguage: 'en',
                                        targetLanguage: 'pt',
                                        segmentCount: 1,
                                        status: 'COMPLETED'
                                    },
                                    translatedSegments: [
                                        { startTime: 1000, endTime: 3000, text: 'Olá', originalText: 'Hello' }
                                    ]
                                }
                            ]
                        };

                        s3ClientMock.on(PutObjectCommand).resolves({});
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        const result = await lambda.handler(event);

                        // Should still complete successfully without CloudFront URLs
                        expect(result.webvttFiles).to.have.length(1);
                        const webvttFile = result.webvttFiles[0];
                        
                        // CloudFront URL should be null when not configured
                        expect(webvttFile.cloudFrontUrl).to.be.null;
                        
                        // But S3 location should still be present
                        expect(webvttFile.s3Location).to.equal('s3://no-cloudfront-bucket/no-cloudfront-test/subtitles/no-cloudfront.pt.vtt');
                        
                    } finally {
                        // Restore original CloudFront environment variable
                        if (originalCloudFront) {
                            process.env.CloudFront = originalCloudFront;
                        }
                    }
                });

                it('should generate web-safe URLs that are accessible through CDN', async () => {
                    // Test with special characters in video name
                    const originalCloudFront = process.env.CloudFront;
                    process.env.CloudFront = 'cdn-test.cloudfront.net';

                    try {
                        const event = {
                            guid: 'special-chars-test',
                            srcVideo: 'test video with spaces.mp4',
                            destBucket: 'special-chars-bucket',
                            translatedSegments: [
                                {
                                    translationResult: {
                                        sourceLanguage: 'en',
                                        targetLanguage: 'it',
                                        segmentCount: 1,
                                        status: 'COMPLETED'
                                    },
                                    translatedSegments: [
                                        { startTime: 1000, endTime: 3000, text: 'Ciao', originalText: 'Hello' }
                                    ]
                                }
                            ]
                        };

                        s3ClientMock.on(PutObjectCommand).resolves({});
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        const result = await lambda.handler(event);

                        const webvttFile = result.webvttFiles[0];
                        
                        // URL should be web-safe (no spaces or special characters)
                        expect(webvttFile.cloudFrontUrl).to.not.match(/[\s<>"{}|\\^`\[\]]/);
                        
                        // URL should be properly encoded for web access
                        expect(webvttFile.cloudFrontUrl).to.match(/^https:\/\/[a-z0-9.-]+\.cloudfront\.net\/[a-zA-Z0-9-_%]+\/subtitles\/[^\/\s]+\.vtt$/);
                        
                        // Should not have double slashes (except after protocol)
                        const urlWithoutProtocol = webvttFile.cloudFrontUrl.replace('https://', '');
                        expect(urlWithoutProtocol).to.not.include('//');
                        
                    } finally {
                        if (originalCloudFront) {
                            process.env.CloudFront = originalCloudFront;
                        } else {
                            delete process.env.CloudFront;
                        }
                    }
                });
            });
        });
    });

    // Property-based tests
    describe('Property-Based Tests', () => {
        // Feature: video-transcription-translation, Property 6: WebVTT Format Correctness
        // Validates: Requirements 3.1, 3.2, 3.3, 3.4
        it('Property 6: For any translated text segments with timing information, the generated WebVTT files should be syntactically valid, UTF-8 encoded, and contain all required elements', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate test data
                    fc.record({
                        guid: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
                        srcVideo: fc.string({ minLength: 1, maxLength: 100 })
                            .filter(s => /^[a-zA-Z0-9._-]+\.(mp4|mov|m4v|mpg|m2ts)$/i.test(s) && !s.startsWith('.') && !s.includes('..') && s.length > 5),
                        languages: fc.array(
                            fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'),
                            { minLength: 1, maxLength: 3 }
                        ),
                        textSegments: fc.array(
                            fc.record({
                                startTime: fc.integer({ min: 0, max: 300000 }), // 0 to 5 minutes in ms
                                endTime: fc.integer({ min: 1000, max: 300000 }), // At least 1 second, up to 5 minutes
                                text: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)
                            }).filter(segment => segment.endTime > segment.startTime + 500), // Ensure at least 500ms duration
                            { minLength: 1, maxLength: 10 }
                        )
                    }),
                    async (testData) => {
                        // Create event with translated segments for each language
                        const translatedSegments = testData.languages.map(lang => ({
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: lang,
                                segmentCount: testData.textSegments.length,
                                status: 'COMPLETED'
                            },
                            translatedSegments: testData.textSegments.map(segment => ({
                                startTime: segment.startTime,
                                endTime: segment.endTime,
                                text: `${segment.text}_${lang}`,
                                originalText: segment.text
                            }))
                        }));

                        const event = {
                            guid: testData.guid,
                            srcVideo: testData.srcVideo,
                            destBucket: 'test-dest-bucket',
                            translatedSegments: translatedSegments
                        };

                        // Reset and mock S3 and DynamoDB for each iteration
                        s3ClientMock.reset();
                        dynamoDBDocumentClientMock.reset();
                        s3ClientMock.on(PutObjectCommand).resolves({});
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        const result = await lambda.handler(event);

                        // Property: WebVTT files should be syntactically valid, UTF-8 encoded, and contain all required elements
                        expect(result).to.have.property('webvttFiles');
                        expect(result).to.have.property('webvttGeneration');
                        
                        // Verify generation completed successfully
                        expect(result.webvttGeneration).to.have.property('status', 'COMPLETED');
                        expect(result.webvttGeneration).to.have.property('fileCount', testData.languages.length);
                        expect(result.webvttGeneration).to.have.property('languages');
                        expect(result.webvttGeneration.languages).to.have.length(testData.languages.length);
                        
                        // Verify WebVTT files structure
                        expect(result.webvttFiles).to.be.an('array');
                        expect(result.webvttFiles).to.have.length(testData.languages.length);
                        
                        // Verify each WebVTT file
                        result.webvttFiles.forEach((webvttFile, index) => {
                            const expectedLanguage = testData.languages[index];
                            
                            // File structure validation
                            expect(webvttFile).to.have.property('language', expectedLanguage);
                            expect(webvttFile).to.have.property('filename');
                            expect(webvttFile).to.have.property('s3Location');
                            expect(webvttFile).to.have.property('s3Key');
                            expect(webvttFile).to.have.property('size');
                            expect(webvttFile).to.have.property('checksum');
                            
                            // Filename validation
                            const expectedFilename = testData.srcVideo.replace(/\.[^/.]+$/, '') + `.${expectedLanguage}.vtt`;
                            expect(webvttFile.filename).to.equal(expectedFilename);
                            
                            // S3 key validation
                            const expectedS3Key = `${testData.guid}/subtitles/${expectedFilename}`;
                            expect(webvttFile.s3Key).to.equal(expectedS3Key);
                            
                            // S3 location validation
                            const expectedS3Location = `s3://test-dest-bucket/${expectedS3Key}`;
                            expect(webvttFile.s3Location).to.equal(expectedS3Location);
                            
                            // Size validation
                            expect(webvttFile.size).to.be.a('number');
                            expect(webvttFile.size).to.be.greaterThan(0);
                            
                            // Checksum validation (MD5 hash)
                            expect(webvttFile.checksum).to.be.a('string');
                            expect(webvttFile.checksum).to.have.length(32);
                            expect(webvttFile.checksum).to.match(/^[a-f0-9]{32}$/);
                        });
                        
                        // Verify S3 uploads were made correctly
                        const s3Calls = s3ClientMock.calls();
                        expect(s3Calls).to.have.length(testData.languages.length);
                        
                        s3Calls.forEach((call, index) => {
                            const uploadParams = call.args[0].input;
                            const expectedLanguage = testData.languages[index];
                            
                            // Upload parameters validation
                            expect(uploadParams.Bucket).to.equal('test-dest-bucket');
                            expect(uploadParams.ContentType).to.equal('text/vtt');
                            expect(uploadParams.ContentEncoding).to.equal('utf-8');
                            
                            // WebVTT content validation
                            const webvttContent = uploadParams.Body;
                            expect(webvttContent).to.be.a('string');
                            
                            // Required WebVTT elements
                            expect(webvttContent).to.include('WEBVTT'); // Header
                            expect(webvttContent).to.include('Kind: subtitles'); // Kind metadata
                            expect(webvttContent).to.include(`Language: ${expectedLanguage}`); // Language metadata
                            
                            // Timing cues validation
                            testData.textSegments.forEach(segment => {
                                const startTimestamp = formatWebVTTTimestamp(segment.startTime);
                                const endTimestamp = formatWebVTTTimestamp(segment.endTime);
                                const expectedTimingLine = `${startTimestamp} --> ${endTimestamp}`;
                                expect(webvttContent).to.include(expectedTimingLine);
                                
                                // Text content validation - account for text cleaning (whitespace normalization)
                                const rawExpectedText = `${segment.text}_${expectedLanguage}`;
                                const cleanedExpectedText = rawExpectedText
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .replace(/-->/g, '→')
                                    .replace(/^NOTE\s/gm, 'Note: ')
                                    .replace(/^WEBVTT/gm, 'WebVTT')
                                    .replace(/\r\n/g, '\n')
                                    .replace(/\r/g, '\n');
                                
                                if (cleanedExpectedText.length > 0) {
                                    expect(webvttContent).to.include(cleanedExpectedText);
                                }
                            });
                            
                            // UTF-8 encoding validation (no replacement characters)
                            expect(webvttContent).to.not.include('\uFFFD');
                            
                            // Metadata validation
                            expect(uploadParams.Metadata).to.have.property('language', expectedLanguage);
                            expect(uploadParams.Metadata).to.have.property('guid', testData.guid);
                            expect(uploadParams.Metadata).to.have.property('generated-by', 'video-on-demand-webvtt-generator');
                        });
                    }
                ),
                { numRuns: 100, timeout: 30000 }
            );
        });

        // Feature: video-transcription-translation, Property 7: File Organization Consistency
        // Validates: Requirements 3.5, 4.1, 4.2, 4.3
        it('Property 7: For any video file and its generated subtitle files, the subtitle files should be stored in the same directory structure with consistent naming patterns', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate test data for file organization
                    fc.record({
                        guid: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
                        srcVideo: fc.string({ minLength: 1, maxLength: 100 })
                            .filter(s => /^[a-zA-Z0-9._-]+\.(mp4|mov|m4v|mpg|m2ts)$/i.test(s) && !s.startsWith('.') && !s.includes('..') && s.length > 5),
                        destBucket: fc.string({ minLength: 1, maxLength: 63 }).filter(s => /^[a-z0-9.-]+$/.test(s)),
                        languages: fc.array(
                            fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'),
                            { minLength: 1, maxLength: 5 }
                        ),
                        textSegments: fc.array(
                            fc.record({
                                startTime: fc.integer({ min: 0, max: 300000 }),
                                endTime: fc.integer({ min: 1000, max: 300000 }),
                                text: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0)
                            }).filter(segment => segment.endTime > segment.startTime + 500),
                            { minLength: 1, maxLength: 5 }
                        )
                    }),
                    async (testData) => {
                        // Create event with translated segments for each language
                        const translatedSegments = testData.languages.map(lang => ({
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: lang,
                                segmentCount: testData.textSegments.length,
                                status: 'COMPLETED'
                            },
                            translatedSegments: testData.textSegments.map(segment => ({
                                startTime: segment.startTime,
                                endTime: segment.endTime,
                                text: `${segment.text}_${lang}`,
                                originalText: segment.text
                            }))
                        }));

                        const event = {
                            guid: testData.guid,
                            srcVideo: testData.srcVideo,
                            destBucket: testData.destBucket,
                            translatedSegments: translatedSegments
                        };

                        // Reset and mock S3 and DynamoDB for each iteration
                        s3ClientMock.reset();
                        dynamoDBDocumentClientMock.reset();
                        s3ClientMock.on(PutObjectCommand).resolves({});
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        const result = await lambda.handler(event);

                        // Property: File organization consistency
                        expect(result.webvttFiles).to.be.an('array');
                        expect(result.webvttFiles).to.have.length(testData.languages.length);

                        // Extract base video name for consistency checks
                        const baseVideoName = testData.srcVideo.replace(/\.[^/.]+$/, '');

                        // Verify each subtitle file follows consistent organization
                        result.webvttFiles.forEach((webvttFile, index) => {
                            const expectedLanguage = testData.languages[index];
                            
                            // Consistent naming pattern: video_name.lang.vtt
                            const expectedFilename = `${baseVideoName}.${expectedLanguage}.vtt`;
                            expect(webvttFile.filename).to.equal(expectedFilename);
                            
                            // Same directory structure: {guid}/subtitles/{filename}
                            const expectedS3Key = `${testData.guid}/subtitles/${expectedFilename}`;
                            expect(webvttFile.s3Key).to.equal(expectedS3Key);
                            
                            // S3 location follows consistent pattern
                            const expectedS3Location = `s3://${testData.destBucket}/${expectedS3Key}`;
                            expect(webvttFile.s3Location).to.equal(expectedS3Location);
                            
                            // Language code is consistent
                            expect(webvttFile.language).to.equal(expectedLanguage);
                        });

                        // Verify S3 uploads follow the same organization pattern
                        const s3Calls = s3ClientMock.calls();
                        expect(s3Calls).to.have.length(testData.languages.length);
                        
                        s3Calls.forEach((call, index) => {
                            const uploadParams = call.args[0].input;
                            const expectedLanguage = testData.languages[index];
                            const expectedFilename = `${baseVideoName}.${expectedLanguage}.vtt`;
                            const expectedS3Key = `${testData.guid}/subtitles/${expectedFilename}`;
                            
                            // Verify upload parameters follow consistent organization
                            expect(uploadParams.Bucket).to.equal(testData.destBucket);
                            expect(uploadParams.Key).to.equal(expectedS3Key);
                            expect(uploadParams.ContentType).to.equal('text/vtt');
                            expect(uploadParams.Metadata.language).to.equal(expectedLanguage);
                            expect(uploadParams.Metadata.guid).to.equal(testData.guid);
                        });
                    }
                ),
                { numRuns: 100, timeout: 30000 }
            );
        });

        // Feature: video-transcription-translation, Property 8: Database State Consistency
        // Validates: Requirements 4.4, 7.4
        it('Property 8: For any subtitle processing operation, the DynamoDB record should accurately reflect the current processing status, file locations, and any error details', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate test data for database consistency
                    fc.record({
                        guid: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
                        srcVideo: fc.string({ minLength: 1, maxLength: 100 })
                            .filter(s => /^[a-zA-Z0-9._-]+\.(mp4|mov|m4v|mpg|m2ts)$/i.test(s) && !s.startsWith('.') && !s.includes('..') && s.length > 5),
                        destBucket: fc.string({ minLength: 1, maxLength: 63 }).filter(s => /^[a-z0-9.-]+$/.test(s)),
                        languages: fc.array(
                            fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt'),
                            { minLength: 1, maxLength: 3 }
                        ),
                        textSegments: fc.array(
                            fc.record({
                                startTime: fc.integer({ min: 0, max: 180000 }),
                                endTime: fc.integer({ min: 1000, max: 180000 }),
                                text: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0)
                            }).filter(segment => segment.endTime > segment.startTime + 500),
                            { minLength: 1, maxLength: 3 }
                        )
                    }),
                    async (testData) => {
                        // Create event with translated segments
                        const translatedSegments = testData.languages.map(lang => ({
                            translationResult: {
                                sourceLanguage: 'en',
                                targetLanguage: lang,
                                segmentCount: testData.textSegments.length,
                                status: 'COMPLETED'
                            },
                            translatedSegments: testData.textSegments.map(segment => ({
                                startTime: segment.startTime,
                                endTime: segment.endTime,
                                text: `${segment.text}_${lang}`,
                                originalText: segment.text
                            }))
                        }));

                        const event = {
                            guid: testData.guid,
                            srcVideo: testData.srcVideo,
                            destBucket: testData.destBucket,
                            translatedSegments: translatedSegments
                        };

                        // Reset mocks and capture DynamoDB calls
                        s3ClientMock.reset();
                        dynamoDBDocumentClientMock.reset();
                        s3ClientMock.on(PutObjectCommand).resolves({});
                        dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                        const result = await lambda.handler(event);

                        // Property: Database state consistency
                        const dynamoDBCalls = dynamoDBDocumentClientMock.calls();
                        expect(dynamoDBCalls.length).to.be.greaterThan(0);

                        // Verify DynamoDB updates reflect processing status accurately
                        const updateCalls = dynamoDBCalls.filter(call => call.args[0].input.TableName === process.env.DynamoDBTable);
                        expect(updateCalls.length).to.be.greaterThan(0);

                        // Check the final status update (should be the last call)
                        const finalUpdate = updateCalls[updateCalls.length - 1];
                        const updateParams = finalUpdate.args[0].input;
                        
                        // Verify key consistency
                        expect(updateParams.Key).to.deep.equal({ guid: testData.guid });
                        
                        // Verify update expression contains status and timestamp
                        expect(updateParams.UpdateExpression).to.include('subtitleProcessing.#status');
                        expect(updateParams.UpdateExpression).to.include('lastUpdated');
                        
                        // Verify status values are consistent with processing result
                        if (result.webvttGeneration.status === 'COMPLETED') {
                            expect(updateParams.ExpressionAttributeValues).to.have.property(':status');
                            // Status should indicate completion
                            const statusValue = updateParams.ExpressionAttributeValues[':status'];
                            expect(['COMPLETED', 'completed']).to.include(statusValue);
                        }

                        // Verify file locations are recorded accurately
                        if (result.webvttFiles && result.webvttFiles.length > 0) {
                            // Should have subtitle files information in the update
                            const hasSubtitleFiles = Object.keys(updateParams.ExpressionAttributeValues).some(key => 
                                key.includes('subtitleFiles') || updateParams.UpdateExpression.includes('subtitleFiles')
                            );
                            expect(hasSubtitleFiles).to.be.true;
                        }

                        // Verify timestamp consistency
                        const timestampKeys = Object.keys(updateParams.ExpressionAttributeValues).filter(key => 
                            key.includes('timestamp') || key.includes('Time')
                        );
                        timestampKeys.forEach(key => {
                            const timestamp = updateParams.ExpressionAttributeValues[key];
                            expect(timestamp).to.be.a('string');
                            // Should be a valid ISO timestamp
                            expect(() => new Date(timestamp)).to.not.throw();
                            // Should be recent (within last minute for test execution)
                            const timestampDate = new Date(timestamp);
                            const now = new Date();
                            const timeDiff = now.getTime() - timestampDate.getTime();
                            expect(timeDiff).to.be.lessThan(60000); // Less than 1 minute
                        });

                        // Verify language consistency between result and database update
                        if (result.webvttGeneration.languages) {
                            expect(result.webvttGeneration.languages).to.have.length(testData.languages.length);
                            result.webvttGeneration.languages.forEach(lang => {
                                expect(testData.languages).to.include(lang);
                            });
                        }
                    }
                ),
                { numRuns: 100, timeout: 30000 }
            );
        });

        // Feature: video-transcription-translation, Property 9: CDN Accessibility
        // Validates: Requirements 4.5
        it('Property 9: For any generated subtitle file, it should be accessible through the existing CloudFront distribution using the expected URL pattern', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate test data for CDN accessibility
                    fc.record({
                        guid: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
                        srcVideo: fc.string({ minLength: 1, maxLength: 100 })
                            .filter(s => /^[a-zA-Z0-9._-]+\.(mp4|mov|m4v|mpg|m2ts)$/i.test(s) && !s.startsWith('.') && !s.includes('..') && s.length > 5),
                        destBucket: fc.string({ minLength: 1, maxLength: 63 }).filter(s => /^[a-z0-9.-]+$/.test(s)),
                        cloudFrontDomain: fc.oneof(
                            fc.constant('d123456789.cloudfront.net'),
                            fc.constant('example.cloudfront.net'),
                            fc.constant('test-cdn.cloudfront.net')
                        ),
                        languages: fc.array(
                            fc.constantFrom('en', 'es', 'fr', 'de', 'it', 'pt'),
                            { minLength: 1, maxLength: 3 }
                        ),
                        textSegments: fc.array(
                            fc.record({
                                startTime: fc.integer({ min: 0, max: 120000 }),
                                endTime: fc.integer({ min: 1000, max: 120000 }),
                                text: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0)
                            }).filter(segment => segment.endTime > segment.startTime + 500),
                            { minLength: 1, maxLength: 3 }
                        )
                    }),
                    async (testData) => {
                        // Set CloudFront environment variable for this test
                        const originalCloudFront = process.env.CloudFront;
                        process.env.CloudFront = testData.cloudFrontDomain;

                        try {
                            // Create event with translated segments
                            const translatedSegments = testData.languages.map(lang => ({
                                translationResult: {
                                    sourceLanguage: 'en',
                                    targetLanguage: lang,
                                    segmentCount: testData.textSegments.length,
                                    status: 'COMPLETED'
                                },
                                translatedSegments: testData.textSegments.map(segment => ({
                                    startTime: segment.startTime,
                                    endTime: segment.endTime,
                                    text: `${segment.text}_${lang}`,
                                    originalText: segment.text
                                }))
                            }));

                            const event = {
                                guid: testData.guid,
                                srcVideo: testData.srcVideo,
                                destBucket: testData.destBucket,
                                translatedSegments: translatedSegments
                            };

                            // Reset mocks
                            s3ClientMock.reset();
                            dynamoDBDocumentClientMock.reset();
                            s3ClientMock.on(PutObjectCommand).resolves({});
                            dynamoDBDocumentClientMock.on(UpdateCommand).resolves({});

                            const result = await lambda.handler(event);

                            // Property: CDN accessibility through expected URL patterns
                            expect(result.webvttFiles).to.be.an('array');
                            expect(result.webvttFiles).to.have.length(testData.languages.length);

                            // Verify each subtitle file has proper CloudFront URL
                            result.webvttFiles.forEach((webvttFile, index) => {
                                const expectedLanguage = testData.languages[index];
                                
                                // Should have CloudFront URL
                                expect(webvttFile).to.have.property('cloudFrontUrl');
                                expect(webvttFile.cloudFrontUrl).to.be.a('string');
                                
                                // CloudFront URL should follow expected pattern
                                const expectedS3Key = webvttFile.s3Key;
                                const expectedCloudFrontUrl = `https://${testData.cloudFrontDomain}/${encodeURIComponent(expectedS3Key).replace(/%2F/g, '/')}`;
                                expect(webvttFile.cloudFrontUrl).to.equal(expectedCloudFrontUrl);
                                
                                // URL should be properly formatted (URL-encoded)
                                expect(webvttFile.cloudFrontUrl).to.match(/^https:\/\/[a-z0-9.-]+\.(cloudfront\.net|amazonaws\.com)\/[a-zA-Z0-9-_%]+\/subtitles\/[^\/]+\.vtt$/);
                                
                                // URL should contain the GUID and language
                                expect(webvttFile.cloudFrontUrl).to.include(testData.guid);
                                expect(webvttFile.cloudFrontUrl).to.include(expectedLanguage);
                                expect(webvttFile.cloudFrontUrl).to.include('.vtt');
                                
                                // URL should not have double slashes (except after protocol)
                                const urlWithoutProtocol = webvttFile.cloudFrontUrl.replace('https://', '');
                                expect(urlWithoutProtocol).to.not.include('//');
                                
                                // URL should be accessible format (no spaces or special chars)
                                expect(webvttFile.cloudFrontUrl).to.not.match(/[<>"{}|\\^`\[\]]/);
                            });

                            // Verify S3 uploads are compatible with CloudFront delivery
                            const s3Calls = s3ClientMock.calls();
                            s3Calls.forEach((call, index) => {
                                const uploadParams = call.args[0].input;
                                
                                // Content-Type should be appropriate for web delivery
                                expect(uploadParams.ContentType).to.equal('text/vtt');
                                
                                // Content-Encoding should be UTF-8 for proper character display
                                expect(uploadParams.ContentEncoding).to.equal('utf-8');
                                
                                // S3 key should be web-safe (spaces should be converted to underscores)
                                expect(uploadParams.Key).to.not.match(/[\s<>"{}|\\^`\[\]]/);
                                
                                // S3 key should follow expected structure for CDN
                                expect(uploadParams.Key).to.match(/^[a-zA-Z0-9-_]+\/subtitles\/[^\/]+\.vtt$/);
                            });

                            // Verify DynamoDB update includes CloudFront URLs
                            const dynamoDBCalls = dynamoDBDocumentClientMock.calls();
                            const updateCalls = dynamoDBCalls.filter(call => call.args[0].input.TableName === process.env.DynamoDBTable);
                            
                            if (updateCalls.length > 0) {
                                const finalUpdate = updateCalls[updateCalls.length - 1];
                                const updateExpression = finalUpdate.args[0].input.UpdateExpression;
                                
                                // Should include CloudFront URLs in database for future reference
                                const hasCloudFrontUrls = Object.keys(finalUpdate.args[0].input.ExpressionAttributeValues).some(key => 
                                    updateExpression.includes('cloudFrontUrls') || 
                                    JSON.stringify(finalUpdate.args[0].input.ExpressionAttributeValues[key]).includes('cloudfront')
                                );
                                expect(hasCloudFrontUrls).to.be.true;
                            }

                        } finally {
                            // Restore original CloudFront environment variable
                            if (originalCloudFront) {
                                process.env.CloudFront = originalCloudFront;
                            } else {
                                delete process.env.CloudFront;
                            }
                        }
                    }
                ),
                { numRuns: 10, timeout: 30000 }
            );
        });
    });
});

/**
 * Helper function to format timestamps for WebVTT (copied from shared utilities for testing)
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} WebVTT formatted timestamp
 */
function formatWebVTTTimestamp(milliseconds) {
    if (typeof milliseconds !== 'number' || milliseconds < 0) {
        throw new Error('Milliseconds must be a non-negative number');
    }
    
    const totalSeconds = Math.floor(milliseconds / 1000);
    const ms = milliseconds % 1000;
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}
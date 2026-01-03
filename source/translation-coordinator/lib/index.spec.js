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
const sinon = require('sinon');
const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const lambda = require('../index.js');

// Mock AWS clients
const s3Mock = mockClient(S3Client);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe('translation-coordinator', () => {
    
    beforeEach(() => {
        // Reset mocks before each test
        s3Mock.reset();
        dynamoMock.reset();
        
        // Set up environment variables
        process.env.DynamoDBTable = 'test-table';
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
    });

    afterEach(() => {
        sinon.restore();
    });
    
    describe('handler', () => {
        
        it('should return event object when subtitle processing is disabled', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://bucket/path/',
                subtitleConfig: { enabled: false }
            };
            
            const result = await lambda.handler(event);
            expect(result).to.deep.equal(event);
        });

        it('should skip translation when no target languages differ from source', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://bucket/path/',
                detectedLanguage: 'en-US',
                subtitleConfig: { 
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['en'] // Same as source
                }
            };

            // Mock DynamoDB update
            dynamoMock.on(UpdateCommand).resolves({});
            
            const result = await lambda.handler(event);
            expect(result.translationTasks).to.be.an('array').that.is.empty;
        });

        it('should create translation tasks for valid target languages', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://test-bucket/test-guid/transcription/',
                detectedLanguage: 'en-US',
                subtitleConfig: { 
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr']
                }
            };

            // Mock S3 response with transcription data
            const mockTranscriptionData = {
                results: {
                    transcripts: [
                        { transcript: "Hello world. This is a test." }
                    ],
                    items: [
                        {
                            type: 'pronunciation',
                            start_time: '0.0',
                            end_time: '1.0',
                            alternatives: [{ content: 'Hello', confidence: 0.99 }]
                        },
                        {
                            type: 'pronunciation',
                            start_time: '1.0',
                            end_time: '2.0',
                            alternatives: [{ content: 'world', confidence: 0.98 }]
                        },
                        {
                            type: 'punctuation',
                            alternatives: [{ content: '.' }]
                        }
                    ]
                }
            };

            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from(JSON.stringify(mockTranscriptionData));
                }
            };

            s3Mock.on(GetObjectCommand).resolves({ Body: mockStream });
            dynamoMock.on(UpdateCommand).resolves({});
            
            const result = await lambda.handler(event);
            
            expect(result.translationTasks).to.be.an('array').with.length(2);
            expect(result.translationTasks[0].sourceLanguage).to.equal('en-US');
            expect(result.translationTasks[0].targetLanguage).to.equal('es');
            expect(result.translationTasks[1].targetLanguage).to.equal('fr');
            expect(result.translationTasks[0].textSegments).to.be.an('array');
        });

        it('should handle missing required parameters', async () => {
            const event = {
                guid: 'test-guid'
                // Missing transcriptionJobName and transcriptionOutputLocation
            };
            
            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (err) {
                expect(err.message).to.include('Missing required parameters');
            }
        });

        it('should handle invalid subtitle configuration', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://bucket/path/',
                subtitleConfig: { 
                    enabled: 'invalid', // Should be boolean
                    targetLanguages: 'not-an-array' // Should be array
                }
            };
            
            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (err) {
                expect(err.message).to.include('Invalid subtitle configuration');
            }
        });

        it('should handle S3 errors when fetching transcription output', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://test-bucket/test-guid/transcription/',
                detectedLanguage: 'en-US',
                subtitleConfig: { 
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es']
                }
            };

            // Mock S3 error
            s3Mock.on(GetObjectCommand).rejects(new Error('S3 access denied'));
            dynamoMock.on(UpdateCommand).resolves({});
            
            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (err) {
                expect(err.message).to.include('Failed to parse transcription output');
            }
        });

        it('should handle empty transcription output', async () => {
            const event = {
                guid: 'test-guid',
                transcriptionJobName: 'test-job',
                transcriptionOutputLocation: 's3://test-bucket/test-guid/transcription/',
                detectedLanguage: 'en-US',
                subtitleConfig: { 
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es']
                }
            };

            // Mock S3 response with empty transcription data
            const mockTranscriptionData = {
                results: {
                    transcripts: [],
                    items: []
                }
            };

            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from(JSON.stringify(mockTranscriptionData));
                }
            };

            s3Mock.on(GetObjectCommand).resolves({ Body: mockStream });
            dynamoMock.on(UpdateCommand).resolves({});
            
            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (err) {
                expect(err.message).to.include('No text segments found');
            }
        });
        
    });
    
});
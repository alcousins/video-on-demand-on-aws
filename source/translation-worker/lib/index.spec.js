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
const { TranslateClient, TranslateTextCommand } = require('@aws-sdk/client-translate');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const lambda = require('../index.js');
const { createTextSegment, createTranslationTask } = require('../../shared/subtitle-types.js');

// Mock AWS clients
const translateMock = mockClient(TranslateClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe('translation-worker', () => {
    
    beforeEach(() => {
        // Reset all mocks
        translateMock.reset();
        dynamoMock.reset();
        
        // Set up environment variables
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
        process.env.DynamoDBTable = 'test-table';
        
        // Mock DynamoDB updates to succeed by default
        dynamoMock.on(UpdateCommand).resolves({});
    });
    
    afterEach(() => {
        sinon.restore();
    });
    
    describe('handler', () => {
        
        it('should successfully translate text segments', async () => {
            // Mock AWS Translate responses
            translateMock.on(TranslateTextCommand).resolves({
                TranslatedText: 'Hola mundo'
            });
            
            const textSegments = [
                createTextSegment(0, 2000, 'Hello world', { confidence: 0.95 })
            ];
            
            const event = createTranslationTask(
                'en',
                'es', 
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.targetLanguage).to.equal('es');
            expect(result.status).to.equal('completed');
            expect(result.translatedSegments).to.have.length(1);
            expect(result.translatedSegments[0].text).to.equal('Hola mundo');
            expect(result.translatedSegments[0].startTime).to.equal(0);
            expect(result.translatedSegments[0].endTime).to.equal(2000);
            expect(result.processingTimeMs).to.be.a('number');
        });
        
        it('should handle translation errors gracefully', async () => {
            // Mock AWS Translate to throw an error
            translateMock.on(TranslateTextCommand).rejects(new Error('Translation service unavailable'));
            
            const textSegments = [
                createTextSegment(0, 2000, 'Hello world')
            ];
            
            const event = createTranslationTask(
                'en',
                'es',
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.targetLanguage).to.equal('es');
            expect(result.status).to.equal('partial_success'); // Translation failed, fallback created
            expect(result.translatedSegments).to.have.length(1); // Fallback segment included
            expect(result.translatedSegments[0].text).to.equal('Hello world'); // Original text as fallback
            expect(result.translatedSegments[0].translationFailed).to.be.true;
        });
        
        it('should preserve timing information during translation', async () => {
            translateMock.on(TranslateTextCommand).resolves({
                TranslatedText: 'Texto traducido'
            });
            
            const textSegments = [
                createTextSegment(1500, 4500, 'Original text', { 
                    confidence: 0.9,
                    speaker: 'Speaker1'
                })
            ];
            
            const event = createTranslationTask(
                'en',
                'es',
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.status).to.equal('completed');
            expect(result.translatedSegments[0].startTime).to.equal(1500);
            expect(result.translatedSegments[0].endTime).to.equal(4500);
            expect(result.translatedSegments[0].confidence).to.equal(0.9);
            expect(result.translatedSegments[0].speaker).to.equal('Speaker1');
        });
        
        it('should handle unsupported language pairs', async () => {
            const textSegments = [
                createTextSegment(0, 2000, 'Hello world')
            ];
            
            const event = createTranslationTask(
                'unsupported-lang',
                'es',
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.status).to.equal('failed');
            expect(result.errorMessage).to.include('Unsupported language pair');
            expect(result.translatedSegments).to.have.length(0);
        });
        
        it('should process multiple segments in batches', async () => {
            // Mock multiple translation calls
            translateMock.on(TranslateTextCommand)
                .resolvesOnce({ TranslatedText: 'Primer segmento' })
                .resolvesOnce({ TranslatedText: 'Segundo segmento' })
                .resolvesOnce({ TranslatedText: 'Tercer segmento' });
            
            const textSegments = [
                createTextSegment(0, 2000, 'First segment'),
                createTextSegment(2000, 4000, 'Second segment'),
                createTextSegment(4000, 6000, 'Third segment')
            ];
            
            const event = createTranslationTask(
                'en',
                'es',
                textSegments,
                'test-job-123',
                { 
                    guid: 'test-guid-456',
                    batchConfig: { batchSize: 2, batchDelay: 10 }
                }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.status).to.equal('completed');
            expect(result.translatedSegments).to.have.length(3);
            expect(result.translatedSegments[0].text).to.equal('Primer segmento');
            expect(result.translatedSegments[1].text).to.equal('Segundo segmento');
            expect(result.translatedSegments[2].text).to.equal('Tercer segmento');
        });
        
        it('should handle partial translation failures', async () => {
            // Mock some successful and some failed translations
            translateMock.on(TranslateTextCommand)
                .resolvesOnce({ TranslatedText: 'Primer segmento' })
                .rejectsOnce(new Error('Translation failed'))
                .resolvesOnce({ TranslatedText: 'Tercer segmento' });
            
            const textSegments = [
                createTextSegment(0, 2000, 'First segment'),
                createTextSegment(2000, 4000, 'Second segment'),
                createTextSegment(4000, 6000, 'Third segment')
            ];
            
            const event = createTranslationTask(
                'en',
                'es',
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.status).to.equal('partial_success'); // Some segments failed
            expect(result.translatedSegments).to.have.length(3); // Includes fallback for failed segment
            expect(result.translatedSegments[0].text).to.equal('Primer segmento');
            expect(result.translatedSegments[1].text).to.equal('Second segment'); // Fallback to original
            expect(result.translatedSegments[1].translationFailed).to.be.true;
            expect(result.translatedSegments[2].text).to.equal('Tercer segmento');
        });
        
        it('should validate input translation task', async () => {
            const invalidEvent = {
                // Missing required fields
                sourceLanguage: 'en'
            };
            
            const result = await lambda.handler(invalidEvent);
            
            expect(result.status).to.equal('failed');
            expect(result.errorMessage).to.include('Invalid translation task input');
        });
        
        it('should handle empty text segments', async () => {
            const textSegments = [
                createTextSegment(0, 2000, ''), // Empty text
                createTextSegment(2000, 4000, '   '), // Whitespace only
                createTextSegment(4000, 6000, 'Valid text')
            ];
            
            translateMock.on(TranslateTextCommand).resolves({
                TranslatedText: 'Texto válido'
            });
            
            const event = createTranslationTask(
                'en',
                'es',
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            const result = await lambda.handler(event);
            
            expect(result.status).to.equal('partial_success'); // Some segments failed (empty ones)
            expect(result.translatedSegments).to.have.length(3); // All segments included (with fallbacks)
            expect(result.translatedSegments[0].text).to.equal(''); // Empty fallback
            expect(result.translatedSegments[0].translationFailed).to.be.true;
            expect(result.translatedSegments[1].text).to.equal('   '); // Whitespace fallback
            expect(result.translatedSegments[1].translationFailed).to.be.true;
            expect(result.translatedSegments[2].text).to.equal('Texto válido'); // Successfully translated
            expect(result.translatedSegments[2].translationFailed).to.be.undefined; // No failure flag for successful translation
        });
        
        it('should update DynamoDB with processing status', async () => {
            translateMock.on(TranslateTextCommand).resolves({
                TranslatedText: 'Texto traducido'
            });
            
            const textSegments = [
                createTextSegment(0, 2000, 'Test text')
            ];
            
            const event = createTranslationTask(
                'en',
                'es',
                textSegments,
                'test-job-123',
                { guid: 'test-guid-456' }
            );
            
            await lambda.handler(event);
            
            // Verify DynamoDB was called to update status
            expect(dynamoMock.commandCalls(UpdateCommand)).to.have.length.greaterThan(0);
            
            const updateCalls = dynamoMock.commandCalls(UpdateCommand);
            const finalUpdate = updateCalls[updateCalls.length - 1];
            
            expect(finalUpdate.args[0].input.Key.guid).to.equal('test-guid-456');
            expect(finalUpdate.args[0].input.UpdateExpression).to.include('subtitleTranslationWorker_es_status');
        });
        
    });
    
});
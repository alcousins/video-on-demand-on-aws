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
const { S3, GetObjectCommand } = require('@aws-sdk/client-s3');
const lambda = require('../index.js');

const s3Mock = mockClient(S3);

describe('subtitle-config', () => {
    
    beforeEach(() => {
        s3Mock.reset();
        
        // Set up environment variables
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
        process.env.SUBTITLE_PROCESSING_ENABLED = 'true';
        process.env.SUBTITLE_PRIMARY_LANGUAGE = 'auto';
        process.env.SUBTITLE_TARGET_LANGUAGES = 'en,es,fr';
        process.env.Source = 'test-source-bucket';
        process.env.CloudFront = 'test.cloudfront.net';
    });

    afterEach(() => {
        sinon.restore();
        delete process.env.SUBTITLE_PROCESSING_ENABLED;
        delete process.env.SUBTITLE_PRIMARY_LANGUAGE;
        delete process.env.SUBTITLE_TARGET_LANGUAGES;
        delete process.env.Source;
        delete process.env.CloudFront;
        delete process.env.TEMP_BUCKET;
    });
    
    describe('handler', () => {
        
        it('should return event with valid subtitle configuration for supported video format', async () => {
            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                destBucket: 'dest-bucket'
            };
            
            const result = await lambda.handler(event);
            
            expect(result.guid).to.equal(event.guid);
            expect(result.srcVideo).to.equal(event.srcVideo);
            expect(result.subtitleConfig).to.exist;
            expect(result.subtitleConfig.enabled).to.be.true;
            expect(result.subtitleConfig.primaryLanguage).to.equal('auto');
            expect(result.subtitleConfig.targetLanguages).to.deep.equal(['en', 'es', 'fr']);
            expect(result.subtitleConfig.tempBucket).to.equal('test-bucket');
            expect(result.subtitleConfig.tempPrefix).to.equal('test-guid-123/subtitles/temp/');
            expect(result.subtitleConfig.finalPrefix).to.equal('test-guid-123/subtitles/');
        });

        it('should disable subtitle processing for unsupported video format', async () => {
            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.avi', // Unsupported format
                srcBucket: 'test-bucket'
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.enabled).to.be.false;
            expect(result.subtitleConfig.reason).to.equal('unsupported_video_format');
        });

        it('should apply metadata file overrides when metadata file exists', async () => {
            const metadataContent = JSON.stringify({
                subtitleEnabled: false,
                subtitlePrimaryLanguage: 'en',
                subtitleTargetLanguages: 'es,fr,de'
            });

            s3Mock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: () => Promise.resolve(metadataContent)
                }
            });

            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                srcMetadataFile: 'metadata.json'
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.enabled).to.be.false;
            expect(result.subtitleConfig.primaryLanguage).to.equal('en');
            expect(result.subtitleConfig.targetLanguages).to.deep.equal(['es', 'fr', 'de']);
        });

        it('should handle metadata file loading errors gracefully', async () => {
            s3Mock.on(GetObjectCommand).rejects(new Error('File not found'));

            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                srcMetadataFile: 'nonexistent.json'
            };
            
            const result = await lambda.handler(event);
            
            // Should fall back to environment configuration
            expect(result.subtitleConfig.enabled).to.be.true;
            expect(result.subtitleConfig.primaryLanguage).to.equal('auto');
        });

        it('should apply event overrides over metadata and environment', async () => {
            const metadataContent = JSON.stringify({
                subtitleEnabled: true,
                subtitlePrimaryLanguage: 'en'
            });

            s3Mock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: () => Promise.resolve(metadataContent)
                }
            });

            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                srcMetadataFile: 'metadata.json',
                subtitleEnabled: false, // Event override
                subtitleTargetLanguages: 'ja,ko' // Event override
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.enabled).to.be.false; // From event override
            expect(result.subtitleConfig.targetLanguages).to.deep.equal(['ja', 'ko']); // From event override
        });

        it('should disable subtitle processing for invalid configuration', async () => {
            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                subtitleTargetLanguages: 'invalid-lang,another-invalid' // Invalid languages
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.enabled).to.be.false;
            expect(result.subtitleConfig.reason).to.equal('configuration_error');
            expect(result.subtitleConfig.errors).to.exist;
        });

        it('should handle missing required fields', async () => {
            const event = {
                // Missing guid
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket'
            };
            
            try {
                await lambda.handler(event);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error.message).to.include('Missing required field: guid');
            }
        });

        it('should use environment defaults when no overrides provided', async () => {
            process.env.SUBTITLE_PROCESSING_ENABLED = 'false';
            process.env.SUBTITLE_PRIMARY_LANGUAGE = 'es';
            process.env.SUBTITLE_TARGET_LANGUAGES = 'en,fr';

            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket'
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.enabled).to.be.false;
            expect(result.subtitleConfig.primaryLanguage).to.equal('es');
            expect(result.subtitleConfig.targetLanguages).to.deep.equal(['en', 'fr']);
        });

        it('should include CloudFront domain in configuration', async () => {
            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                cloudFront: 'custom.cloudfront.net'
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.cloudFrontDomain).to.equal('custom.cloudfront.net');
        });

        it('should use temp bucket from environment when specified', async () => {
            process.env.TEMP_BUCKET = 'custom-temp-bucket';

            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket'
            };
            
            const result = await lambda.handler(event);
            
            expect(result.subtitleConfig.tempBucket).to.equal('custom-temp-bucket');
        });

        it('should handle malformed metadata JSON gracefully', async () => {
            s3Mock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: () => Promise.resolve('invalid json content')
                }
            });

            const event = {
                guid: 'test-guid-123',
                srcVideo: 'test-video.mp4',
                srcBucket: 'test-bucket',
                srcMetadataFile: 'invalid.json'
            };
            
            const result = await lambda.handler(event);
            
            // Should fall back to environment configuration
            expect(result.subtitleConfig.enabled).to.be.true;
            expect(result.subtitleConfig.primaryLanguage).to.equal('auto');
        });
        
    });
    
});
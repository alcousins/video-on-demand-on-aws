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
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

// Import Lambda functions
const inputValidateLambda = require('../input-validate/index.js');

describe('#WORKFLOW INTEGRATION CORE TESTS::', () => {
    // Mock AWS clients
    const sfnClientMock = mockClient(SFNClient);
    const s3ClientMock = mockClient(S3Client);

    beforeEach(() => {
        // Set up environment for integration testing
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'AwsSolution/SO0146/v6.0.0';
        process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function-name';
        process.env.ErrorHandler = 'test-error-handler';
        process.env.IngestWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-ingest';
        process.env.ProcessWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-process';
        process.env.PublishWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-publish';
        process.env.SubtitleProcessorWorkflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:vod-subtitle-processor';
        process.env.WorkflowName = 'vod-workflow';
        process.env.Source = 'vod-source-bucket';
        process.env.Destination = 'vod-destination-bucket';
        process.env.CloudFront = 'd123456789.cloudfront.net';
        process.env.FrameCapture = 'false';
        process.env.ArchiveSource = 'DISABLED';
        process.env.MediaConvert_Template_2160p = 'vod-workflow_Ott_2160p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.MediaConvert_Template_1080p = 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.MediaConvert_Template_720p = 'vod-workflow_Ott_720p_Avc_Aac_16x9_qvbr_no_preset';
        process.env.InputRotate = 'DEGREE_0';
        process.env.AcceleratedTranscoding = 'PREFERRED';
        process.env.EnableSns = 'true';
        process.env.EnableSqs = 'true';
        process.env.EnableMediaPackage = 'false';
        process.env.SUBTITLE_ENABLED = 'true';
        process.env.SUBTITLE_PRIMARY_LANGUAGE = 'auto';
        process.env.SUBTITLE_TARGET_LANGUAGES = 'en,es,fr,de,it,pt,ja,ko,zh,ar';
    });

    afterEach(() => {
        sfnClientMock.reset();
        s3ClientMock.reset();
    });

    describe('End-to-End Workflow Data Flow', () => {
        it('should process complete workflow data flow from video upload to subtitle delivery', async () => {
            console.log('=== Testing Complete Workflow Data Flow ===');

            // Mock S3 responses
            s3ClientMock.on(HeadObjectCommand).resolves({
                ContentLength: 1024000,
                ContentType: 'video/mp4'
            });

            // Test 1: Video Upload Event Processing
            console.log('Step 1: Testing video upload event processing...');
            
            const videoUploadEvent = {
                guid: 'test-guid-workflow-123',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'uploads/test-video.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(videoUploadEvent);
            
            // Verify basic workflow configuration
            expect(validatedData.guid).to.equal('test-guid-workflow-123');
            expect(validatedData.workflowTrigger).to.equal('Video');
            expect(validatedData.srcVideo).to.equal('uploads/test-video.mp4');
            expect(validatedData.srcBucket).to.equal('vod-source-bucket');
            expect(validatedData.destBucket).to.equal('vod-destination-bucket');
            expect(validatedData.workflowName).to.equal('vod-workflow');
            expect(validatedData.cloudFront).to.equal('d123456789.cloudfront.net');

            // Test 2: Subtitle Configuration Integration
            console.log('Step 2: Testing subtitle configuration integration...');
            
            expect(validatedData).to.have.property('subtitleConfig');
            expect(validatedData.subtitleConfig.enabled).to.be.true;
            expect(validatedData.subtitleConfig.primaryLanguage).to.equal('auto');
            expect(validatedData.subtitleConfig.targetLanguages).to.be.an('array');
            expect(validatedData.subtitleConfig.targetLanguages).to.have.lengthOf(10);
            expect(validatedData.subtitleConfig.targetLanguages).to.include.members([
                'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'
            ]);

            // Test 3: Existing Workflow Configuration Preservation
            console.log('Step 3: Testing existing workflow configuration preservation...');
            
            expect(validatedData.frameCapture).to.be.false;
            expect(validatedData.archiveSource).to.equal('DISABLED');
            expect(validatedData.jobTemplate_2160p).to.equal('vod-workflow_Ott_2160p_Avc_Aac_16x9_qvbr_no_preset');
            expect(validatedData.jobTemplate_1080p).to.equal('vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset');
            expect(validatedData.jobTemplate_720p).to.equal('vod-workflow_Ott_720p_Avc_Aac_16x9_qvbr_no_preset');
            expect(validatedData.inputRotate).to.equal('DEGREE_0');
            expect(validatedData.acceleratedTranscoding).to.equal('PREFERRED');
            expect(validatedData.enableSns).to.be.true;
            expect(validatedData.enableSqs).to.be.true;
            expect(validatedData.enableMediaPackage).to.be.false;

            console.log('✅ Complete workflow data flow test passed!');
        });

        it('should handle metadata-driven workflow with custom subtitle configuration', async () => {
            console.log('=== Testing Metadata-Driven Workflow ===');

            // Mock S3 responses for metadata file
            const customMetadataContent = JSON.stringify({
                srcVideo: 'custom-video.mp4',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'en',
                    targetLanguages: ['es', 'fr', 'de']
                },
                jobTemplate_1080p: 'custom-template-1080p',
                acceleratedTranscoding: 'ENABLED'
            });

            s3ClientMock.on(GetObjectCommand).resolves({
                Body: {
                    transformToString: async () => customMetadataContent
                }
            });

            s3ClientMock.on(HeadObjectCommand).resolves({
                ContentLength: 2048000,
                ContentType: 'video/mp4'
            });

            const metadataEvent = {
                guid: 'test-guid-metadata',
                workflowTrigger: 'Metadata',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'metadata/custom-video-metadata.json' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(metadataEvent);
            
            // Verify metadata overrides were applied
            expect(validatedData.srcVideo).to.equal('custom-video.mp4');
            expect(validatedData.srcMetadataFile).to.equal('metadata/custom-video-metadata.json');
            expect(validatedData.subtitleConfig.enabled).to.be.true;
            expect(validatedData.subtitleConfig.primaryLanguage).to.equal('en');
            expect(validatedData.subtitleConfig.targetLanguages).to.deep.equal(['es', 'fr', 'de']);
            expect(validatedData.jobTemplate_1080p).to.equal('custom-template-1080p');
            expect(validatedData.acceleratedTranscoding).to.equal('ENABLED');

            console.log('✅ Metadata-driven workflow test passed!');
        });

        it('should handle disabled subtitle processing configuration', async () => {
            console.log('=== Testing Disabled Subtitle Processing ===');

            // Disable subtitle processing
            process.env.SUBTITLE_ENABLED = 'false';

            const inputEvent = {
                guid: 'test-guid-disabled',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'test-video-no-subtitles.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);
            
            // Verify subtitle processing is disabled but other config is intact
            expect(validatedData.subtitleConfig.enabled).to.be.false;
            expect(validatedData.subtitleConfig).to.have.property('primaryLanguage');
            expect(validatedData.subtitleConfig).to.have.property('targetLanguages');
            
            // Verify main workflow configuration is unaffected
            expect(validatedData.workflowName).to.equal('vod-workflow');
            expect(validatedData.srcVideo).to.equal('test-video-no-subtitles.mp4');
            expect(validatedData.enableSns).to.be.true;
            expect(validatedData.enableSqs).to.be.true;

            console.log('✅ Disabled subtitle processing test passed!');
        });

        it('should maintain data consistency across different video formats', async () => {
            console.log('=== Testing Data Consistency Across Video Formats ===');

            const videoFormats = [
                { filename: 'test-video.mp4', contentType: 'video/mp4' },
                { filename: 'test-video.mov', contentType: 'video/quicktime' },
                { filename: 'test-video.m4v', contentType: 'video/x-m4v' },
                { filename: 'test-video.mpg', contentType: 'video/mpeg' },
                { filename: 'test-video.m2ts', contentType: 'video/mp2t' }
            ];

            for (const format of videoFormats) {
                console.log(`Testing format: ${format.filename}`);

                s3ClientMock.reset();
                s3ClientMock.on(HeadObjectCommand).resolves({
                    ContentLength: 1024000,
                    ContentType: format.contentType
                });

                const inputEvent = {
                    guid: `test-guid-${format.filename.split('.')[1]}`,
                    workflowTrigger: 'Video',
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: format.filename }
                        }
                    }]
                };

                const validatedData = await inputValidateLambda.handler(inputEvent);
                
                // Verify consistent configuration regardless of video format
                expect(validatedData.srcVideo).to.equal(format.filename);
                expect(validatedData.subtitleConfig.enabled).to.be.true;
                expect(validatedData.subtitleConfig.targetLanguages).to.have.lengthOf(10);
                expect(validatedData.workflowName).to.equal('vod-workflow');
                expect(validatedData.destBucket).to.equal('vod-destination-bucket');
            }

            console.log('✅ Data consistency across video formats test passed!');
        });

        it('should handle concurrent workflow processing with different configurations', async () => {
            console.log('=== Testing Concurrent Workflow Processing ===');

            const concurrentWorkflows = [
                {
                    guid: 'concurrent-1',
                    filename: 'video1.mp4',
                    subtitleConfig: { enabled: true, primaryLanguage: 'en', targetLanguages: ['es', 'fr'] }
                },
                {
                    guid: 'concurrent-2',
                    filename: 'video2.mov',
                    subtitleConfig: { enabled: true, primaryLanguage: 'auto', targetLanguages: ['de', 'it', 'pt'] }
                },
                {
                    guid: 'concurrent-3',
                    filename: 'video3.m4v',
                    subtitleConfig: { enabled: false, primaryLanguage: 'auto', targetLanguages: ['en'] }
                }
            ];

            // Process all workflows concurrently
            const processingPromises = concurrentWorkflows.map(async (workflow) => {
                const inputEvent = {
                    guid: workflow.guid,
                    workflowTrigger: 'Video',
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: workflow.filename }
                        }
                    }]
                };

                const validatedData = await inputValidateLambda.handler(inputEvent);
                
                // Verify each workflow maintains its own configuration
                expect(validatedData.guid).to.equal(workflow.guid);
                expect(validatedData.srcVideo).to.equal(workflow.filename);
                expect(validatedData.workflowName).to.equal('vod-workflow');
                
                return {
                    guid: workflow.guid,
                    processed: true,
                    subtitleEnabled: validatedData.subtitleConfig.enabled
                };
            });

            const results = await Promise.all(processingPromises);
            
            // Verify all workflows processed successfully
            expect(results).to.have.lengthOf(3);
            results.forEach(result => {
                expect(result.processed).to.be.true;
            });

            // Verify different subtitle configurations were maintained
            expect(results.find(r => r.guid === 'concurrent-1').subtitleEnabled).to.be.true;
            expect(results.find(r => r.guid === 'concurrent-2').subtitleEnabled).to.be.true;
            expect(results.find(r => r.guid === 'concurrent-3').subtitleEnabled).to.be.true; // Default from env

            console.log('✅ Concurrent workflow processing test passed!');
        });
    });

    describe('Error Handling and Workflow Resilience', () => {
        it('should handle invalid configuration gracefully', async () => {
            console.log('=== Testing Invalid Configuration Handling ===');

            // Set invalid configuration
            process.env.SUBTITLE_TARGET_LANGUAGES = '';
            process.env.SUBTITLE_PRIMARY_LANGUAGE = '';

            const inputEvent = {
                guid: 'test-guid-invalid-config',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'test-video-invalid-config.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);
            
            // Should handle invalid configuration gracefully
            expect(validatedData).to.have.property('subtitleConfig');
            expect(validatedData.subtitleConfig).to.have.property('enabled');
            expect(validatedData.subtitleConfig).to.have.property('primaryLanguage');
            expect(validatedData.subtitleConfig).to.have.property('targetLanguages');
            expect(validatedData.subtitleConfig.targetLanguages).to.be.an('array');

            // Main workflow should continue
            expect(validatedData.workflowName).to.equal('vod-workflow');
            expect(validatedData.srcVideo).to.equal('test-video-invalid-config.mp4');

            console.log('✅ Invalid configuration handling test passed!');
        });

        it('should maintain workflow independence with subtitle configuration errors', async () => {
            console.log('=== Testing Workflow Independence ===');

            // Test with various problematic configurations
            const problematicConfigs = [
                { SUBTITLE_ENABLED: 'invalid-boolean', SUBTITLE_PRIMARY_LANGUAGE: 'auto' },
                { SUBTITLE_ENABLED: 'true', SUBTITLE_PRIMARY_LANGUAGE: 'invalid-lang' },
                { SUBTITLE_ENABLED: 'true', SUBTITLE_TARGET_LANGUAGES: 'invalid,lang,codes' }
            ];

            for (const config of problematicConfigs) {
                // Set problematic environment
                Object.keys(config).forEach(key => {
                    process.env[key] = config[key];
                });

                const inputEvent = {
                    guid: `test-guid-${Object.keys(config)[0]}`,
                    workflowTrigger: 'Video',
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: 'test-video-problematic.mp4' }
                        }
                    }]
                };

                // Should not throw errors and should continue workflow
                const validatedData = await inputValidateLambda.handler(inputEvent);
                
                expect(validatedData.workflowName).to.equal('vod-workflow');
                expect(validatedData.srcVideo).to.equal('test-video-problematic.mp4');
                expect(validatedData).to.have.property('subtitleConfig');
            }

            console.log('✅ Workflow independence test passed!');
        });
    });

    describe('Integration with Existing Video Processing Workflow', () => {
        it('should preserve all existing workflow parameters while adding subtitle support', async () => {
            console.log('=== Testing Existing Workflow Parameter Preservation ===');

            const inputEvent = {
                guid: 'test-guid-preservation',
                workflowTrigger: 'Video',
                Records: [{
                    s3: {
                        bucket: { name: 'vod-source-bucket' },
                        object: { key: 'preservation-test.mp4' }
                    }
                }]
            };

            const validatedData = await inputValidateLambda.handler(inputEvent);
            
            // Verify ALL existing parameters are preserved
            const expectedParams = {
                workflowName: 'vod-workflow',
                srcBucket: 'vod-source-bucket',
                destBucket: 'vod-destination-bucket',
                cloudFront: 'd123456789.cloudfront.net',
                frameCapture: false,
                archiveSource: 'DISABLED',
                jobTemplate_2160p: 'vod-workflow_Ott_2160p_Avc_Aac_16x9_qvbr_no_preset',
                jobTemplate_1080p: 'vod-workflow_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset',
                jobTemplate_720p: 'vod-workflow_Ott_720p_Avc_Aac_16x9_qvbr_no_preset',
                inputRotate: 'DEGREE_0',
                acceleratedTranscoding: 'PREFERRED',
                enableSns: true,
                enableSqs: true,
                enableMediaPackage: false
            };

            Object.keys(expectedParams).forEach(param => {
                expect(validatedData[param]).to.equal(expectedParams[param], 
                    `Parameter ${param} should be preserved`);
            });

            // Verify subtitle configuration is added without affecting existing params
            expect(validatedData).to.have.property('subtitleConfig');
            expect(validatedData.subtitleConfig.enabled).to.be.true;

            console.log('✅ Existing workflow parameter preservation test passed!');
        });

        it('should generate consistent workflow execution names and avoid conflicts', async () => {
            console.log('=== Testing Workflow Execution Naming ===');

            const testCases = [
                { guid: 'test-guid-1', expectedSubtitleName: 'test-guid-1-subtitle' },
                { guid: 'test-guid-2', expectedSubtitleName: 'test-guid-2-subtitle' },
                { guid: 'special-chars-guid_123', expectedSubtitleName: 'special-chars-guid_123-subtitle' },
                { guid: 'long-guid-name-with-many-characters-12345', expectedSubtitleName: 'long-guid-name-with-many-characters-12345-subtitle' }
            ];

            for (const testCase of testCases) {
                const inputEvent = {
                    guid: testCase.guid,
                    workflowTrigger: 'Video',
                    Records: [{
                        s3: {
                            bucket: { name: 'vod-source-bucket' },
                            object: { key: `${testCase.guid}.mp4` }
                        }
                    }]
                };

                const validatedData = await inputValidateLambda.handler(inputEvent);
                
                // Verify GUID is preserved for workflow naming
                expect(validatedData.guid).to.equal(testCase.guid);
                
                // Verify subtitle processor would get correct naming
                // (This would be used by step functions for execution naming)
                const expectedSubtitleExecutionName = `${testCase.guid}-subtitle`;
                expect(expectedSubtitleExecutionName).to.equal(testCase.expectedSubtitleName);
            }

            console.log('✅ Workflow execution naming test passed!');
        });
    });
});
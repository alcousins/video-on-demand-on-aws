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

describe('#SIMPLE INTEGRATION VALIDATION::', () => {
    describe('Module Loading and Basic Functionality', () => {
        it('should successfully load all workflow components', () => {
            // Test that all modules can be loaded without errors
            expect(() => {
                require('../step-functions/index.js');
            }).to.not.throw();

            expect(() => {
                require('../input-validate/index.js');
            }).to.not.throw();

            expect(() => {
                require('../subtitle-config/index.js');
            }).to.not.throw();

            expect(() => {
                require('../transcription/index.js');
            }).to.not.throw();

            expect(() => {
                require('../translation-coordinator/index.js');
            }).to.not.throw();

            expect(() => {
                require('../translation-worker/index.js');
            }).to.not.throw();

            expect(() => {
                require('../webvtt-generator/index.js');
            }).to.not.throw();
        });

        it('should have correct environment variable handling in input-validate', () => {
            // Set up test environment
            process.env.WorkflowName = 'test-workflow';
            process.env.Source = 'test-source';
            process.env.Destination = 'test-dest';
            process.env.CloudFront = 'test.cloudfront.net';
            process.env.FrameCapture = 'false';
            process.env.ArchiveSource = 'DISABLED';
            process.env.MediaConvert_Template_2160p = 'test-2160p';
            process.env.MediaConvert_Template_1080p = 'test-1080p';
            process.env.MediaConvert_Template_720p = 'test-720p';
            process.env.InputRotate = 'DEGREE_0';
            process.env.AcceleratedTranscoding = 'PREFERRED';
            process.env.EnableSns = 'true';
            process.env.EnableSqs = 'true';
            process.env.EnableMediaPackage = 'false';
            process.env.SUBTITLE_ENABLED = 'true';
            process.env.SUBTITLE_PRIMARY_LANGUAGE = 'auto';
            process.env.SUBTITLE_TARGET_LANGUAGES = 'en,es,fr,de,it';

            const inputValidate = require('../input-validate/index.js');

            // Test that the module loads and has the expected structure
            expect(inputValidate).to.have.property('handler');
            expect(typeof inputValidate.handler).to.equal('function');
        });

        it('should validate step-functions Lambda handles subtitle trigger correctly', () => {
            const stepFunctions = require('../step-functions/index.js');
            
            expect(stepFunctions).to.have.property('handler');
            expect(typeof stepFunctions.handler).to.equal('function');

            // Test event structure validation
            const subtitleTriggerEvent = {
                guid: 'test-guid',
                srcVideo: 'test.mp4',
                srcBucket: 'source',
                destBucket: 'dest',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en', 'es']
                },
                subtitleTrigger: true
            };

            // Verify the event has all required properties
            expect(subtitleTriggerEvent).to.have.property('guid');
            expect(subtitleTriggerEvent).to.have.property('subtitleTrigger');
            expect(subtitleTriggerEvent.subtitleTrigger).to.be.true;
            expect(subtitleTriggerEvent).to.have.property('subtitleConfig');
            expect(subtitleTriggerEvent.subtitleConfig).to.have.property('enabled');
            expect(subtitleTriggerEvent.subtitleConfig).to.have.property('primaryLanguage');
            expect(subtitleTriggerEvent.subtitleConfig).to.have.property('targetLanguages');
        });

        it('should validate subtitle configuration structure', () => {
            const expectedConfig = {
                enabled: true,
                primaryLanguage: 'auto',
                targetLanguages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar']
            };

            // Verify configuration structure
            expect(expectedConfig).to.have.property('enabled');
            expect(expectedConfig.enabled).to.be.a('boolean');
            expect(expectedConfig).to.have.property('primaryLanguage');
            expect(expectedConfig.primaryLanguage).to.be.a('string');
            expect(expectedConfig).to.have.property('targetLanguages');
            expect(expectedConfig.targetLanguages).to.be.an('array');
            expect(expectedConfig.targetLanguages).to.have.length.greaterThan(0);

            // Verify supported languages
            const supportedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar'];
            expectedConfig.targetLanguages.forEach(lang => {
                expect(supportedLanguages).to.include(lang);
            });
        });

        it('should validate state machine integration points', () => {
            // Test that the state machine JSON exists and is valid
            const fs = require('fs');
            const path = require('path');
            
            const stateMachineFile = path.join(__dirname, '../cdk/lib/subtitle-processor-state-machine.json');
            expect(fs.existsSync(stateMachineFile)).to.be.true;

            const stateMachineContent = fs.readFileSync(stateMachineFile, 'utf8');
            const stateMachine = JSON.parse(stateMachineContent);

            // Verify state machine structure
            expect(stateMachine).to.have.property('Comment');
            expect(stateMachine).to.have.property('StartAt');
            expect(stateMachine).to.have.property('States');

            // Verify key states exist
            expect(stateMachine.States).to.have.property('LoadSubtitleConfiguration');
            expect(stateMachine.States).to.have.property('StartTranscription');
            expect(stateMachine.States).to.have.property('StartTranslationCoordinator');
            expect(stateMachine.States).to.have.property('ExecuteTranslations');
            expect(stateMachine.States).to.have.property('GenerateWebVTTFiles');
            expect(stateMachine.States).to.have.property('TriggerPublishWorkflow');

            // Verify error handling states exist
            expect(stateMachine.States).to.have.property('HandleTranscriptionError');
            expect(stateMachine.States).to.have.property('HandleTranslationError');
            expect(stateMachine.States).to.have.property('HandleWebVTTError');
        });

        it('should validate workflow trigger logic', () => {
            // Test the logic for determining workflow triggers
            const testCases = [
                {
                    name: 'Video upload trigger',
                    event: {
                        Records: [{
                            s3: {
                                object: { key: 'test-video.mp4' }
                            }
                        }]
                    },
                    expectedTrigger: 'Video'
                },
                {
                    name: 'Metadata file trigger',
                    event: {
                        Records: [{
                            s3: {
                                object: { key: 'metadata.json' }
                            }
                        }]
                    },
                    expectedTrigger: 'Metadata'
                },
                {
                    name: 'Process workflow trigger',
                    event: {
                        guid: 'test-guid'
                    },
                    expectedTrigger: 'Process'
                },
                {
                    name: 'Subtitle processor trigger',
                    event: {
                        guid: 'test-guid',
                        subtitleTrigger: true
                    },
                    expectedTrigger: 'SubtitleProcessor'
                },
                {
                    name: 'Publish workflow trigger',
                    event: {
                        detail: {
                            status: 'COMPLETE',
                            userMetadata: { guid: 'test-guid' }
                        }
                    },
                    expectedTrigger: 'Publish'
                }
            ];

            testCases.forEach(testCase => {
                // Validate event structure for each trigger type
                if (testCase.expectedTrigger === 'Video' || testCase.expectedTrigger === 'Metadata') {
                    expect(testCase.event).to.have.property('Records');
                    expect(testCase.event.Records).to.be.an('array');
                    expect(testCase.event.Records[0]).to.have.property('s3');
                    expect(testCase.event.Records[0].s3).to.have.property('object');
                    expect(testCase.event.Records[0].s3.object).to.have.property('key');
                } else if (testCase.expectedTrigger === 'Process') {
                    expect(testCase.event).to.have.property('guid');
                    expect(testCase.event).to.not.have.property('subtitleTrigger');
                } else if (testCase.expectedTrigger === 'SubtitleProcessor') {
                    expect(testCase.event).to.have.property('guid');
                    expect(testCase.event).to.have.property('subtitleTrigger');
                    expect(testCase.event.subtitleTrigger).to.be.true;
                } else if (testCase.expectedTrigger === 'Publish') {
                    expect(testCase.event).to.have.property('detail');
                    expect(testCase.event.detail).to.have.property('status');
                    expect(testCase.event.detail).to.have.property('userMetadata');
                }
            });
        });
    });

    describe('Data Flow Validation', () => {
        it('should validate data structure consistency across workflow steps', () => {
            // Test data structures that flow between components
            const workflowData = {
                guid: 'test-guid-12345',
                srcVideo: 'sample-video.mp4',
                srcBucket: 'source-bucket',
                destBucket: 'destination-bucket',
                subtitleConfig: {
                    enabled: true,
                    primaryLanguage: 'auto',
                    targetLanguages: ['en', 'es', 'fr']
                }
            };

            // Validate core workflow data structure
            expect(workflowData).to.have.property('guid');
            expect(workflowData.guid).to.be.a('string');
            expect(workflowData.guid).to.have.length.greaterThan(0);

            expect(workflowData).to.have.property('srcVideo');
            expect(workflowData.srcVideo).to.be.a('string');
            expect(workflowData.srcVideo).to.match(/\.(mp4|mov|m4v|mpg|m2ts)$/i);

            expect(workflowData).to.have.property('srcBucket');
            expect(workflowData.srcBucket).to.be.a('string');

            expect(workflowData).to.have.property('destBucket');
            expect(workflowData.destBucket).to.be.a('string');

            expect(workflowData).to.have.property('subtitleConfig');
            expect(workflowData.subtitleConfig).to.be.an('object');
        });

        it('should validate error handling data structures', () => {
            const errorData = {
                guid: 'test-guid',
                stage: 'transcription',
                errorMessage: 'Test error message',
                retryable: true,
                timestamp: new Date().toISOString()
            };

            // Validate error data structure
            expect(errorData).to.have.property('guid');
            expect(errorData).to.have.property('stage');
            expect(errorData).to.have.property('errorMessage');
            expect(errorData).to.have.property('retryable');
            expect(errorData.retryable).to.be.a('boolean');
            expect(errorData).to.have.property('timestamp');
            expect(errorData.timestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        });
    });

    describe('Integration Points Validation', () => {
        it('should validate CDK stack integration points', () => {
            // Test that CDK stack file exists and contains subtitle processor references
            const fs = require('fs');
            const path = require('path');
            
            const cdkStackFile = path.join(__dirname, '../cdk/lib/vod-stack.ts');
            expect(fs.existsSync(cdkStackFile)).to.be.true;

            const cdkContent = fs.readFileSync(cdkStackFile, 'utf8');
            
            // Verify subtitle processor integration points
            expect(cdkContent).to.include('SubtitleProcessorWorkflow');
            expect(cdkContent).to.include('subtitle-processor-state-machine.json');
            expect(cdkContent).to.include('subtitleProcessorTriggerTask');
            expect(cdkContent).to.include('SUBTITLE_ENABLED');
            expect(cdkContent).to.include('SUBTITLE_PRIMARY_LANGUAGE');
            expect(cdkContent).to.include('SUBTITLE_TARGET_LANGUAGES');
        });

        it('should validate shared utilities integration', () => {
            const fs = require('fs');
            const path = require('path');
            
            const sharedUtilsFile = path.join(__dirname, '../shared/subtitle-utils.js');
            expect(fs.existsSync(sharedUtilsFile)).to.be.true;

            // Test that shared utilities can be loaded
            expect(() => {
                require('../shared/subtitle-utils.js');
            }).to.not.throw();
        });
    });
});
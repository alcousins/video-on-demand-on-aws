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
const path = require('path');
const { mockClient } = require("aws-sdk-client-mock");
const { MediaConvertClient, GetJobTemplateCommand, CreateJobCommand } = require('@aws-sdk/client-mediaconvert');
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const lambda = require('../index.js');

describe('#ENCODE::', () => {
    process.env.MediaConvertRole = 'Role';
    process.env.Workflow = 'vod';
    process.env.ErrorHandler = 'error_handler';

    const _event = {
        guid: '12345678',
        jobTemplate: 'jobTemplate',
        srcVideo: 'video.mp4',
        srcBucket: 'src',
        destBucket: 'dest',
        acceleratedTranscoding:'PREFERRED'
    };

    const _withframe = {
        guid: '12345678',
        jobTemplate: 'jobTemplate',
        srcVideo: 'video.mp4',
        srcBucket: 'src',
        destBucket: 'dest',
        frameCapture: true,
        acceleratedTranscoding:'ENABLED'
    };

    const _withSubtitles = {
        guid: '12345678',
        jobTemplate: 'jobTemplate',
        srcVideo: 'video.mp4',
        srcBucket: 'src',
        destBucket: 'dest',
        subtitleFiles: {
            'en': 's3://temp-bucket/12345678/subtitles/video.en.vtt',
            'es': 's3://temp-bucket/12345678/subtitles/video.es.vtt'
        },
        acceleratedTranscoding:'PREFERRED'
    };

    const _withSubtitlesAndFrame = {
        guid: '12345678',
        jobTemplate: 'jobTemplate',
        srcVideo: 'video.mp4',
        srcBucket: 'src',
        destBucket: 'dest',
        subtitleFiles: {
            'en': 's3://temp-bucket/12345678/subtitles/video.en.vtt'
        },
        frameCapture: true,
        acceleratedTranscoding:'ENABLED'
    };

    const _withWebVTTFiles = {
        guid: '12345678',
        jobTemplate: 'jobTemplate',
        srcVideo: 'video.mp4',
        srcBucket: 'src',
        destBucket: 'dest',
        webvttFiles: [
            {
                language: 'fr',
                filename: 'video.fr.vtt',
                s3Location: 's3://dest/12345678/subtitles/video.fr.vtt',
                size: 1024
            },
            {
                language: 'de',
                filename: 'video.de.vtt',
                s3Location: 's3://dest/12345678/subtitles/video.de.vtt',
                size: 1024
            }
        ],
        acceleratedTranscoding:'PREFERRED'
    };

    const _withWebVTTResult = {
        guid: '12345678',
        jobTemplate: 'jobTemplate',
        srcVideo: 'video.mp4',
        srcBucket: 'src',
        destBucket: 'dest',
        webvttResult: {
            Payload: {
                webvttFiles: [
                    {
                        language: 'ja',
                        filename: 'video.ja.vtt',
                        s3Location: 's3://dest/12345678/subtitles/video.ja.vtt',
                        size: 1024
                    },
                    {
                        language: 'ko',
                        filename: 'video.ko.vtt',
                        s3Location: 's3://dest/12345678/subtitles/video.ko.vtt',
                        size: 1024
                    }
                ]
            }
        },
        acceleratedTranscoding:'PREFERRED'
    };

    const data = {
        Job: {
            Id: '12345',
        }
    };

    const tmpl = {
        JobTemplate: {
            Settings: {
                OutputGroups: [
                    {
                        OutputGroupSettings: {
                            Type: 'HLS_GROUP_SETTINGS'
                        },
                        Name: 'test-output-group'
                    },
                    {
                        OutputGroupSettings: {
                            Type: 'FILE_GROUP_SETTINGS',
                            FileGroupSettings: {
                                Destination: 's3://dest/12345678/mp4/'
                            }
                        },
                        Name: 'File Group',
                        Outputs: [
                            {
                                NameModifier: '_1080p',
                                VideoDescription: {
                                    Width: 1920,
                                    Height: 1080
                                },
                                ContainerSettings: {
                                    Container: 'MP4'
                                }
                            }
                        ]
                    }
                ]
            }
        }
    };

    const mediaConvertClientMock = mockClient(MediaConvertClient);
    const lambdaClientMock = mockClient(LambdaClient);

    afterEach(() => mediaConvertClientMock.reset());

    it('should succeed when FrameCapture is disabled', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);


        const response = await lambda.handler(_event);
        expect(response.encodeJobId).to.equal('12345');
        expect(response.encodingJob.Settings.OutputGroups[0].OutputGroupSettings.Type).to.equal('HLS_GROUP_SETTINGS');
    });

    it('should succeed when FrameCapture is enabled', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(_withframe);
        expect(response.encodeJobId).to.equal('12345');
        expect(response.encodingJob.Settings.OutputGroups[2].CustomName).to.equal('Frame Capture');
    });

    it('should succeed with subtitle files', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(_withSubtitles);
        expect(response.encodeJobId).to.equal('12345');
        
        // Check that caption selectors were added to input
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1']).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 2']).to.not.be.undefined;
        
        // Check the structure matches AWS MediaConvert API specification
        expect(captionSelectors['Captions Selector 1'].SourceSettings).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1'].SourceSettings.SourceType).to.equal('WEBVTT');
        expect(captionSelectors['Captions Selector 1'].SourceSettings.FileSourceSettings).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1'].SourceSettings.FileSourceSettings.SourceFile).to.equal('s3://temp-bucket/12345678/subtitles/video.en.vtt');
        
        // Check that caption descriptions were added to file group outputs
        const fileGroup = response.encodingJob.Settings.OutputGroups.find(group => 
            group.OutputGroupSettings.Type === 'FILE_GROUP_SETTINGS'
        );
        expect(fileGroup).to.not.be.undefined;
        expect(fileGroup.Outputs[0].CaptionDescriptions).to.not.be.undefined;
        expect(fileGroup.Outputs[0].CaptionDescriptions.length).to.equal(2);
        
        const firstCaption = fileGroup.Outputs[0].CaptionDescriptions[0];
        expect(firstCaption).to.not.be.undefined;
        expect(firstCaption.CaptionSelectorName).to.equal('Captions Selector 1');
        expect(firstCaption.DestinationSettings.DestinationType).to.equal('WEBVTT');
        
        // Check that caption-only outputs were added to HLS group
        const hlsGroup = response.encodingJob.Settings.OutputGroups.find(group => 
            group.OutputGroupSettings.Type === 'HLS_GROUP_SETTINGS'
        );
        expect(hlsGroup).to.not.be.undefined;
        
        // Should have caption-only outputs added
        const captionOutputs = hlsGroup.Outputs.filter(output => 
            output.NameModifier && output.NameModifier.includes('_captions')
        );
        expect(captionOutputs.length).to.equal(2);
        
        // Check first caption output structure
        const enCaptionOutput = captionOutputs.find(output => 
            output.NameModifier === '_en_captions'
        );
        expect(enCaptionOutput).to.not.be.undefined;
        expect(enCaptionOutput.ContainerSettings.Container).to.equal('M3U8');
        expect(enCaptionOutput.CaptionDescriptions).to.not.be.undefined;
        expect(enCaptionOutput.CaptionDescriptions.length).to.equal(1);
        expect(enCaptionOutput.CaptionDescriptions[0].CaptionSelectorName).to.equal('Captions Selector 1');
        expect(enCaptionOutput.CaptionDescriptions[0].LanguageCode).to.equal('ENG');
        expect(enCaptionOutput.CaptionDescriptions[0].LanguageDescription).to.equal('en');
        
        // Check second caption output structure
        const esCaptionOutput = captionOutputs.find(output => 
            output.NameModifier === '_es_captions'
        );
        expect(esCaptionOutput).to.not.be.undefined;
        expect(esCaptionOutput.ContainerSettings.Container).to.equal('M3U8');
        expect(esCaptionOutput.CaptionDescriptions[0].CaptionSelectorName).to.equal('Captions Selector 2');
        expect(esCaptionOutput.CaptionDescriptions[0].LanguageCode).to.equal('SPA');
        expect(esCaptionOutput.CaptionDescriptions[0].LanguageDescription).to.equal('es');
    });

    it('should succeed with both subtitles and frame capture', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(_withSubtitlesAndFrame);
        expect(response.encodeJobId).to.equal('12345');
        
        // Check subtitles
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1']).to.not.be.undefined;
        
        // Check frame capture (should be the last output group)
        const lastGroup = response.encodingJob.Settings.OutputGroups[response.encodingJob.Settings.OutputGroups.length - 1];
        expect(lastGroup.CustomName).to.equal('Frame Capture');
    });

    it('should maintain backward compatibility without subtitle files', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(_event);
        expect(response.encodeJobId).to.equal('12345');
        
        // Should not have caption selectors
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.be.undefined;
        
        // File group should not have caption descriptions
        const fileGroup = response.encodingJob.Settings.OutputGroups.find(group => 
            group.OutputGroupSettings.Type === 'FILE_GROUP_SETTINGS'
        );
        expect(fileGroup).to.not.be.undefined;
        expect(fileGroup.Outputs[0].CaptionDescriptions).to.be.undefined;
    });

    it('should handle empty subtitle files object', async () => {
        const eventWithEmptySubtitles = {
            ..._event,
            subtitleFiles: {}
        };

        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(eventWithEmptySubtitles);
        expect(response.encodeJobId).to.equal('12345');
        
        // Should not have caption selectors
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.be.undefined;
    });

    it('should handle invalid subtitle files gracefully', async () => {
        const eventWithInvalidSubtitles = {
            ..._event,
            subtitleFiles: {
                'en': null,
                'es': '',
                'fr': 's3://valid-bucket/valid-file.vtt'
            }
        };

        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(eventWithInvalidSubtitles);
        expect(response.encodeJobId).to.equal('12345');
        
        // Should only have caption selector for valid file
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1']).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1'].SourceSettings.FileSourceSettings.SourceFile).to.equal('s3://valid-bucket/valid-file.vtt');
        
        // Should not have selectors for invalid entries
        expect(captionSelectors['Captions Selector 2']).to.be.undefined;
        expect(captionSelectors['Captions Selector 3']).to.be.undefined;
    });

    it('should apply custom settings when template is custom', async () => {
        const event = {
            guid: '12345678',
            jobTemplate: 'custom-template',
            srcVideo: 'video.mp4',
            srcBucket: 'src',
            destBucket: 'dest',
            isCustomTemplate: true,
            acceleratedTranscoding:'DISABLED'
        };

        const customTemplate = {
            JobTemplate: {
                Name: 'custom-template',
                Type: 'CUSTOM',
                Settings: {
                    OutputGroups: [{
                        OutputGroupSettings: {
                            Type: 'HLS_GROUP_SETTINGS',
                            HlsGroupSettings: {
                                SegmentLength: 10,
                                MinSegmentLength: 2
                            }
                        },
                        Name: 'custom-output-group'
                    }]
                }
            }
        };

        const newJob = { Job: { Id: '12345678' } };

        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(customTemplate);
        mediaConvertClientMock.on(CreateJobCommand).resolves(newJob);

        const response = await lambda.handler(event);

        const output = response.encodingJob.Settings.OutputGroups[0];
        const settings = output.OutputGroupSettings.HlsGroupSettings;

        expect(settings).not.to.be.null;
        expect(settings.SegmentLength).to.equal(10);
        expect(settings.MinSegmentLength).to.equal(2);
    });

    it('should fail when getJobTemplate throws an exception', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).rejects('GET ERROR');
        lambdaClientMock.on(InvokeCommand).resolves();

        await lambda.handler(_event).catch(err => {
            expect(err.toString()).to.equal('Error: GET ERROR');
        });
    });

    it('should fail when createJob throws an exception', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).rejects('JOB ERROR');
        lambdaClientMock.on(InvokeCommand).resolves();

        await lambda.handler(_event).catch(err => {
            expect(err.toString()).to.equal('Error: JOB ERROR');
        });
    });

    it('should succeed with WebVTT files from subtitle processing pipeline', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(_withWebVTTFiles);
        expect(response.encodeJobId).to.equal('12345');
        
        // Check that caption selectors were added to input
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1']).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 2']).to.not.be.undefined;
        
        // Check the structure matches AWS MediaConvert API specification
        expect(captionSelectors['Captions Selector 1'].SourceSettings.FileSourceSettings.SourceFile).to.equal('s3://dest/12345678/subtitles/video.fr.vtt');
        expect(captionSelectors['Captions Selector 2'].SourceSettings.FileSourceSettings.SourceFile).to.equal('s3://dest/12345678/subtitles/video.de.vtt');
        
        // Check that caption-only outputs were added to HLS group
        const hlsGroup = response.encodingJob.Settings.OutputGroups.find(group => 
            group.OutputGroupSettings.Type === 'HLS_GROUP_SETTINGS'
        );
        expect(hlsGroup).to.not.be.undefined;
        
        // Should have caption-only outputs added
        const captionOutputs = hlsGroup.Outputs.filter(output => 
            output.NameModifier && output.NameModifier.includes('_captions')
        );
        expect(captionOutputs.length).to.equal(2);
        
        // Check caption output structure
        const frCaptionOutput = captionOutputs.find(output => 
            output.NameModifier === '_fr_captions'
        );
        expect(frCaptionOutput).to.not.be.undefined;
        expect(frCaptionOutput.CaptionDescriptions[0].LanguageCode).to.equal('FRA');
        expect(frCaptionOutput.CaptionDescriptions[0].LanguageDescription).to.equal('fr');
    });

    it('should succeed with WebVTT files from webvttResult.Payload', async () => {
        mediaConvertClientMock.on(GetJobTemplateCommand).resolves(tmpl);
        mediaConvertClientMock.on(CreateJobCommand).resolves(data);

        const response = await lambda.handler(_withWebVTTResult);
        expect(response.encodeJobId).to.equal('12345');
        
        // Check that caption selectors were added to input
        const captionSelectors = response.encodingJob.Settings.Inputs[0].CaptionSelectors;
        expect(captionSelectors).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 1']).to.not.be.undefined;
        expect(captionSelectors['Captions Selector 2']).to.not.be.undefined;
        
        // Check the structure matches AWS MediaConvert API specification
        expect(captionSelectors['Captions Selector 1'].SourceSettings.FileSourceSettings.SourceFile).to.equal('s3://dest/12345678/subtitles/video.ja.vtt');
        expect(captionSelectors['Captions Selector 2'].SourceSettings.FileSourceSettings.SourceFile).to.equal('s3://dest/12345678/subtitles/video.ko.vtt');
        
        // Check that caption-only outputs were added to HLS group
        const hlsGroup = response.encodingJob.Settings.OutputGroups.find(group => 
            group.OutputGroupSettings.Type === 'HLS_GROUP_SETTINGS'
        );
        expect(hlsGroup).to.not.be.undefined;
        
        // Should have caption-only outputs added
        const captionOutputs = hlsGroup.Outputs.filter(output => 
            output.NameModifier && output.NameModifier.includes('_captions')
        );
        expect(captionOutputs.length).to.equal(2);
        
        // Check caption output structure
        const jaCaptionOutput = captionOutputs.find(output => 
            output.NameModifier === '_ja_captions'
        );
        expect(jaCaptionOutput).to.not.be.undefined;
        expect(jaCaptionOutput.CaptionDescriptions[0].LanguageCode).to.equal('JPN');
        expect(jaCaptionOutput.CaptionDescriptions[0].LanguageDescription).to.equal('ja');
    });
});
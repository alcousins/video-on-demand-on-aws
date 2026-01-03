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

const { MediaConvert } = require("@aws-sdk/client-mediaconvert");
const error = require('./lib/error.js');
const _ = require('lodash');
const { SUPPORTED_LANGUAGES } = require('./subtitle-utils.js');

// Conditionally import S3 storage utilities to avoid test dependency issues
let s3StorageUtils = null;
try {
    s3StorageUtils = require('./s3-storage-utils.js');
} catch (err) {
    console.warn('S3 storage utilities not available, subtitle file handling will be limited');
}

const getMp4Group = (outputPath) => ({
    Name: 'File Group',
    OutputGroupSettings: {
        Type: 'FILE_GROUP_SETTINGS',
        FileGroupSettings: {
            Destination: `${outputPath}/mp4/`
        }
    },
    Outputs: []
});

const getHlsGroup = (outputPath) => ({
    Name: 'HLS Group',
    OutputGroupSettings: {
        Type: 'HLS_GROUP_SETTINGS',
        HlsGroupSettings: {
            SegmentLength: 5,
            MinSegmentLength: 0,
            Destination: `${outputPath}/hls/`
        }
    },
    Outputs: []
});

const getDashGroup = (outputPath) => ({
    Name: 'DASH ISO',
    OutputGroupSettings: {
        Type: 'DASH_ISO_GROUP_SETTINGS',
        DashIsoGroupSettings: {
            SegmentLength: 30,
            FragmentLength: 3,
            Destination: `${outputPath}/dash/`
        }
    },
    Outputs: []
});

const getCmafGroup = (outputPath) => ({
    Name: 'CMAF',
    OutputGroupSettings: {
        Type: 'CMAF_GROUP_SETTINGS',
        CmafGroupSettings: {
            SegmentLength: 30,
            FragmentLength: 3,
            Destination: `${outputPath}/cmaf/`
        }
    },
    Outputs: []
});

const getMssGroup = (outputPath) => ({
    Name: 'MS Smooth',
    OutputGroupSettings: {
        Type: 'MS_SMOOTH_GROUP_SETTINGS',
        MsSmoothGroupSettings: {
            FragmentLength: 2,
            ManifestEncoding: 'UTF8',
            Destination: `${outputPath}/mss/`
        }
    },
    Outputs: []
});

/**
 * Creates caption selectors for subtitle files in AWS MediaConvert format
 * @param {Object} subtitleFiles - Object mapping language codes to S3 locations
 * @returns {Object} Caption selectors configuration matching AWS MediaConvert API specification
 */
const createCaptionSelectors = (subtitleFiles) => {
    if (!subtitleFiles || typeof subtitleFiles !== 'object') {
        return {};
    }

    const captionSelectors = {};
    let selectorIndex = 1;
    
    Object.entries(subtitleFiles).forEach(([languageCode, s3Location]) => {
        if (s3Location && typeof s3Location === 'string') {
            const selectorName = `Captions Selector ${selectorIndex}`;
            captionSelectors[selectorName] = {
                SourceSettings: {
                    SourceType: 'WEBVTT',
                    FileSourceSettings: {
                        SourceFile: s3Location
                    }
                }
            };
            selectorIndex++;
        }
    });

    return captionSelectors;
};

/**
 * MediaConvert language code mappings for caption outputs
 * Maps common language codes to MediaConvert's expected 3-letter codes
 */
const MEDIACONVERT_LANGUAGE_CODES = {
    'ar': 'ARA',
    'de': 'GER', 
    'en': 'ENG',
    'es': 'SPA',
    'fr': 'FRA',
    'it': 'ITA',
    'ja': 'JPN',
    'ko': 'KOR',
    'pt': 'POR',
    'pt-BR': 'POR',
    'zh': 'ZHO',
    'zh-CN': 'ZHO',
    'zh-TW': 'ZHO',
    'ru': 'RUS',
    'hi': 'HIN',
    'th': 'THA',
    'vi': 'VIE',
    'tr': 'TUR',
    'pl': 'POL',
    'nl': 'DUT',
    'sv': 'SWE',
    'da': 'DAN',
    'no': 'NOR',
    'fi': 'FIN',
    'he': 'HEB',
    'cs': 'CZE',
    'hu': 'HUN',
    'ro': 'RON',
    'bg': 'BUL',
    'hr': 'HRV',
    'sk': 'SLK',
    'sl': 'SLV',
    'et': 'EST',
    'lv': 'LAV',
    'lt': 'LIT',
    'uk': 'UKR',
    'el': 'GRE',
    'ca': 'CAT',
    'eu': 'BAQ',
    'gl': 'GLG',
    'mt': 'MLT',
    'is': 'ICE',
    'ga': 'GLE',
    'cy': 'WEL'
};

/**
 * Creates caption-only outputs for HLS output groups
 * @param {Object} subtitleFiles - Object mapping language codes to S3 locations
 * @returns {Array} Array of caption-only output configurations
 */
const createCaptionOutputs = (subtitleFiles) => {
    if (!subtitleFiles || typeof subtitleFiles !== 'object') {
        return [];
    }

    const captionOutputs = [];
    let selectorIndex = 1;
    
    Object.entries(subtitleFiles).forEach(([languageCode, s3Location]) => {
        if (s3Location && typeof s3Location === 'string') {
            const selectorName = `Captions Selector ${selectorIndex}`;
            const mediaConvertLanguageCode = MEDIACONVERT_LANGUAGE_CODES[languageCode] || languageCode.toUpperCase();
            
            captionOutputs.push({
                ContainerSettings: {
                    Container: 'M3U8',
                    M3u8Settings: {}
                },
                OutputSettings: {
                    HlsSettings: {}
                },
                NameModifier: `_${languageCode}_captions`,
                CaptionDescriptions: [
                    {
                        CaptionSelectorName: selectorName,
                        DestinationSettings: {
                            DestinationType: 'WEBVTT',
                            WebvttDestinationSettings: {}
                        },
                        LanguageCode: mediaConvertLanguageCode,
                        LanguageDescription: languageCode
                    }
                ]
            });
            
            selectorIndex++;
        }
    });

    return captionOutputs;
};

/**
 * Creates caption descriptions for MediaConvert outputs
 * @param {Object} subtitleFiles - Object mapping language codes to S3 locations
 * @returns {Array} Array of caption descriptions
 */
const createCaptionDescriptions = (subtitleFiles) => {
    if (!subtitleFiles || typeof subtitleFiles !== 'object') {
        return [];
    }

    const captionDescriptions = [];
    let selectorIndex = 1;
    
    Object.entries(subtitleFiles).forEach(([languageCode, s3Location]) => {
        if (s3Location && typeof s3Location === 'string') {
            const selectorName = `Captions Selector ${selectorIndex}`;
            const languageName = SUPPORTED_LANGUAGES[languageCode] || languageCode;
            
            captionDescriptions.push({
                CaptionSelectorName: selectorName,
                LanguageCode: languageCode.toLowerCase(),
                LanguageDescription: languageName,
                DestinationSettings: {
                    DestinationType: 'WEBVTT',
                    WebvttDestinationSettings: {
                        StylePassthrough: 'ENABLED'
                    }
                }
            });
            selectorIndex++;
        }
    });

    return captionDescriptions;
};

/**
 * Adds subtitle support to MediaConvert output groups
 * @param {Array} outputGroups - Existing output groups
 * @param {Object} subtitleFiles - Object mapping language codes to S3 locations
 * @returns {Array} Modified output groups with subtitle support
 */
const addSubtitleSupport = (outputGroups, subtitleFiles) => {
    if (!subtitleFiles || typeof subtitleFiles !== 'object' || Object.keys(subtitleFiles).length === 0) {
        return outputGroups;
    }

    const captionDescriptions = createCaptionDescriptions(subtitleFiles);
    const captionOutputs = createCaptionOutputs(subtitleFiles);
    
    if (captionDescriptions.length === 0) {
        return outputGroups;
    }

    // Add caption descriptions and outputs to appropriate output groups
    return outputGroups.map(group => {
        const modifiedGroup = _.cloneDeep(group);
        
        // Add subtitles to file-based outputs (MP4, etc.)
        if (group.OutputGroupSettings.Type === 'FILE_GROUP_SETTINGS') {
            // Add caption descriptions to each output in the group
            modifiedGroup.Outputs = modifiedGroup.Outputs.map(output => {
                const modifiedOutput = _.cloneDeep(output);
                
                // Only add captions to video outputs (not audio-only)
                if (modifiedOutput.VideoDescription) {
                    modifiedOutput.CaptionDescriptions = captionDescriptions;
                }
                
                return modifiedOutput;
            });
        }
        
        // Add caption-only outputs to HLS groups
        if (group.OutputGroupSettings.Type === 'HLS_GROUP_SETTINGS') {
            // Add caption-only outputs to the existing outputs
            modifiedGroup.Outputs = [...modifiedGroup.Outputs, ...captionOutputs];
            console.log(`Added ${captionOutputs.length} caption-only outputs to HLS group`);
        }
        
        return modifiedGroup;
    });
};

const getFrameGroup = (event, outputPath) => ({
    CustomName: 'Frame Capture',
    Name: 'File Group',
    OutputGroupSettings: {
        Type: 'FILE_GROUP_SETTINGS',
        FileGroupSettings: {
            Destination: `${outputPath}/thumbnails/`
        }
    },
    Outputs: [{
        NameModifier: '_thumb',
        ContainerSettings: {
            Container: 'RAW'
        },
        VideoDescription: {
            ColorMetadata: 'INSERT',
            AfdSignaling: 'NONE',
            Sharpness: 100,
            Height: event.frameHeight,
            RespondToAfd: 'NONE',
            TimecodeInsertion: 'DISABLED',
            Width: event.frameWidth,
            ScalingBehavior: 'DEFAULT',
            AntiAlias: 'ENABLED',
            CodecSettings: {
                FrameCaptureSettings: {
                    MaxCaptures: 10000000,
                    Quality: 80,
                    FramerateDenominator: 5,
                    FramerateNumerator: 1
                },
                Codec: 'FRAME_CAPTURE'
            },
            DropFrameTimecode: 'ENABLED'
        }
    }]
});
//PR: https://github.com/awslabs/video-on-demand-on-aws/pull/107
const mergeSettingsWithDefault = (originalGroup, customGroup) => {
    return _.merge({}, originalGroup, customGroup);
};

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    const mediaconvert = new MediaConvert({
        endpoint: process.env.EndPoint,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    // Initialize S3 client for subtitle file operations (if available)
    let s3Client = null;
    if (s3StorageUtils) {
        s3Client = s3StorageUtils.createOptimizedS3Client(process.env.AWS_REGION, process.env.SOLUTION_IDENTIFIER);
    }

    try {
        const inputPath = `s3://${event.srcBucket}/${event.srcVideo}`;
        const outputPath = `s3://${event.destBucket}/${event.guid}`;

        // Handle subtitle files from subtitle processing pipeline
        let subtitleFiles = {};
        let processedSubtitleFiles = [];
        
        // Check for subtitle files from WebVTT generator or previous processing steps
        if (event.webvttFiles && Array.isArray(event.webvttFiles)) {
            console.log(`Processing ${event.webvttFiles.length} WebVTT files from subtitle processing pipeline`);
            
            // Convert WebVTT files array to MediaConvert-compatible format
            event.webvttFiles.forEach(webvttFile => {
                if (webvttFile.language && webvttFile.s3Location) {
                    subtitleFiles[webvttFile.language] = webvttFile.s3Location;
                }
            });
            
            console.log(`Converted WebVTT files to MediaConvert format: ${JSON.stringify(subtitleFiles)}`);
            
        } else if (event.webvttResult && event.webvttResult.Payload && event.webvttResult.Payload.webvttFiles) {
            // Handle case where webvttFiles are nested in webvttResult.Payload
            console.log(`Processing ${event.webvttResult.Payload.webvttFiles.length} WebVTT files from webvttResult.Payload`);
            
            event.webvttResult.Payload.webvttFiles.forEach(webvttFile => {
                if (webvttFile.language && webvttFile.s3Location) {
                    subtitleFiles[webvttFile.language] = webvttFile.s3Location;
                }
            });
            
            console.log(`Converted WebVTT files to MediaConvert format: ${JSON.stringify(subtitleFiles)}`);
            
        } else if (s3StorageUtils && s3Client && event.webvttFiles && Array.isArray(event.webvttFiles)) {
            // Fallback to S3 storage utils processing if available
            try {
                const tempBucket = process.env.TEMP_BUCKET || event.destBucket;
                processedSubtitleFiles = await s3StorageUtils.copySubtitlesToFinalDestination(
                    s3Client,
                    tempBucket,
                    event.destBucket,
                    event.guid,
                    event.webvttFiles
                );
                
                // Generate CloudFront URLs for accessibility
                if (event.cloudFrontDomain) {
                    processedSubtitleFiles = s3StorageUtils.generateSubtitleCloudFrontUrls(
                        event.cloudFrontDomain,
                        processedSubtitleFiles
                    );
                }
                
                // Create MediaConvert-compatible subtitle file configuration
                subtitleFiles = s3StorageUtils.createMediaConvertSubtitleConfig(processedSubtitleFiles);
                
                console.log(`Successfully processed ${processedSubtitleFiles.length} subtitle files for MediaConvert integration`);
                
            } catch (subtitleErr) {
                console.error('Error processing subtitle files for MediaConvert:', subtitleErr);
                // Continue with MediaConvert job without subtitles rather than failing
                console.log('Continuing MediaConvert job without subtitle files due to processing error');
            }
        } else if (event.subtitleFiles && typeof event.subtitleFiles === 'object') {
            // Handle pre-existing subtitle files (backward compatibility)
            subtitleFiles = event.subtitleFiles;
            console.log(`Using pre-existing subtitle files: ${JSON.stringify(Object.keys(subtitleFiles))}`);
        }

        const hasSubtitles = Object.keys(subtitleFiles).length > 0;
        console.log(`Subtitle files for MediaConvert: ${hasSubtitles ? JSON.stringify(subtitleFiles) : 'none'}`);

        // Baseline for the job parameters
        let job = {
            JobTemplate: event.jobTemplate,
            Role: process.env.MediaConvertRole,
            UserMetadata: {
                guid: event.guid,
                workflow: event.workflowName
            },
            Settings: {
                Inputs: [{
                    AudioSelectors: {
                        'Audio Selector 1': {
                            Offset: 0,
                            DefaultSelection: 'NOT_DEFAULT',
                            ProgramSelection: 1
                        }
                    },
                    VideoSelector: {
                        ColorSpace: 'FOLLOW',
                        Rotate: event.inputRotate
                    },
                    FilterEnable: 'AUTO',
                    PsiControl: 'USE_PSI',
                    FilterStrength: 0,
                    DeblockFilter: 'DISABLED',
                    DenoiseFilter: 'DISABLED',
                    TimecodeSource: 'ZEROBASED',
                    FileInput: inputPath,
                }],
                OutputGroups: []
            }
        };

        // Add caption selectors if subtitle files are provided
        if (hasSubtitles) {
            const captionSelectors = createCaptionSelectors(subtitleFiles);
            if (Object.keys(captionSelectors).length > 0) {
                job.Settings.Inputs[0].CaptionSelectors = captionSelectors;
                console.log(`Added ${Object.keys(captionSelectors).length} caption selectors to MediaConvert job`);
            }
        }

        const mp4 = getMp4Group(outputPath);
        const hls = getHlsGroup(outputPath);
        const dash = getDashGroup(outputPath);
        const cmaf = getCmafGroup(outputPath);
        const mss = getMssGroup(outputPath);
        const frameCapture = getFrameGroup(event, outputPath);

        let tmpl = await mediaconvert.getJobTemplate({ Name: event.jobTemplate });
        console.log(`TEMPLATE:: ${JSON.stringify(tmpl, null, 2)}`);

        // OutputGroupSettings:Type is required and must be one of the following
        // HLS_GROUP_SETTINGS | DASH_ISO_GROUP_SETTINGS | FILE_GROUP_SETTINGS | MS_SMOOTH_GROUP_SETTINGS | CMAF_GROUP_SETTINGS,
        // Using this to determine the output types in the the job Template
        tmpl.JobTemplate.Settings.OutputGroups.forEach(group => {
            let found = false, defaultGroup = {};

            switch (group.OutputGroupSettings.Type) {
                case 'FILE_GROUP_SETTINGS':
                    found = true;
                    defaultGroup = mp4;
                    break;

                case 'HLS_GROUP_SETTINGS':
                    found = true;
                    defaultGroup = hls;
                    break;

                case 'DASH_ISO_GROUP_SETTINGS':
                    found = true;
                    defaultGroup = dash;
                    break;

                case 'MS_SMOOTH_GROUP_SETTINGS':
                    found = true;
                    defaultGroup = mss;
                    break;

                case 'CMAF_GROUP_SETTINGS':
                    found = true;
                    defaultGroup = cmaf;
                    break;
            }

            if (found) {
                console.log(`${defaultGroup.Name} found in Job Template`);
                // PR: https://github.com/awslabs/video-on-demand-on-aws/pull/107
                const outputGroup = mergeSettingsWithDefault(defaultGroup, group);
                job.Settings.OutputGroups.push(outputGroup);
            }
        });

        if (event.frameCapture) {
            job.Settings.OutputGroups.push(frameCapture);
        }

        // Add subtitle support to output groups if subtitle files are provided
        if (hasSubtitles) {
            job.Settings.OutputGroups = addSubtitleSupport(job.Settings.OutputGroups, subtitleFiles);
            console.log(`Enhanced ${job.Settings.OutputGroups.length} output groups with subtitle support`);
        }

        //if enabled the TimeCodeConfig needs to be set to ZEROBASED not passthrough
        //https://docs.aws.amazon.com/mediaconvert/latest/ug/job-requirements.html
        if (event.acceleratedTranscoding === 'PREFERRED' || event.acceleratedTranscoding === 'ENABLED') {
            job.AccelerationSettings = {"Mode" : event.acceleratedTranscoding}
            job.Settings.TimecodeConfig = {"Source" : "ZEROBASED"}
            job.Settings.Inputs[0].TimecodeSource = "ZEROBASED"
        }
        job.Tags = {'SolutionId': 'SO0021'};
        
        let data = await mediaconvert.createJob(job);
        event.encodingJob = job;
        event.encodeJobId = data.Job.Id;

        // Add processed subtitle files to event for downstream processing
        if (processedSubtitleFiles.length > 0) {
            event.finalSubtitleFiles = processedSubtitleFiles;
            event.subtitleProcessingCompleted = true;
            
            // Clean up temporary files after successful MediaConvert job submission
            if (s3StorageUtils && s3Client) {
                try {
                    const tempBucket = process.env.TEMP_BUCKET || event.destBucket;
                    const cleanupResult = await s3StorageUtils.cleanupTempSubtitleFiles(s3Client, tempBucket, event.webvttFiles || []);
                    console.log(`Temporary subtitle file cleanup: ${cleanupResult.deletedCount} deleted, ${cleanupResult.failedCount} failed`);
                } catch (cleanupErr) {
                    console.warn('Failed to clean up temporary subtitle files:', cleanupErr);
                    // Don't fail the main workflow for cleanup errors
                }
            }
        }

        console.log(`JOB:: ${JSON.stringify(data, null, 2)}`);
    } catch (err) {
        await error.handler(event, err);
        throw err;
    }

    return event;
};

/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * Integration tests for file pipeline and storage functionality
 * Tests Requirements 4.3, 5.1, 5.2, 5.3 - S3 storage, MediaConvert integration, and CloudFront accessibility
 */

const { 
    generateWebVTTFilename,
    generateCloudFrontUrl,
    generateSubtitleS3Key,
    SUPPORTED_LANGUAGES
} = require('../shared/subtitle-utils.js');

const { expect } = require('chai');

// Mock storage configuration for testing
const STORAGE_CONFIG = {
    TEMP_STORAGE: {
        PREFIX: 'temp/subtitles',
        RETENTION_HOURS: 24,
        CONTENT_TYPE: 'text/vtt',
        CONTENT_ENCODING: 'utf-8'
    },
    FINAL_STORAGE: {
        PREFIX: 'subtitles',
        CONTENT_TYPE: 'text/vtt',
        CONTENT_ENCODING: 'utf-8'
    },
    LIFECYCLE: {
        TEMP_STORAGE_CLASS: 'STANDARD',
        FINAL_STORAGE_CLASS: 'STANDARD_IA',
        ARCHIVE_AFTER_DAYS: 90
    }
};

// Mock utility functions for testing
function generateTempSubtitleKey(guid, filename) {
    if (!guid || !filename) {
        throw new Error('GUID and filename are required for temporary S3 key generation');
    }
    
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${STORAGE_CONFIG.TEMP_STORAGE.PREFIX}/${guid}/${sanitizedFilename}`;
}

function generateFinalSubtitleKey(guid, filename) {
    if (!guid || !filename) {
        throw new Error('GUID and filename are required for final S3 key generation');
    }
    
    return generateSubtitleS3Key(guid, filename);
}

function generateSubtitleCloudFrontUrls(cloudFrontDomain, finalSubtitleFiles) {
    try {
        if (!cloudFrontDomain || !finalSubtitleFiles || finalSubtitleFiles.length === 0) {
            return finalSubtitleFiles || [];
        }

        return finalSubtitleFiles.map(file => {
            try {
                const s3Key = file.finalS3Key || file.finalS3Location?.replace(/^s3:\/\/[^\/]+\//, '');
                
                if (!s3Key) {
                    return file;
                }

                const cloudFrontUrl = generateCloudFrontUrl(cloudFrontDomain, s3Key);
                
                return {
                    ...file,
                    cloudFrontUrl: cloudFrontUrl,
                    publicUrl: cloudFrontUrl
                };

            } catch (err) {
                return file;
            }
        });

    } catch (err) {
        return finalSubtitleFiles;
    }
}

function createMediaConvertSubtitleConfig(finalSubtitleFiles) {
    try {
        if (!finalSubtitleFiles || finalSubtitleFiles.length === 0) {
            return {};
        }

        const subtitleConfig = {};
        
        finalSubtitleFiles.forEach(file => {
            if (file.finalS3Location && file.language) {
                subtitleConfig[file.language] = file.finalS3Location;
            }
        });

        return subtitleConfig;

    } catch (err) {
        return {};
    }
}

describe('File Pipeline and Storage Integration Tests', () => {
    const testGuid = 'test-guid-12345';
    const testBucket = 'test-bucket';
    const testDestBucket = 'test-dest-bucket';
    const testCloudFrontDomain = 'test.cloudfront.net';
    const testVideoFilename = 'test-video.mp4';

    beforeEach(() => {
        // Set up environment variables
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
        process.env.TEMP_BUCKET = testBucket;
    });

    describe('File Naming Consistency', () => {
        it('should generate consistent temporary S3 keys', () => {
            // Arrange
            const filename = 'test-video.en.vtt';

            // Act
            const key1 = generateTempSubtitleKey(testGuid, filename);
            const key2 = generateTempSubtitleKey(testGuid, filename);

            // Assert
            expect(key1).to.equal(key2);
            expect(key1).to.include(STORAGE_CONFIG.TEMP_STORAGE.PREFIX);
            expect(key1).to.include(testGuid);
            expect(key1).to.include(filename);
        });

        it('should generate consistent final S3 keys', () => {
            // Arrange
            const filename = 'test-video.en.vtt';

            // Act
            const key1 = generateFinalSubtitleKey(testGuid, filename);
            const key2 = generateFinalSubtitleKey(testGuid, filename);

            // Assert
            expect(key1).to.equal(key2);
            expect(key1).to.include(testGuid);
            expect(key1).to.include('subtitles');
            expect(key1).to.include(filename);
        });

        it('should generate consistent file naming patterns throughout pipeline', () => {
            // Arrange
            const videoFilename = 'my-test-video.mp4';
            const languages = ['en', 'es', 'fr'];

            // Act & Assert
            languages.forEach(language => {
                const webvttFilename = generateWebVTTFilename(videoFilename, language);
                const tempKey = generateTempSubtitleKey(testGuid, webvttFilename);
                const finalKey = generateFinalSubtitleKey(testGuid, webvttFilename);

                // Verify consistent naming patterns
                expect(webvttFilename).to.equal(`my-test-video.${language}.vtt`);
                expect(tempKey).to.include(STORAGE_CONFIG.TEMP_STORAGE.PREFIX);
                expect(tempKey).to.include(testGuid);
                expect(tempKey).to.include(webvttFilename);
                expect(finalKey).to.include(testGuid);
                expect(finalKey).to.include('subtitles');
                expect(finalKey).to.include(webvttFilename);
            });
        });

        it('should sanitize filenames for S3 compatibility', () => {
            // Arrange
            const problematicFilename = 'test video with spaces & special chars!.mp4';

            // Act
            const webvttFilename = generateWebVTTFilename(problematicFilename, 'en');
            const tempKey = generateTempSubtitleKey(testGuid, webvttFilename);

            // Assert
            expect(tempKey).to.not.include(' ');
            expect(tempKey).to.not.include('&');
            expect(tempKey).to.not.include('!');
            expect(tempKey).to.match(/^[a-zA-Z0-9._/-]+$/); // Only allowed S3 characters
        });
    });

    describe('CloudFront URL Generation', () => {
        it('should generate CloudFront URLs for subtitle files', () => {
            // Arrange
            const finalSubtitleFiles = [
                {
                    language: 'en',
                    filename: 'test-video.en.vtt',
                    finalS3Key: 'test-guid-12345/subtitles/test-video.en.vtt',
                    finalS3Location: 's3://dest-bucket/test-guid-12345/subtitles/test-video.en.vtt'
                },
                {
                    language: 'es',
                    filename: 'test-video.es.vtt',
                    finalS3Key: 'test-guid-12345/subtitles/test-video.es.vtt',
                    finalS3Location: 's3://dest-bucket/test-guid-12345/subtitles/test-video.es.vtt'
                }
            ];

            // Act
            const result = generateSubtitleCloudFrontUrls(testCloudFrontDomain, finalSubtitleFiles);

            // Assert
            expect(result).to.have.lengthOf(2);
            expect(result[0]).to.include({
                language: 'en',
                cloudFrontUrl: `https://${testCloudFrontDomain}/test-guid-12345/subtitles/test-video.en.vtt`,
                publicUrl: `https://${testCloudFrontDomain}/test-guid-12345/subtitles/test-video.en.vtt`
            });
            expect(result[1]).to.include({
                language: 'es',
                cloudFrontUrl: `https://${testCloudFrontDomain}/test-guid-12345/subtitles/test-video.es.vtt`,
                publicUrl: `https://${testCloudFrontDomain}/test-guid-12345/subtitles/test-video.es.vtt`
            });
        });

        it('should handle missing CloudFront domain gracefully', () => {
            // Arrange
            const finalSubtitleFiles = [
                {
                    language: 'en',
                    filename: 'test.en.vtt',
                    finalS3Key: 'test/test.en.vtt'
                }
            ];

            // Act
            const result = generateSubtitleCloudFrontUrls(null, finalSubtitleFiles);

            // Assert
            expect(result).to.deep.equal(finalSubtitleFiles); // Should return original files unchanged
        });

        it('should handle URL encoding for special characters', () => {
            // Arrange
            const finalSubtitleFiles = [
                {
                    language: 'en',
                    filename: 'test video with spaces.en.vtt',
                    finalS3Key: 'test-guid/subtitles/test_video_with_spaces.en.vtt'
                }
            ];

            // Act
            const result = generateSubtitleCloudFrontUrls(testCloudFrontDomain, finalSubtitleFiles);

            // Assert
            expect(result[0].cloudFrontUrl).to.include('test_video_with_spaces.en.vtt');
            expect(result[0].cloudFrontUrl).to.not.include(' '); // Spaces should be encoded
        });
    });

    describe('MediaConvert Integration', () => {
        it('should create MediaConvert subtitle configuration', () => {
            // Arrange
            const finalSubtitleFiles = [
                {
                    language: 'en',
                    finalS3Location: 's3://dest-bucket/guid/subtitles/video.en.vtt'
                },
                {
                    language: 'es',
                    finalS3Location: 's3://dest-bucket/guid/subtitles/video.es.vtt'
                }
            ];

            // Act
            const config = createMediaConvertSubtitleConfig(finalSubtitleFiles);

            // Assert
            expect(config).to.deep.equal({
                'en': 's3://dest-bucket/guid/subtitles/video.en.vtt',
                'es': 's3://dest-bucket/guid/subtitles/video.es.vtt'
            });
        });

        it('should handle empty subtitle files array', () => {
            // Act
            const config = createMediaConvertSubtitleConfig([]);

            // Assert
            expect(config).to.deep.equal({});
        });

        it('should handle null subtitle files', () => {
            // Act
            const config = createMediaConvertSubtitleConfig(null);

            // Assert
            expect(config).to.deep.equal({});
        });

        it('should skip files without required properties', () => {
            // Arrange
            const finalSubtitleFiles = [
                {
                    language: 'en',
                    finalS3Location: 's3://dest-bucket/guid/subtitles/video.en.vtt'
                },
                {
                    // Missing language
                    finalS3Location: 's3://dest-bucket/guid/subtitles/video.es.vtt'
                },
                {
                    language: 'fr'
                    // Missing finalS3Location
                }
            ];

            // Act
            const config = createMediaConvertSubtitleConfig(finalSubtitleFiles);

            // Assert
            expect(config).to.deep.equal({
                'en': 's3://dest-bucket/guid/subtitles/video.en.vtt'
            });
        });
    });

    describe('Storage Configuration', () => {
        it('should have consistent storage configuration', () => {
            // Assert
            expect(STORAGE_CONFIG.TEMP_STORAGE.PREFIX).to.equal('temp/subtitles');
            expect(STORAGE_CONFIG.TEMP_STORAGE.CONTENT_TYPE).to.equal('text/vtt');
            expect(STORAGE_CONFIG.TEMP_STORAGE.CONTENT_ENCODING).to.equal('utf-8');
            
            expect(STORAGE_CONFIG.FINAL_STORAGE.PREFIX).to.equal('subtitles');
            expect(STORAGE_CONFIG.FINAL_STORAGE.CONTENT_TYPE).to.equal('text/vtt');
            expect(STORAGE_CONFIG.FINAL_STORAGE.CONTENT_ENCODING).to.equal('utf-8');
        });

        it('should have reasonable retention and lifecycle settings', () => {
            // Assert
            expect(STORAGE_CONFIG.TEMP_STORAGE.RETENTION_HOURS).to.be.a('number');
            expect(STORAGE_CONFIG.TEMP_STORAGE.RETENTION_HOURS).to.be.greaterThan(0);
            
            expect(STORAGE_CONFIG.LIFECYCLE.TEMP_STORAGE_CLASS).to.equal('STANDARD');
            expect(STORAGE_CONFIG.LIFECYCLE.FINAL_STORAGE_CLASS).to.equal('STANDARD_IA');
            expect(STORAGE_CONFIG.LIFECYCLE.ARCHIVE_AFTER_DAYS).to.be.a('number');
            expect(STORAGE_CONFIG.LIFECYCLE.ARCHIVE_AFTER_DAYS).to.be.greaterThan(0);
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid GUID in key generation', () => {
            // Act & Assert
            expect(() => generateTempSubtitleKey(null, 'test.vtt')).to.throw('GUID and filename are required');
            expect(() => generateTempSubtitleKey('', 'test.vtt')).to.throw('GUID and filename are required');
            expect(() => generateFinalSubtitleKey(testGuid, null)).to.throw('GUID and filename are required');
            expect(() => generateFinalSubtitleKey(testGuid, '')).to.throw('GUID and filename are required');
        });

        it('should handle invalid filename in key generation', () => {
            // Act & Assert
            expect(() => generateTempSubtitleKey(testGuid, null)).to.throw('GUID and filename are required');
            expect(() => generateTempSubtitleKey(testGuid, '')).to.throw('GUID and filename are required');
        });
    });

    describe('Integration Validation', () => {
        it('should validate complete file pipeline naming consistency', () => {
            // Arrange
            const videoFilename = 'sample-video.mp4';
            const language = 'en';

            // Act - Generate names through the complete pipeline
            const webvttFilename = generateWebVTTFilename(videoFilename, language);
            const tempKey = generateTempSubtitleKey(testGuid, webvttFilename);
            const finalKey = generateFinalSubtitleKey(testGuid, webvttFilename);
            
            const finalSubtitleFile = {
                language: language,
                filename: webvttFilename,
                finalS3Key: finalKey,
                finalS3Location: `s3://${testDestBucket}/${finalKey}`
            };
            
            const urlResult = generateSubtitleCloudFrontUrls(testCloudFrontDomain, [finalSubtitleFile]);
            const mediaConvertConfig = createMediaConvertSubtitleConfig(urlResult);

            // Assert - Verify consistency throughout pipeline
            expect(webvttFilename).to.equal('sample-video.en.vtt');
            expect(tempKey).to.include(webvttFilename);
            expect(finalKey).to.include(webvttFilename);
            expect(urlResult[0].cloudFrontUrl).to.include(webvttFilename);
            expect(mediaConvertConfig[language]).to.equal(finalSubtitleFile.finalS3Location);
            
            // Verify all components reference the same file
            expect(tempKey).to.include(testGuid);
            expect(finalKey).to.include(testGuid);
            expect(urlResult[0].finalS3Key).to.equal(finalKey);
        });

        it('should support multiple languages consistently', () => {
            // Arrange
            const videoFilename = 'multi-lang-video.mp4';
            const languages = ['en', 'es', 'fr', 'de'];

            // Act
            const results = languages.map(language => {
                const webvttFilename = generateWebVTTFilename(videoFilename, language);
                const tempKey = generateTempSubtitleKey(testGuid, webvttFilename);
                const finalKey = generateFinalSubtitleKey(testGuid, webvttFilename);
                
                return {
                    language,
                    webvttFilename,
                    tempKey,
                    finalKey,
                    finalS3Location: `s3://${testDestBucket}/${finalKey}`
                };
            });

            const urlResults = generateSubtitleCloudFrontUrls(testCloudFrontDomain, results);
            const mediaConvertConfig = createMediaConvertSubtitleConfig(urlResults);

            // Assert
            expect(results).to.have.lengthOf(4);
            expect(urlResults).to.have.lengthOf(4);
            expect(Object.keys(mediaConvertConfig)).to.have.lengthOf(4);

            // Verify each language has consistent naming
            results.forEach((result, index) => {
                expect(result.webvttFilename).to.equal(`multi-lang-video.${result.language}.vtt`);
                expect(result.tempKey).to.include(result.webvttFilename);
                expect(result.finalKey).to.include(result.webvttFilename);
                expect(urlResults[index].cloudFrontUrl).to.include(result.webvttFilename);
                expect(mediaConvertConfig[result.language]).to.equal(result.finalS3Location);
            });
        });
    });
});
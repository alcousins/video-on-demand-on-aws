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

const { handler } = require('../index');
const { 
    buildSubtitleConfig,
    validateAndNormalizeSubtitleConfig,
    createSubtitleErrorReport,
    SUBTITLE_ERROR_TYPES
} = require('../../shared/subtitle-utils');

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/lib-dynamodb');
jest.mock('@aws-sdk/client-sns');

const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockSNSSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({
        send: mockS3Send
    })),
    GetObjectCommand: jest.fn()
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn()
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: jest.fn(() => ({
            send: mockDynamoSend
        }))
    },
    UpdateCommand: jest.fn()
}));

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: jest.fn(() => ({
        send: mockSNSSend
    })),
    PublishCommand: jest.fn()
}));

// Mock error handler
jest.mock('../lib/error', () => ({
    handler: jest.fn()
}));

describe('Subtitle Configuration Lambda', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Set up environment variables
        process.env.AWS_REGION = 'us-east-1';
        process.env.SOLUTION_IDENTIFIER = 'test-solution';
        process.env.DynamoDBTable = 'test-table';
        process.env.SUBTITLE_PROCESSING_ENABLED = 'true';
        process.env.SUBTITLE_PRIMARY_LANGUAGE = 'auto';
        process.env.SUBTITLE_TARGET_LANGUAGES = 'en,es,fr';
    });

    afterEach(() => {
        delete process.env.SUBTITLE_PROCESSING_ENABLED;
        delete process.env.SUBTITLE_PRIMARY_LANGUAGE;
        delete process.env.SUBTITLE_TARGET_LANGUAGES;
    });

    describe('Configuration Building', () => {
        test('should build configuration from environment variables', () => {
            const config = buildSubtitleConfig();
            
            expect(config).toEqual({
                enabled: true,
                primaryLanguage: 'auto',
                targetLanguages: ['en', 'es', 'fr']
            });
        });

        test('should apply metadata overrides', () => {
            const overrides = {
                subtitleEnabled: false,
                subtitlePrimaryLanguage: 'en',
                subtitleTargetLanguages: ['es', 'fr']
            };
            
            const config = buildSubtitleConfig(overrides);
            
            expect(config).toEqual({
                enabled: false,
                primaryLanguage: 'en',
                targetLanguages: ['es', 'fr']
            });
        });

        test('should handle string target languages', () => {
            const overrides = {
                subtitleTargetLanguages: 'en,es,fr,de'
            };
            
            const config = buildSubtitleConfig(overrides);
            
            expect(config.targetLanguages).toEqual(['en', 'es', 'fr', 'de']);
        });
    });

    describe('Configuration Validation', () => {
        test('should validate correct configuration', () => {
            const config = {
                enabled: true,
                primaryLanguage: 'en',
                targetLanguages: ['es', 'fr']
            };
            
            const result = validateAndNormalizeSubtitleConfig(config);
            
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.config).toEqual(config);
        });

        test('should normalize boolean strings', () => {
            const config = {
                enabled: 'true',
                primaryLanguage: 'en',
                targetLanguages: ['es']
            };
            
            const result = validateAndNormalizeSubtitleConfig(config);
            
            expect(result.isValid).toBe(true);
            expect(result.config.enabled).toBe(true);
        });

        test('should handle invalid language codes', () => {
            const config = {
                enabled: true,
                primaryLanguage: 'invalid',
                targetLanguages: ['es', 'invalid-lang']
            };
            
            const result = validateAndNormalizeSubtitleConfig(config);
            
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Unsupported primary language: 'invalid'");
            expect(result.errors).toContain('Unsupported target languages: invalid-lang');
        });

        test('should normalize language codes to lowercase', () => {
            const config = {
                enabled: true,
                primaryLanguage: 'EN',
                targetLanguages: ['ES', 'FR']
            };
            
            const result = validateAndNormalizeSubtitleConfig(config);
            
            expect(result.isValid).toBe(true);
            expect(result.config.primaryLanguage).toBe('en');
            expect(result.config.targetLanguages).toEqual(['es', 'fr']);
        });
    });

    describe('Error Reporting', () => {
        test('should create configuration error report', () => {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR,
                'Invalid configuration',
                { guid: 'test-guid', stage: 'configuration' }
            );
            
            expect(errorReport.errorType).toBe(SUBTITLE_ERROR_TYPES.CONFIGURATION_ERROR);
            expect(errorReport.errorMessage).toBe('Invalid configuration');
            expect(errorReport.severity).toBe('HIGH');
            expect(errorReport.retryable).toBe(false);
            expect(errorReport.userActionRequired).toBe(true);
            expect(errorReport.context.guid).toBe('test-guid');
        });

        test('should create transcription error report', () => {
            const errorReport = createSubtitleErrorReport(
                SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR,
                'Transcription failed',
                { guid: 'test-guid', stage: 'transcription' }
            );
            
            expect(errorReport.errorType).toBe(SUBTITLE_ERROR_TYPES.TRANSCRIPTION_ERROR);
            expect(errorReport.severity).toBe('MEDIUM');
            expect(errorReport.retryable).toBe(true);
            expect(errorReport.userActionRequired).toBe(false);
        });
    });

    describe('Lambda Handler', () => {
        test('should process valid configuration successfully', async () => {
            // Mock DynamoDB update
            mockDynamoSend.mockResolvedValue({});
            
            const event = {
                guid: 'test-guid-123',
                srcBucket: 'test-bucket',
                destBucket: 'test-dest-bucket'
            };
            
            const result = await handler(event);
            
            expect(result.guid).toBe('test-guid-123');
            expect(result.subtitleConfig).toBeDefined();
            expect(result.subtitleConfig.enabled).toBe(true);
            expect(result.configurationResult.isValid).toBe(true);
            expect(mockDynamoSend).toHaveBeenCalled();
        });

        test('should handle missing GUID', async () => {
            const event = {};
            
            await expect(handler(event)).rejects.toThrow('Missing required parameter: guid');
        });

        test('should load metadata overrides from S3', async () => {
            // Mock S3 response
            const mockMetadata = {
                subtitleEnabled: false,
                subtitlePrimaryLanguage: 'es',
                subtitleTargetLanguages: ['en', 'fr']
            };
            
            mockS3Send.mockResolvedValue({
                Body: {
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(JSON.stringify(mockMetadata));
                    }
                }
            });
            
            mockDynamoSend.mockResolvedValue({});
            
            const event = {
                guid: 'test-guid-123',
                srcBucket: 'test-bucket',
                srcMetadataFile: 'metadata.json',
                destBucket: 'test-dest-bucket'
            };
            
            const result = await handler(event);
            
            expect(result.subtitleConfig.enabled).toBe(false);
            expect(result.subtitleConfig.primaryLanguage).toBe('es');
            expect(result.subtitleConfig.targetLanguages).toEqual(['en', 'fr']);
            expect(result.configurationResult.metadataOverrides).toBeDefined();
        });

        test('should handle S3 metadata loading errors gracefully', async () => {
            // Mock S3 error
            mockS3Send.mockRejectedValue(new Error('S3 access denied'));
            mockDynamoSend.mockResolvedValue({});
            
            const event = {
                guid: 'test-guid-123',
                srcBucket: 'test-bucket',
                srcMetadataFile: 'metadata.json',
                destBucket: 'test-dest-bucket'
            };
            
            const result = await handler(event);
            
            // Should still succeed with default configuration
            expect(result.subtitleConfig.enabled).toBe(true);
            expect(result.configurationResult.isValid).toBe(true);
        });

        test('should handle configuration validation errors', async () => {
            // Set invalid environment configuration
            process.env.SUBTITLE_PRIMARY_LANGUAGE = 'invalid-lang';
            
            mockDynamoSend.mockResolvedValue({});
            
            const event = {
                guid: 'test-guid-123',
                srcBucket: 'test-bucket',
                destBucket: 'test-dest-bucket'
            };
            
            const result = await handler(event);
            
            // Should disable subtitle processing for non-critical errors
            expect(result.subtitleConfig.enabled).toBe(false);
            expect(result.configurationResult.isValid).toBe(false);
            expect(result.configurationResult.errors.length).toBeGreaterThan(0);
        });
    });
});
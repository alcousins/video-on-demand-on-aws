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

/**
 * Error handler for translation worker Lambda function
 */

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

/**
 * Handles errors by logging and optionally sending notifications
 * @param {Object} event - Lambda event object
 * @param {Error} error - Error object
 */
exports.handler = async (event, error) => {
    console.error('Translation Worker Error:', {
        error: error.message,
        stack: error.stack,
        event: JSON.stringify(event, null, 2)
    });

    // Send error notification if SNS topic is configured
    if (process.env.ErrorHandler) {
        try {
            const snsClient = new SNSClient({
                region: process.env.AWS_REGION,
                customUserAgent: process.env.SOLUTION_IDENTIFIER
            });

            const message = {
                source: 'translation-worker',
                guid: event.guid || 'unknown',
                error: error.message,
                timestamp: new Date().toISOString()
            };

            const params = {
                TopicArn: process.env.ErrorHandler,
                Message: JSON.stringify(message),
                Subject: 'Translation Worker Error'
            };

            await snsClient.send(new PublishCommand(params));
            console.log('Error notification sent to SNS');
        } catch (snsError) {
            console.error('Failed to send error notification:', snsError);
        }
    }
};
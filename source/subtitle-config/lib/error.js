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

const { DynamoDBDocument } = require("@aws-sdk/lib-dynamodb");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { SNS } = require("@aws-sdk/client-sns");

exports.handler = async (event, err) => {
    console.log(`ERROR:: ${JSON.stringify(event, null, 2)}`);
    console.log(`ERROR:: ${err.toString()}`);

    const dynamo = DynamoDBDocument.from(new DynamoDBClient({ 
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    }));

    const sns = new SNS({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    let guid = event.guid || 'unknown';
    let functionName = 'subtitle-config';
    
    // Create CloudWatch logs URL for debugging
    const url = 'https://console.aws.amazon.com/cloudwatch/home?region=' + process.env.AWS_REGION + 
                '#logStream:group=/aws/lambda/' + process.env.AWS_LAMBDA_FUNCTION_NAME;

    // Prepare DynamoDB update values
    const values = {
        ':st': 'Error',
        ':ea': functionName,
        ':em': err.toString(),
        ':ed': url,
        ':ts': new Date().toISOString()
    };

    // Prepare SNS message to match existing error handler format
    const msg = {
        guid: guid,
        workflowStatus: 'Error',
        workflowErrorAt: functionName,
        errorMessage: err.toString(),
        errorDetails: url,
        timestamp: new Date().toISOString(),
        function: process.env.AWS_LAMBDA_FUNCTION_NAME
    };

    console.log(`ERROR REPORT:: ${JSON.stringify(msg, null, 2)}`);

    try {
        // Update DynamoDB with error information
        const params = {
            TableName: process.env.DynamoDBTable,
            Key: {
                guid: guid
            },
            UpdateExpression: 'SET workflowStatus = :st, workflowErrorAt = :ea, errorMessage = :em, errorDetails = :ed, errorTimestamp = :ts',
            ExpressionAttributeValues: values
        };

        await dynamo.update(params);
        console.log('Updated DynamoDB with error status');

        // Send SNS notification if topic is configured
        if (process.env.SnsTopic) {
            const snsParams = {
                Message: JSON.stringify(msg, null, 2),
                Subject: `Subtitle Configuration Error: ${guid}`,
                TargetArn: process.env.SnsTopic
            };

            await sns.publish(snsParams);
            console.log('Sent SNS error notification');
        }

    } catch (handlerErr) {
        console.error('Error in error handler:', handlerErr);
        // Don't throw here to avoid recursive error handling
    }

    return event;
};
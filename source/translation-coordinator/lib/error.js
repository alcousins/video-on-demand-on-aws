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
const { Lambda } = require("@aws-sdk/client-lambda");

exports.handler = async (event, err) => {
    console.log(`ERROR:: ${JSON.stringify(err, null, 2)}`);

    const dynamo = DynamoDBDocument.from(new DynamoDBClient({ 
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    }));

    const lambda = new Lambda({
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });

    try {
        // Update DynamoDB with error status
        let params = {
            TableName: process.env.DynamoDBTable,
            Key: {
                guid: event.guid,
            },
            UpdateExpression: 'set workflowStatus = :status, errorMessage = :error',
            ExpressionAttributeValues: {
                ':status': 'Error',
                ':error': err.message
            }
        };

        await dynamo.update(params);

        // Send error notification
        if (process.env.ErrorHandler) {
            params = {
                FunctionName: process.env.ErrorHandler,
                Payload: JSON.stringify(event, null, 2)
            };

            await lambda.invoke(params);
        }

    } catch (error) {
        console.log(error);
    }
};
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
const error = require('./lib/error.js');

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    const dynamo = DynamoDBDocument.from(new DynamoDBClient({ 
        region: process.env.AWS_REGION,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    }));

    try {
        // Remove guid from event data (primary db table key) and iterate over event objects
        // to build the update parameters
        let guid = event.guid;
        delete event.guid;
        let expression = '';
        let values = {};
        let names = {};
        let i = 0;

        // Helper function to check if a key contains nested attributes
        const hasNestedAttribute = (key) => key.includes('.');

        // Separate nested and non-nested attributes
        const nestedAttributes = {};
        const flatAttributes = {};

        Object.keys(event).forEach((key) => {
            if (hasNestedAttribute(key)) {
                const [parentKey, childKey] = key.split('.');
                if (!nestedAttributes[parentKey]) {
                    nestedAttributes[parentKey] = {};
                }
                nestedAttributes[parentKey][childKey] = event[key];
            } else {
                flatAttributes[key] = event[key];
            }
        });

        // Build update expression for flat attributes
        Object.keys(flatAttributes).forEach((key) => {
            i++;
            expression += ' ' + key + ' = :' + i + ',';
            values[':' + i] = flatAttributes[key];
        });

        // Build update expression for nested attributes
        Object.keys(nestedAttributes).forEach((parentKey) => {
            i++;
            expression += ' ' + parentKey + ' = :' + i + ',';
            values[':' + i] = nestedAttributes[parentKey];
        });

        let params = {
            TableName: process.env.DynamoDBTable,
            Key: {
                guid: guid,
            },
            // remove the trailing ',' from the update expression added by the forEach loop
            UpdateExpression: 'set ' + expression.slice(0, -1),
            ExpressionAttributeValues: values
        };

        console.log(`UPDATE:: ${JSON.stringify(params, null, 2)}`);
        await dynamo.update(params);

        // Get updated data and reconst event data to return
        event.guid = guid;
    } catch (err) {
        await error.handler(event, err);
        throw err;
    }

    return event;
};

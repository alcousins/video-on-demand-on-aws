#!/bin/sh

./build-s3-dist.sh acousins-vod-guidance-dist video-on-demand-on-aws 2.1
aws s3 sync ./regional-s3-assets/ s3://acousins-vod-guidance-dist-us-east-1/video-on-demand-on-aws/2.1
aws s3 sync ./global-s3-assets/ s3://acousins-vod-guidance-dist-us-east-1/video-on-demand-on-aws/2.1

#aws cloudformation update-stack --stack-name vodv1 --template-url https://acousins-vod-guidance-dist-us-east-1.s3.us-east-1.amazonaws.com/video-on-demand-on-aws/2.1/video-on-demand-on-aws.template --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --region us-east-1

aws cloudformation deploy --stack-name vodv1 --template-file global-s3-assets/video-on-demand-on-aws.template --s3-bucket acousins-vod-guidance-dist-us-east-1  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --region us-east-1

aws s3 rm s3://vodv1-source71e471f1-qxsvtedi4wye/GenAIBZMediaOperationsAgent_3.mp4

aws s3 cp s3://acousins-usstd/GenAIBZMediaOperationsAgent_3.mp4 s3://vodv1-source71e471f1-qxsvtedi4wye/
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';

const app = new cdk.App();
new ImageOptimizationStack(app, 'ImgTransformationStack', {
  env: {
    account: '585008083006',
    region: 'us-east-1',
  },
});

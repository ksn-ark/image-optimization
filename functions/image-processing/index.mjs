// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import Sharp from 'sharp';

const s3Client = new S3Client({
  region: 'eu-west-2',
});

import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { resolve } from 'path';

const TEMP_DIR = '/tmp/';

const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_ASSETS_BUCKET = process.env.assetsBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
  // Validate if this is a GET request
  if (
    !event.requestContext ||
    !event.requestContext.http ||
    !(event.requestContext.http.method === 'GET')
  )
    return sendError(400, 'Only GET method is supported', event);
  // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
  var imagePathArray = event.requestContext.http.path.split('/');
  // get the requested image operations
  var operationsPrefix = imagePathArray.pop();
  // get the original image path images/rio/1.jpg
  imagePathArray.shift();
  var originalImagePath = imagePathArray.join('/');

  var startTime = performance.now();
  // Downloading original image
  let originalImageBody;
  let contentType;
  let frameImageBodyPromise;

  const operationsJSON = Object.fromEntries(
    operationsPrefix.split(',').map((operation) => operation.split('=')),
  );

  try {
    const getOriginalImageCommand = new GetObjectCommand({
      Bucket: S3_ORIGINAL_IMAGE_BUCKET,
      Key: originalImagePath,
    });
    const getOriginalImageCommandOutput = await s3Client.send(
      getOriginalImageCommand,
    );
    console.log(`Got response from S3 for ${originalImagePath}`);

    contentType = getOriginalImageCommandOutput.ContentType;

    if (contentType === 'video/webm') {
      originalImageBody = getOriginalImage(getOriginalImageCommandOutput);
    } else {
      originalImageBody =
        getOriginalImageCommandOutput.Body.transformToByteArray();
    }
  } catch (error) {
    if (error.Code === 'NoSuchKey') {
      return sendError(404, 'Image not found', {
        error: error,
        originalImagePath,
      });
    }
    return sendError(500, 'Error downloading original image', {
      error: error,
      originalImagePath,
    });
  }

  const condition =
    ['webm', 'mp4'].includes(operationsJSON['format']) &&
    contentType === 'video/webm';

  if (operationsJSON['frame']) {
    frameImageBodyPromise = getFrame(
      operationsJSON['frame'],
      condition ? '.webm' : '.png',
    );
  }
  let transformedImage;
  if (condition) {
    transformedImage = await originalImageBody;
    if (operationsJSON['format'] === 'mp4') {
      if (operationsJSON['frame']) {
        transformedImage = await overlayWebmsToBuffer(
          transformedImage,
          await frameImageBodyPromise,
          false,
        );
      }
      transformedImage = await convertWebMToBuffer(transformedImage);
    } else {
      if (operationsJSON['frame']) {
        transformedImage = await overlayWebmsToBuffer(
          transformedImage,
          await frameImageBodyPromise,
          true,
        );
      }
    }
  } else {
    transformedImage =
      contentType === 'video/webm'
        ? getFirstFrameAsSharp(await originalImageBody)
        : Sharp(await originalImageBody, {
            failOn: 'none',
            animated: true,
          });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // execute the requested operations
    // variable holding the server timing header value
    var timingLog =
      'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    try {
      // check if resizing is requested
      var resizingOptions = {};
      if (operationsJSON['width'])
        resizingOptions.width = parseInt(operationsJSON['width']);
      if (operationsJSON['height'])
        resizingOptions.height = parseInt(operationsJSON['height']);

      // check if rotation is needed
      if (imageMetadata.orientation)
        transformedImage = transformedImage.rotate();
      // check if formatting is requested
      if (operationsJSON['format']) {
        var isLossy = false;
        switch (operationsJSON['format']) {
          case 'webp':
            contentType = 'image/webp';
            isLossy = true;
            break;
          case 'png':
            contentType = 'image/png';
            break;
          case 'gif':
            contentType = 'image/gif';
            break;
          default:
            contentType = 'image/webp';
            isLossy = true;
        }
        if (operationsJSON['quality'] && isLossy) {
          transformedImage = transformedImage.toFormat(
            operationsJSON['format'],
            {
              quality: parseInt(operationsJSON['quality']),
            },
          );
        } else
          transformedImage = transformedImage.toFormat(
            operationsJSON['format'],
          );
      } else {
        /// If not format is precised, Sharp converts svg to png by default https://github.com/aws-samples/image-optimization/issues/48
        if (contentType === 'image/svg+xml') contentType = 'image/png';
      }

      const frameImageBody = await frameImageBodyPromise;

      transformedImage = transformedImage.resize(resizingOptions);

      if (frameImageBody) {
        let frameImage = Sharp(frameImageBody, {
          failOn: 'none',
          animated: true,
        });

        if (resizingOptions) {
          frameImage = frameImage.resize(resizingOptions);
        }
        transformedImage = transformedImage.composite([
          { input: await frameImage.toBuffer() },
        ]);
        console.log('compositing complete');
      }
      transformedImage = await transformedImage.toBuffer();
    } catch (error) {
      return sendError(500, 'error transforming image', error);
    }
    timingLog =
      timingLog +
      ',img-transform;dur=' +
      parseInt(performance.now() - startTime);
  }
  // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
  const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

  // upload transformed image back to S3 if required in the architecture
  if (S3_TRANSFORMED_IMAGE_BUCKET) {
    startTime = performance.now();
    try {
      const putImageCommand = new PutObjectCommand({
        Body: transformedImage,
        Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
        Key: originalImagePath + '/' + operationsPrefix,
        ContentType: contentType,
        CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
      });
      const putImageClient = new S3Client({ region: 'us-east-1' });
      await putImageClient.send(putImageCommand);
      timingLog =
        timingLog +
        ',img-upload;dur=' +
        parseInt(performance.now() - startTime);
      // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda.
      if (imageTooBig) {
        return {
          statusCode: 302,
          headers: {
            Location:
              '/' +
              originalImagePath +
              '?' +
              operationsPrefix.replace(/,/g, '&'),
            'Cache-Control': 'private,no-store',
            'Server-Timing': timingLog,
          },
        };
      }
    } catch (error) {
      logError('Could not upload transformed image to S3', error);
    }
  }

  // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
  if (imageTooBig) {
    return sendError(403, 'Requested transformed image is too big', '');
  } else
    return {
      statusCode: 200,
      body: transformedImage.toString('base64'),
      isBase64Encoded: true,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
        'Server-Timing': timingLog,
      },
    };
};

async function getFrame(frame, format) {
  try {
    const getFrameImageCommand = new GetObjectCommand({
      Bucket: S3_ASSETS_BUCKET,
      Key: 'frames/' + frame + '/frame' + format,
    });

    const getFrameImagesCommandOutput =
      await s3Client.send(getFrameImageCommand);
    console.log('got frame');
    if (format === '.webm') {
      return getOriginalImage(getFrameImagesCommandOutput);
    }
    return getFrameImagesCommandOutput.Body.transformToByteArray();
  } catch (error) {
    return undefined;
  }
}

async function getFirstFrameAsSharp(input) {
  const tempImagePath = resolve(TEMP_DIR, 'temp_frame.png');

  // Extract the first frame as a PNG using FFmpeg
  const ffmpegArgs = [
    '-i',
    input, // Input video file
    '-vf',
    'thumbnail', // Extract the first frame (thumbnail)
    '-frames:v',
    '1', // Only extract one frame
    '-q:v',
    '2', // Quality setting for PNG
    tempImagePath,
  ];

  await runFfmpeg(ffmpegArgs);

  // Load the extracted frame into a Sharp instance
  const imageBuffer = await fs.readFile(tempImagePath);
  const sharpInstance = Sharp(imageBuffer);

  // delete the temporary image file
  await fs.unlink(tempImagePath);

  return sharpInstance;
}

function sendError(statusCode, body, error) {
  logError(body, error);
  return { statusCode, body };
}

function logError(body, error) {
  console.log('APPLICATION ERROR', body);
  console.log(error);
}

async function overlayWebmsToBuffer(input1, input2, returnAsWebM) {
  return new Promise((resolve, reject) => {
    // Determine the output format and codec based on the returnAsWebM argument
    const format = returnAsWebM ? 'webm' : 'mp4';
    const codec = returnAsWebM ? 'libvpx' : 'libx264';

    // Spawn the FFmpeg process
    const ffmpeg = spawn('ffmpeg', [
      '-i',
      input1, // Input video 1
      '-i',
      input2, // Input video 2
      '-filter_complex',
      '[0:v][1:v]overlay', // Overlay filter
      '-c:v',
      codec, // Set the appropriate video codec
      '-f',
      format, // Set the output format
      'pipe:1', // Output to stdout
    ]);

    let outputBuffer = [];

    // Collect data from the stdout
    ffmpeg.stdout.on('data', (chunk) => {
      outputBuffer.push(chunk);
    });

    // Handle FFmpeg errors
    ffmpeg.stderr.on('data', (data) => {
      console.error(`FFmpeg error: ${data}`);
    });

    // Resolve the promise when the process is done
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Combine all chunks into a single Buffer
        const videoBuffer = Buffer.concat(outputBuffer);
        resolve(videoBuffer);
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });
  });
}

async function convertWebMToBuffer(inputWebM) {
  return new Promise((resolve, reject) => {
    // Spawn the FFmpeg process
    const ffmpeg = spawn('ffmpeg', [
      '-i',
      inputWebM, // Input WebM file
      '-f',
      'mp4', // Set output format to MP4
      'pipe:1', // Output to stdout
    ]);

    let outputBuffer = [];

    // Collect data from the stdout
    ffmpeg.stdout.on('data', (chunk) => {
      outputBuffer.push(chunk);
    });

    // Handle FFmpeg errors
    ffmpeg.stderr.on('data', (data) => {
      console.error(`FFmpeg error: ${data}`);
    });

    // Resolve the promise when the process is done
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Combine all chunks into a single Buffer
        const videoBuffer = Buffer.concat(outputBuffer);
        resolve(videoBuffer);
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });
  });
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args);

    ffmpeg.stdout.on('data', (data) => console.log(`stdout: ${data}`));
    ffmpeg.stderr.on('data', (data) => console.error(`stderr: ${data}`));

    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        resolve('Operation completed successfully');
      } else {
        reject(`FFmpeg process exited with code ${code}`);
      }
    });
  });
}

async function getOriginalImage(getOriginalImageCommandOutput) {
  try {
    const chunks = [];
    getOriginalImageCommandOutput.Body.on('data', (chunk) => {
      chunks.push(chunk);
    });

    return new Promise((resolve, reject) => {
      getOriginalImageCommandOutput.Body.on('end', () => {
        const originalImageBody = Buffer.concat(chunks);
        resolve(originalImageBody); // This will be a Buffer containing the WebM data
      });
      getOriginalImageCommandOutput.Body.on('error', (err) => {
        console.error('Error reading S3 object:', err);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Could not retrieve image from S3', error);
    throw error;
  }
}

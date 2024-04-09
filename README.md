# HLSFy

This is an extremely simple open source API with a single objective:
transforming any video format into HLS.

- [Running the API](#running-the-api)
- [IMPORTANT: API Auto Stop](#important-api-auto-stop)
- [Concurrency](#concurrency)
- [Usage](#usage)

## Running the API

You can just run the docker hub image with just one command:

```bash
docker run -p 3000:3000 theryston/hlsfy

# for running in background:
docker run -p 3000:3000 -d theryston/hlsfy
```

That's it, the API will already be running on port 3000 without you needing to
do any extra configuration

## IMPORTANT: API Auto Stop

By default, every 5 seconds an internal process will run and check if there is a
video in process or that needs to be processed, if not, it will AUTOMATICALLY
STOP RUNNING (it will be an exit with status 0).

This happens to reduce the costs of keeping this service running, since in most
cases the machines are charged per execution time.

You can disable this auto-stop functionality by setting the environment variable
`IGNORE_CHECK_PROCESS="true"`

## Concurrency

The API is using a simple queue to process videos. It's possible to add multiple
videos to the queue at the same time.

Just set the environment variable `CONCURRENCY="3"` to limit the number of
concurrent processes.

The default value is `3`.

## Process Status

The API has the following statuses:

- `pending`: the process is waiting to be processed
- `processing`: the process is currently being processed
- `failed`: the process failed to be processed
- `done`: the process was processed successfully

## Usage

To use this API is very simple, it only has three routes: `POST /`, `GET /` and
`GET /:id`, let's dive deeper into them:

### POST /

This wheel is used to add a video to the queue to be processed, just call it by
passing the following body:

```json
{
  "source": "https://example.com/video.mp4", // (required) the url of the original video to be processed
  "defaultAudioLang": "en", // (optional) the default audio language to be added to the HLS
  "subtitles": [ // (optional) the list of subtitles
    {
      "url": "https://example.com/subtitles.vtt",
      "language": "en"
    }
  ],
  "qualities": [ // (required) the list of qualities to be processed
    {
      "height": 1080, // (required) the height of the video
      "bitrate": 6500 // (required) the bitrate of the video
    },
    {
      "height": 720,
      "bitrate": 4000
    }
    // You can add more qualities here
  ],
  "s3": { // (required) the s3 data to store the processed video
    "bucket": "your bucket name", // (required) the bucket name
    "region": "us-east-1", // (required) the region
    "accessKeyId": "YOUR-ACCESS-KEY-ID", // (required) the access key id
    "secretAccessKey": "YOUR-SECRET-ACCESS-KEY", // (required) the secret access key,
    "path": "SOME-PATH", // (required) the path to store the video in the bucket
    "endpoint": "https://s3.us-east-005.backblazeb2.com" // (optional) the endpoint
  }
}
```

This route you return the following JSON:

```json
{
  "message": "Added to queue",
  "id": 5, // the id of the process
  "status": "pending", // the status of the process
  "source": "https://example.com/video.mp4" // the original source
}
```

### GET /

This route is used to check all of the processes, you can just call it:

```bash
curl -X GET "http://localhost:3000?limit=10" // Limit the number of processes. The limit is optional and the default value is 100
```

This route will return the following JSON:

```json
[
  {
    "id": 2, // the id of the process
    "status": "processing", // the status of the process
    "source": "https://example.com/video.mp4" // the original source
  },
  {
    "id": 1, // the id of the process
    "status": "processing", // the status of the process
    "source": "https://example.com/video.mp4" // the original source
  }
]
```

### GET /:id

This route is used to check the status of a process, you can just call it with
the process id:

```bash
curl -X GET "http://localhost:3000/1"
```

This route will return the following JSON:

```json
{
  "id": 1, // the id of the process
  "status": "failed", // the status of the process
  "source": "https://example.com/video.mp4" // the original source
}
```

## Nice!

Thank you for using HLSFy!

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/**
 * Decode a GIF from a given URL or File and return a ReadableStream of VideoFrame frames,
 * along with the calculated bitrate based on the frame durations, total frame count, and frame rate.
 *
 * @param input - The input GIF as a URL string or File object.
 * @returns A promise that resolves with an object containing the frames stream, estimated bitrate, and frame rate.
 */
export async function decodeGifStream(input: string | File): Promise<{ framesStream: ReadableStream<VideoFrame>, bitrate: number, frameRate: number }> {
  let data: ArrayBuffer;

// Load the GIF data as an ArrayBuffer
  if (typeof input === 'string') {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error("Failed to fetch GIF data.");
    }
    data = await response.arrayBuffer();
  } else {
    data = await input.arrayBuffer();
  }

  // Create an ImageDecoder using a ReadableStream from the data
  const imageDecoder = new ImageDecoder({
    data: new Blob([data]).stream(),
    type: "image/gif",
  });


  // Arrays to store frames and durations
  const frames: VideoFrame[] = [];
  let totalDurationUs = 0; // Total duration in microseconds
  const defaultDurationUs = 100000; // Default duration per frame in microseconds (0.1 seconds)

  let imageIndex = 0;
  while (true) {
    // Decode the current frame at the given index
    const result = await imageDecoder.decode({ frameIndex: imageIndex });
    frames.push(result.image); // Enqueue the decoded image frame to the stream

    // Accumulate total duration
    const durationUs = result.image.duration ?? defaultDurationUs; // duration in microseconds
    totalDurationUs += durationUs;

    // If we have decoded all frames, close the loop
    const track = imageDecoder.tracks.selectedTrack;
    if (!track || (imageDecoder.complete && imageIndex + 1 >= track.frameCount)) {
      break;
    }

    // Increment the frame index to decode the next frame
    imageIndex++;
  }

  const frameCount = frames.length;
  let durationSeconds = totalDurationUs / 1e6; // Convert microseconds to seconds

  // Handle cases where totalDurationUs is zero
  if (durationSeconds === 0) {
    // Set a default duration
    durationSeconds = frameCount * (defaultDurationUs / 1e6);
  }

  // Calculate bitrate in bits per second
  const fileSizeBytes = data.byteLength;
  const fileSizeBits = fileSizeBytes * 8;
  const bitrate = Math.min(1e6, Math.max(500_000, Math.round(fileSizeBits / durationSeconds)));

  // Calculate frame rate
  const frameRate = Math.min(60, Math.max(1, Math.round(frameCount / durationSeconds)));

  const framesStream = new ReadableStream<VideoFrame>({
    async start(controller) {
      for (const frame of frames) {
        controller.enqueue(frame); // Enqueue the frame to the stream
      }
      controller.close(); // Close the stream after enqueuing all frames
      frames.length = 0; // Clear the frames array
    },
  });

  return { framesStream, bitrate, frameRate };
}

/**
 * Converts a GIF (URL or File object) to an MP4 File and returns the File object with the correct file name.
 *
 * @param input - The input GIF as a URL string or File object.
 * @returns A File representing the converted MP4 file with file path info.
 *
 * @example
 * // Example with URL
 * const url = "https://example.com/animation.gif";
 * const mp4File = await convertGifToMp4(url);
 * console.log(mp4File.name); // "animation.mp4"
 *
 * @example
 * // Example with File object
 * const file = new File([gifData], "example.gif", { type: "image/gif" });
 * const mp4File = await convertGifToMp4(file);
 * console.log(mp4File.name); // "example.mp4"
 */
export async function convertGifToMp4(input: string | File): Promise<File | undefined> {
  try {
    // Step 1: Decode GIF frames as a stream, and get the estimated bitrate and frame rate
    const { framesStream, bitrate, frameRate } = await decodeGifStream(input);
    console.log(`Estimated Bitrate: ${bitrate} bps`);
    console.log(`Frame Rate: ${frameRate} fps`);

    // Get the first frame to determine video width and height
    const reader = framesStream.getReader();
    let { value, done } = await reader.read();
    let firstFrame: VideoFrame | undefined | null = value;
    if (done || !firstFrame) {
      throw new Error("Failed to decode any frames from the GIF.");
    }

    const width = firstFrame.displayWidth % 2 === 0 ? firstFrame.displayWidth : firstFrame.displayWidth + 1;
    const height = firstFrame.displayHeight % 2 === 0 ? firstFrame.displayHeight : firstFrame.displayHeight + 1;

    // Step 2: Create a pull-based stream including the first frame
    const framesWithFirst = new ReadableStream<VideoFrame>({
      async pull(controller) {
        // Enqueue the first frame first
        if (firstFrame) {
          controller.enqueue(firstFrame);
          firstFrame = null; // Mark first frame as processed
        }

        // Pull frames from the original framesStream
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
        } else {
          controller.enqueue(value);
        }
      },
    });

    // Step 3: Use the new pull-based frames stream for encoding
    const mp4Buffer = await encodeToMp4Stream(framesWithFirst, width, height, bitrate, frameRate);

    // Step 4: Generate the file name with .mp4 extension
    const fileName = getFileNameWithMp4(input);

    // Step 5: Create a File object with the MP4 buffer and file name
    const mp4File = new File([mp4Buffer], fileName, { type: 'video/mp4' });

    return mp4File;
  } catch (error) {
    console.error("Error during conversion:", error);
    return undefined;
  }
}

/**
 * Helper function to extract the file name and change its extension to .mp4
 * 
 * @param input - The input URL string or File object
 * @returns The file name with .mp4 extension
 */
function getFileNameWithMp4(input: string | File): string {
  if (typeof input === 'string') {
    // Extract file name from URL and replace the extension with .mp4
    const url = new URL(input);
    const fileName = url.pathname.split('/').pop() || 'video';
    return fileName.replace(/\.[^/.]+$/, "") + ".mp4";
  } else if (input instanceof File) {
    // Extract file name from File object and replace the extension with .mp4
    return input.name.replace(/\.[^/.]+$/, "") + ".mp4";
  }
  return "video.mp4"; // Default fallback
}

/**
 * Function to encode frames from a ReadableStream to an MP4 file
 * 
 * @param framesStream - The ReadableStream of frames to encode
 * @param width - The width of the video
 * @param height - The height of the video
 * @param bitrate - The bitrate to use for encoding
 * @param frameRate - The frame rate to use for encoding
 * @returns A promise that resolves to an ArrayBuffer containing the MP4 file
 */
export async function encodeToMp4Stream(framesStream: ReadableStream<VideoFrame>, width: number, height: number, bitrate: number, frameRate: number): Promise<ArrayBuffer> {
  // Initialize the muxer with video configuration
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: width,
      height: height,
      frameRate: frameRate, // Frame rate in timescale units (milliseconds)
    },
    fastStart: 'in-memory',
  });

  // Configure the video encoder
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), // Add encoded video chunk to the muxer
    error: (e) => console.error(e), // Log any encoding errors
  });

  videoEncoder.configure({
    codec: 'avc1.42001f',
    width: width,
    height: height,
    bitrate: bitrate,
    framerate: frameRate, // Frame rate in timescale units (milliseconds)
  });

  const reader = framesStream.getReader();
  try {
    while (true) {
      // Read frames from the reader until there are no more frames
      const { value: frameData, done } = await reader.read();
      if (done) break;

      videoEncoder.encode(frameData); // Encode the frame, ensuring it is a keyframe
      frameData.close(); // Close the frame to release resources
    }

    await videoEncoder.flush(); // Ensure all frames are processed
    videoEncoder.close(); // Close the encoder after flushing
    muxer.finalize(); // Finalize the MP4 muxing process

    return muxer.target.buffer; // Return the final MP4 file as an ArrayBuffer
  } catch (e) {
    throw e;
  } finally {
    reader.releaseLock();
  }
}
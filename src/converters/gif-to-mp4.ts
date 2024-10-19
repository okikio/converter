import { Muxer, ArrayBufferTarget } from "mp4-muxer";

// Function to decode a GIF from a given URL and return a ReadableStream of ImageBitmap frames
export async function decodeGifStream(input: string | File): Promise<ReadableStream<VideoFrame>> {
  let data: ReadableStream<Uint8Array>;
  if (typeof input === 'string') {
    const response = await fetch(input);
    if (!response.body) {
      throw new Error("Failed to get ReadableStream from the response.");
    }

    data = response.body;
  } else {
    data = input.stream();
  }

  // Create an ImageDecoder using a ReadableStream from the response
  const imageDecoder = new ImageDecoder({
    data,
    type: "image/gif",
  });

  return new ReadableStream<VideoFrame>({
    async pull(controller) {
      let imageIndex = 0;
      try {
        while (true) {
          // Decode the current frame at the given index
          const result = await imageDecoder.decode({ frameIndex: imageIndex });
          controller.enqueue(result.image); // Enqueue the decoded image frame to the stream

          const track = imageDecoder.tracks.selectedTrack;

          // If we have decoded all frames, close the loop
          if (!track || (imageDecoder.complete && imageIndex + 1 >= track.frameCount)) {
            controller.close();
            break;
          }

          // Increment the frame index to decode the next frame
          imageIndex++;
        }
      } catch (e) {
        if (e instanceof RangeError && imageDecoder.complete) {
          // Close the stream when we reach the end
          controller.close();
        } else {
          // Handle any other errors
          controller.error(e);
        }
      }
    },
  });
}

// Function to encode frames from a ReadableStream to an MP4 file
export async function encodeToMp4Stream(framesStream: ReadableStream<VideoFrame>, width: number, height: number): Promise<ArrayBuffer> {
  // Initialize the muxer with video configuration
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: width,
      height: height,
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
    bitrate: 1e6, // Set bitrate for the video encoding
  });

  const reader = framesStream.getReader();
  try {
    while (true) {
      // Read frames from the reader until there are no more frames
      const { value: frameData, done } = await reader.read();
      if (done) break;

      // Create a new VideoFrame from the ImageBitmap
      const frame = new VideoFrame(frameData, {
        timestamp: frameData.timestamp, // Use the frame timestamp
      });
      videoEncoder.encode(frame, { keyFrame: true }); // Encode the frame, ensuring it is a keyframe
      frame.close(); // Close the frame to release resources
    }

    await videoEncoder.flush(); // Ensure all frames are processed
    muxer.finalize(); // Finalize the MP4 muxing process

    return muxer.target.buffer; // Return the final MP4 file as an ArrayBuffer
  } catch (e) { throw e; }
  finally { reader.releaseLock(); }
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
    // Step 1: Decode GIF frames as a stream
    const framesStream = await decodeGifStream(input);

    // Get the first frame to determine video width and height
    const reader = framesStream.getReader();
    let { value, done } = await reader.read();
    let firstFrame: VideoFrame | undefined | null = value;
    if (done || !firstFrame) {
      throw new Error("Failed to decode any frames from the GIF.");
    }

    const width = firstFrame.displayWidth;
    const height = firstFrame.displayHeight;

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
        } else {
          controller.enqueue(value);
        }
      },
    });

    // Step 3: Use the new pull-based frames stream for encoding
    const mp4Buffer = await encodeToMp4Stream(framesWithFirst, width, height);

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


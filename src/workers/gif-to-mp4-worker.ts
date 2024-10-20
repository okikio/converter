/// <reference lib="webworker" />

import { ThreadWorker } from "../vendor/poolifier/worker/thread-worker.ts"
import { convertGifToMp4 } from "../converters/gif-to-mp4.ts";

export interface ConverterInput {
  url: string;
  file?: File | undefined;
  index: number;
}

export type ConverterMessage = ({
  status: 'success',
  file?: File
} | {
  status: 'error'
}) & { index: number }

export interface ConverterOutput {
  message: ConverterMessage;
  data?: ConverterInput;
}

class GifConverterThreadWorker extends ThreadWorker<ConverterInput, ConverterOutput> {
  constructor() {
    super(async (data?: ConverterInput) => await this.process(data), {
      maxInactiveTime: 60000, // Terminate the worker if inactive for 60 seconds.
    })
  }

  /**
   * This worker handles the conversion of a GIF to MP4.
   * @param data - The URL of the GIF to convert.
   * @returns An object containing the MP4 file data.
   */
  private async process(data?: ConverterInput): Promise<ConverterOutput> {
    const { url, file, index } = data ?? { url: "about:blank", index: 0 }

    try {
      if (url === "about:blank") throw new Error("Invalid URL");

      const videoFile = await convertGifToMp4(file ?? url);
      return {
        message: {
          status: 'success',
          file: videoFile,
          index
        },
        data
      };
    } catch {
      return {
        message: {
          status: 'error',
          index
        },
        data
      };
    }
  }
}

export default new GifConverterThreadWorker()
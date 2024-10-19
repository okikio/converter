/// <reference lib="webworker" />

import { ThreadWorker } from "./_poolifier/thread-worker.ts"
import { convertGifToMp4 } from "../converters/gif-to-mp4.ts";

export interface ConverterInput {
  url: string;
  index: number;
}

export type ConverterOutput = ({
  status: 'success',
  file?: File 
} | {
  status: 'error'
}) & { index: number }

class GifConverterThreadWorker extends ThreadWorker<ConverterInput, ConverterOutput> {  
  constructor() {
    super(async (data?: ConverterInput) => await this.process(data), {
      maxInactiveTime: 60000, // Terminate the worker if inactive for 60 seconds.
    })
    console.log({ id: this.id })
  }

  /**
   * This worker handles the conversion of a GIF to MP4.
   * @param data - The URL of the GIF to convert.
   * @returns An object containing the MP4 file data.
   */
  private async process(data?: ConverterInput): Promise<ConverterOutput> {
    const { url, index } = data ?? { url: "about:blank", index: 0 }

    console.log({
      data
    })
    try {
      if (url === "about:blank") throw new Error("Invalid URL");

      const videoFile = await convertGifToMp4(url);
      return ({
        status: 'success',
        file: videoFile,
        index
      });
    } catch {
      return ({
        status: 'error',
        index
      });
    }
  }
}

export default new GifConverterThreadWorker()
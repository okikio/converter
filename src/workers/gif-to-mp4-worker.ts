/// <reference lib="webworker" />

import { ThreadWorker } from "../vendor/poolifier/worker/thread-worker.ts"
import { convertGifToMp4 } from "../converters/gif-to-mp4.ts";

import { basename, fromFileUrl } from "@std/path/posix";

import { createStorage } from "unstorage";
import opfsDriver from "../libs/opfs.ts";

export interface ConverterInput {
  filePath: string;
  index: number;
}

export type ConverterMessage = ({
  status: 'success',
  filePath: string
} | {
  status: 'error'
}) & { index: number }

export interface ConverterOutput {
  message: ConverterMessage;
  data?: ConverterInput;
}

const inputStorage = createStorage({
  driver: opfsDriver({ base: "tmp" }),
});

const outputStorage = createStorage({
  driver: opfsDriver({ base: "output" }),
});

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
    const { filePath, index } = data ?? { url: "about:blank", index: 0 }

    try {
      if (filePath === "about:blank" || !filePath) 
        throw new Error(`Invalid File Path for Processing ${filePath}`);

      const file = await inputStorage.getItem<File>(filePath!);
      if (!file) throw new Error(`Couldn't find file at file path ${filePath}`);

      const videoFile = await convertGifToMp4(file);
      if (!videoFile) throw new Error(`Error converting file at file path ${filePath}`);

      await outputStorage.setItem(videoFile.name, videoFile);
      return {
        message: {
          status: 'success',
          filePath: videoFile.name,
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
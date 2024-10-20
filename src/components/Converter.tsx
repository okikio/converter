import type {
  ConverterInput,
  ConverterOutput,
} from "../workers/gif-to-mp4-worker.ts";

import WorkerURL from "../workers/gif-to-mp4-worker?worker&url";

import { convertGifToMp4 } from "../converters/gif-to-mp4.ts";

import { createResource, createSignal, For, Show } from "solid-js";
import { effect } from "solid-js/web";
import "tailwindcss/tailwind.css";

import { BlobReader, BlobWriter, ZipWriter } from "@zip-js/zip-js";
import { chunkArray } from "../utils/utils.ts";
import { basename } from "@std/path/posix";

export function Converter() {
  const [gifUrls, setGifUrls] = createSignal<
    { url: string; file?: File; filePath: string; selected: boolean; errored?: boolean }[]
  >([]);
  const [mp4Videos, setMp4Videos] = createSignal<
    { url: string; filePath: string; selected: boolean }[]
  >([]);
  const [viewMode, setViewMode] = createSignal<"grid" | "list">("grid");
  const [showAllInputs, setShowAllInputs] = createSignal(false);
  const [latestInputGifs, setLatestInputGifs] = createSignal<
    { url: string; selected: boolean; errored?: boolean }[]
  >([]);
  
  const [conversionProgress, setConversionProgress] = createSignal(0);
  const [totalGifs, setTotalGifs] = createSignal(0);
  const [converting, setConverting] = createSignal(false);
  const [useThreadPool, setUseThreadPool] = createSignal(true); // New state to track checkbox

  const [dynamicPool] = createResource(() => "document" in globalThis, async (test) => {
    if (test) {
      const { availableParallelism, DynamicThreadPool, PoolEvents } =
        await import("@poolifier/poolifier-web-worker");

      // Set up a fixed worker pool
      const _pool = new DynamicThreadPool<ConverterInput, ConverterOutput>(
        Math.max(1, Math.floor(availableParallelism() / 2)),
        availableParallelism(),
        new URL(WorkerURL, location.origin),
        {
          errorEventHandler: (e) => {
            console.error("Worker pool error:", e);
          },
          messageEventHandler: (e) => {
            console.log({ e })
          },
          startWorkers: true
        }
      );

      _pool?.eventTarget?.addEventListener(PoolEvents.ready, () =>
        console.info("Pool is ready")
      );
      _pool.eventTarget?.addEventListener(PoolEvents.busy, () =>
        console.info("Pool is busy")
      );

      return { pool: _pool, availableParallelism, PoolEvents };
    }
  });

  const handleSearch = (event: Event) => {
    event.preventDefault();
    const input = (event.target as HTMLFormElement)["search"].value.trim();
    if (input && !gifUrls().some((gif) => gif.url === input)) {
      const filePath = basename(input);
      fetch(input)
        .then((response) => {
          if (!response.ok) {
            throw new Error("Failed to load GIF");
          }
          setGifUrls([...gifUrls(), { url: input, filePath, selected: false, errored: false }]);
        })
        .catch(() => {
          setGifUrls([
            ...gifUrls(),
            { url: input, filePath, selected: false, errored: true },
          ]);
        });
    }
  };

  const handleUpload = async (event: Event) => {
    const files = (event.target as HTMLInputElement).files;
    if (files) {
      const urls = Array.from(files).map((file) => {
        return {
          url: URL.createObjectURL(file),
          file,
          filePath: file.name,
          selected: false,
        };
      });
      console.log({urls})
      const newUrls = urls.filter(
        (urlObj) => !gifUrls().some((gif) => gif.url === urlObj.url)
      );
      setGifUrls([...gifUrls(), ...newUrls]);
    }
  };

  const convertAllToMp4 = async () => {
    // Step 1: Filter out any GIFs that encountered errors
    const validGifs = gifUrls().filter((gif) => !gif.errored);

    // Set total GIFs for tracking progress
    setTotalGifs(validGifs.length);
    setConversionProgress(0);
    setConverting(true);

    const convertedVideos: {
      url: string;
      filePath: string;
      selected: boolean;
    }[] = [];

    const pool = dynamicPool();
    if (pool && useThreadPool()) {
      console.log({
        UseThreadPools: true,
        pool,
      })
      // Distribute conversion tasks among worker threads
      await Promise.all(
        Array.from(validGifs.entries(), async ([index, gif]) => {
          const result = await pool.pool.execute({ url: gif.url, file: gif.file, index });
          const output = result.message;

          if (output.status === "success" && output.file) {
            const videoUrl = URL.createObjectURL(output.file);
            convertedVideos.push({
              url: videoUrl,
              filePath:
                gif.filePath?.replace(/\.gif$/, ".mp4") ??
                `video${index}.mp4`,
              selected: false,
            });

            setConversionProgress((prev) => prev + 1);
          } else {
            // Handle errors by marking them in the UI
            const updatedGifs = [...gifUrls()];
            updatedGifs[index].errored = true;
            setGifUrls(updatedGifs);
          }
        })
      );
    } else {
      // Step 2: Chunk the valid GIFs into groups of 2
      const gifChunks = chunkArray(Array.from(validGifs.entries()), 2);

      // Step 3: Process each chunk sequentially using Promise.all
      for (const chunk of gifChunks) {
        const chunkResults = await Promise.allSettled(
          chunk.map(async ([index, gif]) => {
            const videoFile = await convertGifToMp4(gif.file ?? gif.url);
            const videoUrl = URL.createObjectURL(videoFile!);
            return {
              url: videoUrl,
              filePath:
                gif.filePath?.replace(/\.gif$/, ".mp4") ??
                `video${index}.mp4`,
              selected: false,
            };
          })
        );

        const videos = chunkResults.map((result, index) => {
          if (result.status === "fulfilled") {
            convertedVideos.push(result.value);
            return result.value;
          } else {
            // Handle errors by marking them in the UI
            const updatedGifs = [...gifUrls()];
            updatedGifs[chunk[index][0]].errored = true;
            setGifUrls(updatedGifs);
          }
        }).filter(video => video);

        // Step 4: Update the progress after each chunk is processed
        setConversionProgress((prev) => prev + videos.length);
      }
    }

    // Step 5: Set the converted MP4 videos in state and reset progress
    setMp4Videos(convertedVideos);
    setConverting(false);
  };

  /**
   * Downloads MP4 videos either as individual files or as a zip archive.
   *
   * @param type - Whether to download all videos or only selected ones ("all" or "selected").
   * @param asZip - Whether to download the videos as a zip file.
   */
  const downloadVideos = async (type: "all" | "selected", asZip: boolean) => {
    // Step 1: Filter videos based on the selection type
    const videos =
      type === "all"
        ? mp4Videos()
        : mp4Videos().filter((video) => video.selected);

    // If downloading as zip, we proceed with zipping logic
    if (asZip) {
      try {
        // Step 2: Initialize the ZipWriter to create a zip file in memory
        const zipFileWriter = new BlobWriter("application/zip");
        const zipWriter = new ZipWriter(zipFileWriter);

        // Step 3: Loop through each video and add it to the zip file
        for (const video of videos) {
          try {
            const response = await fetch(video.url);
            const blob = await response.blob();

            // Add the MP4 file to the zip using its file name
            const fileName = video.filePath.endsWith(".mp4")
              ? video.filePath
              : `${video.filePath}.mp4`;
            await zipWriter.add(fileName, new BlobReader(blob));
          } catch (videoError) {
            console.error(
              `Failed to fetch and add video ${video.filePath} to zip:`,
              videoError
            );
          }
        }

        // Step 4: Finalize the zip file
        const zipBlob = await zipWriter.close();

        // Step 5: Trigger a download for the zip file
        const a = document.createElement("a");
        a.href = URL.createObjectURL(zipBlob);
        a.download = "videos.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (error) {
        console.error("Failed to create or download zip file:", error);
      }
    } else {
      // Logic for downloading videos individually (covered previously)
      try {
        if ("showDirectoryPicker" in window) {
          try {
            // Step 3: Request directory access from the user
            const directoryHandle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker();

            const counter = new Map<string, number>()

            // Step 4: Loop through each video and save it in the selected directory
            for (const video of videos) {
              try {
                if (!counter.has(video.filePath)) {
                  counter.set(video.filePath, 0);
                }

                const count = counter.get(video.filePath) ?? 0;
                const countSuffix = count === 0 ? "" : count;

                  // Create a new file handle for each video in the directory
                  const fileName = video.filePath.endsWith(".mp4")
                    ? video.filePath.replace(".mp4", `${countSuffix}.mp4`)
                    : `${video.filePath}${countSuffix}.mp4`;

                    
                const fileHandle = await directoryHandle.getFileHandle(
                  fileName,
                  { create: true }
                );

                // Create a writable stream for the file
                const writable = await fileHandle.createWritable();

                // Fetch the video data and write it to the file
                const response = await fetch(video.url);
                const blob = await response.blob();
                await writable.write(blob);
                await writable.close();

                counter.set(
                  video.filePath,
                  (counter.get(video.filePath) ?? 0) + 1
                );
              } catch (videoError) {
                console.error(
                  `Failed to save video ${video.filePath}:`,
                  videoError
                );
              }
            }
          } catch (error) {
            console.error("Failed to select a directory or save files:", error);
          }
        } else {
          for (const video of videos) {
            // Fallback for browsers without showSaveFilePicker
            const a = document.createElement("a");
            a.href = video.url;
            a.download = video.filePath.endsWith(".mp4")
              ? video.filePath
              : `${video.filePath}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        }
      } catch (error) {
        console.error("Failed to download video:", error);
      }
    }
  };

  const toggleGifSelection = (index: number) => {
    const updatedGifs = [...gifUrls()];
    updatedGifs[index].selected = !updatedGifs[index].selected;
    console.log({
      updatedGifs,
      index,
    });
    setGifUrls(updatedGifs);
  };

  const toggleVideoSelection = (index: number) => {
    const updatedVideos = [...mp4Videos()];
    updatedVideos[index].selected = !updatedVideos[index].selected;
    setMp4Videos(updatedVideos);
  };

  const deleteSelectedGifs = () => {
    gifUrls().forEach((gif) => {
      if (gif.selected) {
        URL.revokeObjectURL(gif.url);
      }
    });
    setGifUrls(gifUrls().filter((gif) => !gif.selected));
  };

  effect(() => {
    const urls = Array.from(gifUrls());
    setLatestInputGifs(urls.slice(-5));
  });

  return (
    <div class="min-h-screen flex flex-col items-center bg-gray-100 p-6">
      <h1 class="text-3xl font-bold mb-4">GIF-to-MP4 Converter</h1>
      <form onSubmit={handleSearch} class="mb-4 w-full max-w-md">
        <div class="relative">
          <input
            type="text"
            name="search"
            class="block w-full p-4 pl-10 text-sm border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
            placeholder="Enter GIF URL..."
          />
          <button
            type="submit"
            class="text-white absolute right-2.5 bottom-2.5 bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-4 py-2"
          >
            Add GIF
          </button>
        </div>
      </form>

      <div class="mb-4">
        <input
          type="file"
          multiple
          accept="image/gif"
          onChange={handleUpload}
          class="text-sm text-grey-500"
        />
      </div>

      {/* Checkbox to configure if thread pool should be used */}
      <div class="flex items-center mb-4">
        <input
          type="checkbox"
          id="useThreadPool"
          checked={useThreadPool()}
          onChange={() => setUseThreadPool(!useThreadPool())}
          class="mr-2"
        />
        <label for="useThreadPool" class="text-sm font-medium">
          Use Thread Pool for Conversion
        </label>
      </div>

      <button
        onClick={convertAllToMp4}
        class="mb-4 text-white bg-green-700 hover:bg-green-800 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-6 py-2"
      >
        Convert All to MP4
      </button>

      {/* Progress bar */}
      <Show when={converting()}>
        <div class="w-full max-w-xl bg-gray-300 rounded-lg h-6 mb-4">
          <div
            class="bg-blue-600 h-6 rounded-lg text-center text-white whitespace-nowrap"
            style={{ width: `${(conversionProgress() / totalGifs()) * 100}%` }}
          >
            {conversionProgress()} / {totalGifs()} GIFs converted
          </div>
        </div>
      </Show>

      <button
        onClick={deleteSelectedGifs}
        class="mb-4 text-white bg-red-700 hover:bg-red-800 focus:ring-4 focus:ring-red-300 font-medium rounded-lg text-sm px-6 py-2"
      >
        Delete Selected GIFs
      </button>

      <div class="flex gap-4 mb-4">
        <button
          onClick={() => setViewMode("grid")}
          class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Grid View
        </button>
        <button
          onClick={() => setViewMode("list")}
          class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          List View
        </button>
      </div>

      <h2 class="text-2xl font-semibold mt-6 mb-4">
        GIF Input List (Latest 5)
      </h2>
      <div class="w-full max-w-4xl flex overflow-x-auto gap-4 mb-6">
        {latestInputGifs().map((gif, index) => (
          <div
            class={`relative w-32 p-4 border rounded-lg shadow-md cursor-pointer hover:shadow-lg ${
              gif.selected
                ? "bg-blue-200"
                : gif.errored
                ? "bg-red-200"
                : "bg-white"
            }`}
            onClick={() => toggleGifSelection(index)}
          >
            <img
              src={gif.url}
              alt={`GIF ${index + 1}`}
              class="rounded-lg w-full h-32 object-cover"
            />
            <div class="mt-2">
              <p class="font-semibold text-center">GIF {index + 1}</p>
              <Show when={gif.errored}>
                <p class="text-red-600 text-sm text-center">Failed to load</p>
              </Show>
            </div>
          </div>
        ))}
      </div>
      <Show when={gifUrls().length > 5}>
        <button
          onClick={() => setShowAllInputs(true)}
          class="mb-4 text-white bg-gray-700 hover:bg-gray-800 focus:ring-4 focus:ring-gray-300 font-medium rounded-lg text-sm px-6 py-2"
        >
          Show All Inputs
        </button>
      </Show>

      <Show when={showAllInputs()}>
        <div class="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
          <div class="bg-white rounded-lg p-6 max-w-4xl w-full h-3/4 overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-2xl font-semibold">All GIF Inputs</h2>
              <button
                onClick={() => setShowAllInputs(false)}
                class="text-black bg-gray-200 hover:bg-gray-300 rounded-full p-2"
              >
                &times;
              </button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
              <For each={gifUrls()}>
                {(gif, index) => (
                  <div
                    class={`relative p-4 border rounded-lg shadow-md cursor-pointer hover:shadow-lg ${
                      gif.selected
                        ? "bg-blue-200"
                        : gif.errored
                        ? "bg-red-200"
                        : "bg-white"
                    }`}
                    onClick={() => toggleGifSelection(index())}
                  >
                    <img
                      src={gif.url}
                      alt={`GIF ${index() + 1}`}
                      class="rounded-lg w-full h-32 object-cover"
                    />
                    <div class="mt-2">
                      <p class="font-semibold text-center">GIF {index() + 1}</p>
                      <Show when={gif.errored}>
                        <p class="text-red-600 text-sm text-center">
                          Failed to load
                        </p>
                      </Show>
                      <Show when={gif.selected}>
                        <p class="text-blue-600 text-sm text-center">
                          Selected
                        </p>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

      <h2 class="text-2xl font-semibold mt-6 mb-4">MP4 Videos</h2>
      <div
        class={
          viewMode() === "grid"
            ? "w-full max-w-4xl grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 mt-6"
            : "w-full max-w-4xl flex flex-col gap-6 mt-6"
        }
      >
        <For each={mp4Videos()}>
          {(video, index) => (
            <div
              class={`relative p-4 border rounded-lg shadow-md cursor-pointer hover:shadow-lg ${
                video.selected ? "bg-blue-200" : "bg-white"
              }`}
              onClick={() => toggleVideoSelection(index())}
            >
              <video
                src={video.url}
                controls
                class="rounded-lg w-full mt-4"
              ></video>
              <div class="mt-2">
                <p class="font-semibold">Video {index() + 1}</p>
                <p class="text-sm text-gray-500">
                  Click to {video.selected ? "deselect" : "select"}
                </p>
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="mt-8">
        <div class="inline-flex rounded-md shadow-sm" role="group">
          <button
            class="bg-gray-800 text-white px-4 py-2 rounded-l-md hover:bg-gray-700"
            onClick={() => downloadVideos("all", false)}
          >
            Download All
          </button>
          <button
            class="bg-gray-800 text-white px-4 py-2 hover:bg-gray-700"
            onClick={() => downloadVideos("selected", false)}
          >
            Download Selected
          </button>
          <button
            class="bg-gray-800 text-white px-4 py-2 rounded-r-md hover:bg-gray-700"
            onClick={() => downloadVideos("all", true)}
          >
            Download All as ZIP
          </button>
          <button
            class="bg-gray-800 text-white px-4 py-2 hover:bg-gray-700"
            onClick={() => downloadVideos("selected", true)}
          >
            Download Selected as ZIP
          </button>
        </div>
      </div>
    </div>
  );
}

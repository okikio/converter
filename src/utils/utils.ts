/**
 * Utility function to chunk an array into smaller arrays of a specified size.
 * 
 * @param array - The array to be chunked.
 * @param size - The size of each chunk.
 * @returns An array of arrays, each containing `size` elements.
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunkedArr: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunkedArr.push(array.slice(i, i + size));
  }
  return chunkedArr;
}
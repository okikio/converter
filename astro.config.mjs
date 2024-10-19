// @ts-check
import { defineConfig } from 'astro/config';

import tailwind from '@astrojs/tailwind';
import solidJs from '@astrojs/solid-js';

// https://astro.build/config
export default defineConfig({
  integrations: [tailwind(), solidJs()],
  vite: {
    build: {
      target: "ES2022" // <--------- ✅✅✅✅✅✅
    },
    optimizeDeps: {
      exclude: ["@poolifier/poolifier-web-worker"]
    },
    esbuild: {
      target: "es2022"
    }
  }
});
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  // @aihub/core is a devDependency, so it is bundled; only `sharp` (native) stays external.
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The `aihub` CLI ships inside the app and runs on its runtime (ELECTRON_RUN_AS_NODE).
          cli: resolve(__dirname, '../../packages/cli/src/index.ts'),
        },
      },
    },
  },
  // Sandboxed preloads must be CommonJS.
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: { plugins: [react(), tailwindcss()], build: { minify: true } },
});

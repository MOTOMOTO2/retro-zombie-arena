import { defineConfig } from 'vite';

/**
 * The voice tools keep a Python environment and model caches under tools/
 * (tens of thousands of files, some of them HTML). Left to itself Vite would
 * crawl every .html file in the project for dependencies and watch every file
 * for changes, which made the first page load take half a minute.
 */
const TOOL_CACHES = ['**/tools/.voicegen/**', '**/tools/.kokoro/**'];

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 900,
  },
  // The game has one page; only look there for dependencies to pre-bundle.
  optimizeDeps: { entries: ['index.html'] },
  server: { host: '127.0.0.1', port: 5173, watch: { ignored: TOOL_CACHES } },
  preview: { host: '127.0.0.1', port: 4173 },
});

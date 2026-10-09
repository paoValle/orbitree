import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // `@orbitree/core` is TypeScript source in this workspace, not a published build:
        // bundling it keeps the packaged app free of a runtime module resolution step.
        external: ['electron'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ['electron'],
        // A sandboxed preload cannot be an ES module, and with `type: module` a `.js` file
        // is ambiguous. `.cjs` says what it is; `src/main/index.ts` points at the same name.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()],
  },
});

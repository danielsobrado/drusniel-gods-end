import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
  },
  build: {
    // Keep generated JS separate from public/Assets on case-insensitive filesystems.
    assetsDir: 'app-assets',
    target: 'es2022',
  },
});

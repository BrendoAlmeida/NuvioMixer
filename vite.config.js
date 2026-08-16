import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The player is intentionally lazy-loaded only by the synchronizer modal.
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:7337',
      '/manifest.json': 'http://localhost:7337',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './ui/test-setup.js',
    include: ['ui/**/*.test.{js,jsx}'],
  },
});

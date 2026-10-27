import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const backend = process.env.BACKEND ?? 'localhost:8080';

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/ui': { target: `ws://${backend}`, ws: true },
      '/api': { target: `http://${backend}` },
    },
  },
});

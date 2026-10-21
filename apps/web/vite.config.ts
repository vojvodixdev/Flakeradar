import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs separately; in production the server
    // serves the built dashboard from the same origin.
    proxy: { '/api': 'http://localhost:3000' },
  },
});

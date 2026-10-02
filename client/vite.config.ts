/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run build:pages` builds with --mode pages: assets are served from /outboxrelay/ on
// GitHub Pages and the client uses the in-browser demo instead of the Express API.
export default defineConfig(({ mode }) => {
  const isPagesBuild = mode === 'pages';
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    base: isPagesBuild ? '/outboxrelay/' : '/',
    define: {
      'import.meta.env.VITE_DEMO_MODE': JSON.stringify(isPagesBuild ? 'true' : 'false'),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          // Override with VITE_API_TARGET (env var or client/.env.local) for a non-default server port.
          target: env.VITE_API_TARGET || 'http://localhost:4003',
          changeOrigin: true,
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});

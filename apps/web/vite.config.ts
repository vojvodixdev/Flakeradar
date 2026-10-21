import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The demo build must also work when index.html is opened straight from
 * disk (file://), where browsers refuse module scripts and CORS requests.
 * So it is bundled as one classic script, loaded with `defer`.
 */
function classicScripts(): Plugin {
  return {
    name: 'flakeradar-classic-scripts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html
          .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>')
          .replace(/ crossorigin(?=[ >])/g, ''),
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    plugins: [react(), ...(demo ? [classicScripts()] : [])],
    // Relative URLs so the demo works from any sub-folder of a website.
    base: demo ? './' : '/',
    define: { 'import.meta.env.VITE_DEMO': JSON.stringify(demo ? '1' : '') },
    build: demo
      ? {
          outDir: 'dist-demo',
          emptyOutDir: true,
          modulePreload: false,
          rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
        }
      : undefined,
    server: {
      port: 5173,
      // In development the API runs separately; in production the server
      // serves the built dashboard from the same origin.
      proxy: { '/api': 'http://localhost:3000' },
    },
  };
});

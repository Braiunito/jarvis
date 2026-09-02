import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * En desarrollo el front habla con el gateway, igual que en producción: un solo origen, con la
 * cookie de sesión haciendo el trabajo. Apuntar directamente al core aquí escondería justo los
 * fallos de proxy que luego aparecen desplegados.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: process.env['JARVIS_GATEWAY_URL'] ?? 'http://127.0.0.1:8080', changeOrigin: false },
      '/events': { target: process.env['JARVIS_GATEWAY_URL'] ?? 'http://127.0.0.1:8080', changeOrigin: false },
      '/auth': { target: process.env['JARVIS_GATEWAY_URL'] ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

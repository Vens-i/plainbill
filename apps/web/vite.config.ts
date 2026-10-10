import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const envDir = '../..';

export default defineConfig(({ mode }) => {
  // The repo-root .env holds both API and VITE_* values; only VITE_* reach the browser.
  const env = loadEnv(mode, envDir, '');
  const apiPort = env.API_PORT || '3001';
  return {
    plugins: [react()],
    envDir,
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      },
    },
    preview: { port: 4173 },
  };
});

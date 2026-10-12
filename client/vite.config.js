import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;
const publicaSourceMap = Boolean(sentryAuthToken && sentryOrg && sentryProject);

export default defineConfig({
  plugins: [
    react(),
    publicaSourceMap
      ? sentryVitePlugin({
          org: sentryOrg,
          project: sentryProject,
          authToken: sentryAuthToken,
          telemetry: false,
          sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
        })
      : null,
  ].filter(Boolean),
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: publicaSourceMap ? 'hidden' : false,
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 1421,
    strictPort: true,
    proxy: { '/v1/looklook/quotes': 'http://127.0.0.1:8000' },
  },
});

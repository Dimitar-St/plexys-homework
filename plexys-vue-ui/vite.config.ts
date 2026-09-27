import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [vue(), ...(process.env.LOCAL_NODE_SERVER === 'true' ? [] : [cloudflare()])],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(['/auth', '/app', '/api'].map(path => [path, {
      target: 'http://127.0.0.1:3001',
      // Preserve the browser Origin header for the proxy's CSRF check.
      changeOrigin: false,
    }])),
  },
})
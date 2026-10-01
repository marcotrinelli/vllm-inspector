import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // relative, so the build can be served from any path
  base: './',
  plugins: [react()],
  server: { port: 5273 },
  preview: { port: 5273 },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

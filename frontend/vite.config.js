import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` / `npm run preview` bind 0.0.0.0 so the app can be opened from a
// phone on the same network, a hosted preview, or a tunnel. Vite 6 answers 403
// "Blocked request" for any Host header that is not localhost unless the host is
// listed, which breaks exactly those URLs, so all hosts are allowed by default.
// Narrow it with VITE_ALLOWED_HOSTS (comma-separated, e.g.
// VITE_ALLOWED_HOSTS=.example.com,192.168.1.20:5173) on a shared network.
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, allowedHosts: allowedHosts.length ? allowedHosts : true },
  preview: { port: 4173, allowedHosts: allowedHosts.length ? allowedHosts : true },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3457",
      "/ws/terminal": {
        target: "ws://localhost:3457",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});

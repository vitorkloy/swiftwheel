import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./", // Importante para Electron
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
  build: {
    target: "es2022",
    // Smaller initial parse + cache-friendly chunks in production (slightly snappier cold start).
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        capture: resolve(root, "capture.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/framer-motion/")) {
            return "motion";
          }
        },
      },
    },
  },
});

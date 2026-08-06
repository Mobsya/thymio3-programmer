import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

const useHttps = process.env.HTTPS === "1" || process.env.HTTPS === "true";

export default defineConfig({
  base: "./",
  plugins: useHttps
    ? [
        basicSsl({
          name: "thymio3-web-programmer",
          domains: ["localhost", "127.0.0.1"],
        }),
      ]
    : [],
  server: {
    host: true, // bind 0.0.0.0 — reachable from VMs / other hosts
    // Separate ports so HTTP and HTTPS can coexist without collisions
    port: useHttps ? 5174 : 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: useHttps ? 4174 : 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});

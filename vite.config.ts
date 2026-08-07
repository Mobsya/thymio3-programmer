import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

const useHttps = process.env.HTTPS === "1" || process.env.HTTPS === "true";

function git(command: string, fallback: string): string {
  try {
    return execSync(command, { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const appCommit = git("git rev-parse --short HEAD", "unknown");
const appCommitDate = git("git log -1 --format=%cs", "unknown");

export default defineConfig({
  base: "./",
  define: {
    __APP_COMMIT__: JSON.stringify(appCommit),
    __APP_COMMIT_DATE__: JSON.stringify(appCommitDate),
  },
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

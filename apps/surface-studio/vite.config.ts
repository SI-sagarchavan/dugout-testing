import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { surfaceStudioApi } from "./server/plugin-api";

export default defineConfig(({ mode }) => {
  /**
   * `FANOS_*` from `apps/surface-studio/.env` into `process.env`, before the plugin reads its
   * config. Vite only exposes `.env` to client code, and the plugin is server-side — so without
   * this a local `FANOS_API_URL` was silently ignored and Studio fell back to :4000, where on a
   * machine running another service it reports "control plane reachable" for the wrong API.
   * A variable already set in the shell wins.
   */
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "FANOS_"))) {
    process.env[key] ??= value;
  }

  return {
    plugins: [react(), surfaceStudioApi()],
    // :3001 behind the Next.js site on :3000, which forwards `/v1/*` (the Figma plugin's API, whose
    // manifest allows only :3000) and the board here. HMR connects straight to :3001.
    server: {
      port: 3001,
      strictPort: true,
      hmr: { clientPort: 3001 },
    },
    preview: {
      port: 3001,
      strictPort: true,
    },
  };
});

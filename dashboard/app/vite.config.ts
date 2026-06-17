import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/v2/",
  build: {
    outDir: "dist/v2",
    emptyOutDir: true,
  },
});

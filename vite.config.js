import { defineConfig } from "vite";

// Static build for GitHub Pages (served from /<repo>/ subpath). base "./" keeps
// all bundled asset URLs relative; runtime model fetches use relative paths too,
// so the same build works in dev and under the Pages subpath. Output → docs/ so
// Pages can serve from main branch /docs.
export default defineConfig({
  base: "./",
  build: { outDir: "docs", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});

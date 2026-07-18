import { defineConfig } from "vite";

// Static build for GitHub Pages (served from /<repo>/ subpath). base "./" keeps
// all bundled asset URLs relative; runtime model fetches use relative paths too,
// so the same build works in dev and under the Pages subpath. Output → docs/ so
// Pages can serve from main branch /docs.
import { resolve } from "path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "docs", emptyOutDir: true, chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {                              // proving ground + road editor + character
        main: resolve(__dirname, "index.html"),
        roads: resolve(__dirname, "roads.html"),
        character: resolve(__dirname, "character.html"),
      },
    },
  },
});

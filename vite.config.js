import { defineConfig } from "vite";

// Static build for GitHub Pages (served from /<repo>/ subpath). base "./" keeps
// all bundled asset URLs relative; runtime model fetches use relative paths too,
// so the same build works in dev and under the Pages subpath. Output → docs/ so
// Pages can serve from main branch /docs.
import { resolve } from "path";

export default defineConfig({
  base: "./",
  // visible build stamp — Erik tested a stale cached index.html for a while
  // without knowing; the HUD shows this so "which build am I on" is one glance
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(5, 16).replace("T", " ")) },
  build: {
    outDir: "docs", emptyOutDir: true, chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {                              // proving ground + road editor + character
        main: resolve(__dirname, "index.html"),
        roads: resolve(__dirname, "roads.html"),
        character: resolve(__dirname, "character.html"),
        proving: resolve(__dirname, "proving.html"),   // vehicle-physics sandbox
        bike: resolve(__dirname, "bike.html"),         // motorcycle sandbox
        tank: resolve(__dirname, "tank.html"),         // tracked-vehicle sandbox
        ragdoll: resolve(__dirname, "ragdoll.html"),   // active-ragdoll proving ground
        chareditor: resolve(__dirname, "character-editor.html"), // character + ragdoll editor
        map: resolve(__dirname, "map.html"),           // large-world streaming proving ground
        flora: resolve(__dirname, "flora.html"),       // procedural flora proving ground
      },
    },
  },
});

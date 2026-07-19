#!/usr/bin/env node
// PlayForge .unitypackage importer — extract usable assets WITHOUT Unity (General).
// A .unitypackage is a gzipped TAR: one folder per asset GUID containing
//   pathname   (the asset's project path, e.g. "Assets/Models/Gun.fbx")
//   asset      (the raw file bytes)
// We stream the tar, keep FBX/PNG/JPG/TGA/WAV/OGG/MP3, and write them under the
// out dir mirroring their Assets/ paths. Zero deps — minimal tar reader inline.
//
//   node tools/unitypack.mjs "Asset Drop/SomePack.unitypackage" [outDir]
//
// Default outDir: Asset Drop/unpacked/<packname>/

import fs from "fs";
import path from "path";
import zlib from "zlib";

const KEEP = /\.(fbx|png|jpg|jpeg|tga|wav|ogg|mp3|obj|gltf|glb)$/i;

function* tarEntries(buf) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;                                       // end blocks
    const size = parseInt(header.subarray(124, 136).toString("utf8").trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    yield { name, size, type, data };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

export function extract(pkgPath, outDir) {
  const raw = zlib.gunzipSync(fs.readFileSync(pkgPath));
  const byGuid = {};                                        // guid → { pathname, asset }
  for (const e of tarEntries(raw)) {
    const m = e.name.match(/^\.?\/?([0-9a-f]{32})\/(pathname|asset)$/i);
    if (!m) continue;
    (byGuid[m[1]] ??= {})[m[2].toLowerCase()] = e.data;
  }
  const written = [], skipped = [];
  for (const guid in byGuid) {
    const { pathname, asset } = byGuid[guid];
    if (!pathname || !asset) continue;
    const rel = pathname.toString("utf8").split("\n")[0].trim();   // line 2 can hold meta
    if (!KEEP.test(rel)) { skipped.push(rel); continue; }
    const dest = path.join(outDir, rel.replace(/^Assets[\/]/i, ""));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, asset);
    written.push({ rel, bytes: asset.length });
  }
  return { written, skippedCount: skipped.length };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("unitypack.mjs")) {
  const pkg = process.argv[2];
  if (!pkg) { console.log('usage: node tools/unitypack.mjs "<pack.unitypackage>" [outDir]'); process.exit(1); }
  const out = process.argv[3] || path.join(path.dirname(pkg), "unpacked", path.basename(pkg, ".unitypackage"));
  const t0 = Date.now();
  const { written, skippedCount } = extract(pkg, out);
  console.log(`✅ ${written.length} assets → ${out}  (${skippedCount} non-asset files skipped, ${Date.now() - t0}ms)`);
  for (const w of written.slice(0, 30)) console.log(`   ${w.rel}  ${(w.bytes / 1024).toFixed(1)}kB`);
  if (written.length > 30) console.log(`   … +${written.length - 30} more`);
}

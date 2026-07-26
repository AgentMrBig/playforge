import * as THREE from "three";
import { fbm, ridged } from "./noise.js";

/**
 * makeIslandTerrain — a realistic procedural island as a pure height function.
 *
 * Returns { heightAt, colorAt, waterMesh } ready to hand to StreamedTerrain.
 * Everything is deterministic from `seed` and evaluable anywhere (infinite /
 * streamable). Realism comes from layering, not from a single fbm:
 *
 *   • DOMAIN WARP — sample coords are pushed around by a low-freq noise field, so
 *     coastlines and ridgelines wind naturally instead of looking like filtered
 *     static (the #1 "procedural tell" fix).
 *   • WANDERING COAST — the island's radial falloff radius is itself noise, so the
 *     shoreline has bays and headlands, not a circle.
 *   • RIDGED MOUNTAIN RANGES — ridged multifractal (sharp peaks + V-valleys),
 *     clustered by a low-freq "range" mask so mountains form belts, not confetti.
 *   • CARVED VALLEYS — a valley field subtracts from the interior for drainage-
 *     like lowlands between ranges.
 *   • BIOMES — height + slope + a separate moisture field pick sand/grass/forest/
 *     rock/snow, so colour reads as terrain, not a height ramp.
 *
 * Tuned to keep heightAt cheap (~a handful of fbm calls) since the streamer
 * samples it thousands of times per tile.
 */
export function makeIslandTerrain({ seed = 1337, islandR = 1500, sea = 0 } = {}) {
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

  // peak scale used by both height and biome thresholds
  const PEAK = 230;

  function heightAt(x, z) {
    // ── domain warp: low-freq, so features wind but cost stays low ──
    const wf = 0.7 / islandR;
    const wax = x + fbm(x * wf + 11, z * wf + 11, { octaves: 2, seed: seed + 3 }) * islandR * 0.11;
    const waz = z + fbm(x * wf + 31, z * wf + 31, { octaves: 2, seed: seed + 4 }) * islandR * 0.11;
    const nx = wax / islandR, nz = waz / islandR;
    const d = Math.hypot(nx, nz);

    // ── island mask with a wandering coastline ──
    const coastN = fbm(nx * 2.4 + 7, nz * 2.4 + 7, { octaves: 3, seed: seed + 9 });
    const shore = 0.82 + coastN * 0.22;                 // shoreline radius varies with noise
    const land = smooth((shore - d) / 0.30);            // 1 well inland → 0 out at sea
    if (land <= 0) {
      // sea floor: deepen offshore so water has real depth (boats/depth shading)
      return sea - 3 - smooth((d - shore) / 0.6) * 45;
    }

    // ── interior relief. Everything scales by `land` (0 at the coast → smooth
    // waterline) and the rolling term is 0..1 (not ±), so the interior never dips
    // back under the sea the way a signed fbm did. ──
    const relief = fbm(nx * 5 + 20, nz * 5 + 20, { octaves: 4, seed }) * 0.5 + 0.5;   // 0..1 rolling hills
    const range = clamp01(fbm(nx * 1.4 + 50, nz * 1.4 + 50, { octaves: 2, seed: seed + 21 }) * 2.1 + 0.28); // where ranges cluster
    const rg = ridged(nx * 5.5 + 3, nz * 5.5 + 3, { octaves: 5, seed: seed + 7 });    // 0..1 ridgelines
    const peak = Math.pow(rg, 1.2) * range;                                           // 0..1 mountain height
    const val = fbm(nx * 7 + 70, nz * 7 + 70, { octaves: 2, seed: seed + 33 });
    const carve = Math.max(0, 0.5 - val) * 22 * peak;                                 // V-valleys carved into the ranges

    let h = land * (4 + relief * 18 + peak * peak * PEAK - carve);
    // gentle beach shelf near the waterline so shores aren't knife-edged
    if (h > sea && h < sea + 3) h = sea + (h - sea) * 0.65 + 0.35;
    return h;
  }

  // ── biome colouring: height + slope + moisture ──
  const C = {
    seabed: new THREE.Color(0x274b60), sand: new THREE.Color(0xdac48a),
    grass: new THREE.Color(0x4f8f47), lush: new THREE.Color(0x2f6b39),
    dry: new THREE.Color(0x8a9a52), rock: new THREE.Color(0x7c766e),
    scree: new THREE.Color(0x8f8880), snow: new THREE.Color(0xf3f5f8),
  };
  const _c = new THREE.Color();
  function colorAt(x, z, h, slope, out) {
    if (h < sea - 0.2) { out.copy(C.seabed); return; }
    if (h < sea + 1.8) { out.copy(C.sand); return; }                    // beach
    if (slope > 1.15 || h > PEAK * 0.5) {                               // cliffs + high ground
      out.copy((h > PEAK * 0.6 && slope < 1.1) ? C.snow : slope > 1.4 ? C.rock : C.scree);
      return;
    }
    const moist = fbm(x * 0.0035 + 90, z * 0.0035 + 90, { octaves: 2, seed: seed + 55 }) * 0.5 + 0.5;
    out.copy(C.grass).lerp(C.lush, clamp01(moist * 1.3 - 0.15)).lerp(C.dry, clamp01(0.35 - moist) * 1.6);
    if (h > PEAK * 0.45) out.lerp(C.scree, smooth((h - PEAK * 0.45) / (PEAK * 0.2)) * 0.6);  // treeline fade
    return _c;
  }

  /** a translucent water plane at sea level (add to the scene) */
  function waterMesh(size = islandR * 4) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x2b6d90, transparent: true, opacity: 0.82, roughness: 0.25, metalness: 0.1 }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = sea;
    return m;
  }

  return { heightAt, colorAt, waterMesh, islandR, sea, PEAK };
}

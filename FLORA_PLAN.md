# PROCEDURAL FLORA — Plan

Grass, flowers, bushes, and trees (pines, oaks, +more) — stylized/low-poly (Synty-
ish), not photoreal, but lush, varied, and **robust at streaming scale**. Designed
from day one so every plant's motion is **driven by data** — an object hitting it,
and (eventually) wind — not baked, not per-plant CPU physics.

Built lab-first (like the car Garage / Ragdoll / Map labs): prove it in a **Flora
Lab**, then merge into the streamed map.

---

## 0. Goals & non-goals
- **Types:** grass sprigs, flowers, bushes, trees — several tree species (tall
  narrow **pine**, broad **oak**), extensible via a `treeSpec`.
- **Stylized**, not photoreal. Reads well up close AND from a plane.
- **Scales:** ~millions of grass blades near the camera, thousands of trees over a
  large streamed world, at 60fps.
- **Data-driven animation is a first-class requirement**, not a bolt-on:
  hit-reactions now, wind later, both through the same seam.
- **Deterministic placement** (seeded) so streaming tiles in/out never pops or
  reshuffles what's already on screen.
- **Non-goals (for v1):** photoreal shading, GPU compute simulation, per-blade
  rigid-body physics, wind at launch (designed-in, implemented after hits).

---

## 1. The one big idea — bend = f(data), on the GPU
Every flora mesh carries a vertex attribute **`aBendWeight` ∈ [0,1]** (0 at the
anchored root, 1 at the free tip). A shared vertex shader bends each vertex by:

```
bend = WIND(worldPos, time) + DISTURB(worldPos)      // a horizontal offset vector
vertex.xz += bend * aBendWeight                        // roots stay put, tips move most
```

That single primitive is why the whole system stays cheap and uniform: grass,
flowers, bushes and tree crowns all animate the same way, entirely in the vertex
shader, so animating a million blades costs ~nothing on the CPU. Wind and hits are
just two terms added into `bend`.

Implementation: a custom `ShaderMaterial` (or `MeshStandardMaterial` +
`onBeforeCompile` so we keep lighting/shadows), shared by all instanced flora.

---

## 2. Animation / interaction system (the important part)

### 2a. Dynamic disturbers — hits (the day-one feature)
The game feeds a small array of **disturbers** every frame — anything that should
push flora aside: the car(s), the player, projectiles, ragdolls, the wrecking ball.

```
floraField.setDisturbers([
  { x, y, z, radius, strength, vx, vz },   // world pos, reach, push, travel dir
  ...
])   // cap ~24 packed into uniforms, or a small DataTexture for more
```

Vertex shader, per plant instance:
- For each disturber within `radius`, compute a push:
  - direction = blend of **away-from-disturber** (radial) and **the disturber's
    travel direction** (so grass lays DOWN along the car's path, not just outward),
  - magnitude ∝ `(1 − dist/radius) · strength`, softened near the edge.
- Sum the pushes → `DISTURB`. Clamp so a plant can't invert.

Result: drive/run through grass and it bends away + flattens along your path, then
springs back as you leave — pure GPU, no per-blade state, scales to any count.

### 2b. Wind (designed-in now, implemented after hits)
Global uniforms `uWindDir`, `uWindStrength`, `uTime`; per-instance phase hashed
from instance position so nothing sways in lockstep. Two bands: a slow directional
sway + a fast flutter, with **gusts** from a slow noise on strength. Trees use the
same term but stiffer, and `aBendWeight` up the trunk means the trunk barely moves
while the crown sways.

```
floraField.setWind({ dir:[x,z], strength, gust })
```

### 2c. Persistent trample trail (eventual)
For grass that *stays* flattened after you pass (a visible path/tire tracks): a
world-space **trample render-target** centered on the action — disturbers stamp a
decaying value into it, grass samples it to stay pressed down and recovers over a
few seconds. Optional; 2a already covers instantaneous reactions.

### 2d. Trees & bushes — heavier hit response
Trees are few, so they can afford a little CPU: each carries a **bend accumulator**
(a damped spring: a hit adds an impulse, it whips and recovers), fed to the shader
as per-instance data. Stiffness scales with trunk size (a sapling whips, a big pine
barely nods). Later: big trees become breakable/fell-able (swap the static collider
for a dynamic body that topples).

### 2e. The clean seam
The only public animation API is `setWind(...)` and `setDisturbers(...)`. The game
(car system, player, combat) fills disturbers each frame from things it already
tracks. That's the "drive animations via data" contract — everything else is
internal to the flora shader/field.

---

## 3. Flora types & construction
All meshes are **procedurally generated** low-poly (not imported FBX) so we control
the vertex layout — specifically `aBendWeight` and the anchor — which is what makes
the uniform bend system possible. Per-instance scale/rotation/tint jitter keeps a
field from looking cloned.

- **Grass sprig** — a small fan of 3–5 blades (a couple tris each), crossed for
  volume. `aBendWeight` = height along the blade. Per-instance tint from biome +
  noise. Enormous counts, nearest ring only, no collider.
- **Flower** — grass stem + a few petal quads; per-species color palette; meadow
  biomes. Same shader.
- **Bush** — a low rounded cluster of leaf-cards / a low-poly blob; medium range;
  optional soft trigger collider (rustle/slow).
- **Trees** via a `treeSpec { trunkProfile, crownType, heightRange, colors, biome }`:
  - **Pine** — tapered trunk + stacked low-poly cone crown, dark green, tall/narrow;
    higher/cooler biomes.
  - **Oak** — shorter thick trunk + a few branch forks + a rounded canopy (low-poly
    or leaf-card clusters); lush mid-elevation biomes.
  - Extensible: add species by adding a `treeSpec`. Trunk + crown share two
    instanced materials so a whole forest is a couple of draw calls.

*(Alternative considered: the Synty tree/rock models already in the pack. Rejected
for hero flora because opaque FBX meshes have no `aBendWeight`/anchor control, which
the animation system needs. Synty models can still be dropped in as static props
where animation isn't required.)*

---

## 4. Placement — biome-driven & deterministic
A `floraAt(x, z)` sampler (built from the same worldgen inputs as terrain color:
height, slope, moisture, biome) returns density + type weights:
- grass on gentle grass/meadow; flowers in wetter meadows; bushes scattered;
- pines high & cool, oaks lush mid-elevation; **nothing** on rock/steep/beach/
  underwater/roads/settlements.

Scatter is **hash-seeded per terrain tile** (by tile coord + index) so a tile
always produces the exact same plants → streaming it out and back in never pops or
reshuffles. Jitter (pos/scale/rot/tint) all derives from the same seeded hash.

---

## 5. Streaming, LOD & performance
Flora rides on the existing **StreamedTerrain**:
- Scatter a tile's flora when the tile builds (a `decorate`/`onTile` hook), dispose
  on unload, and **budget per frame** (like tile builds) so a tile's scatter never
  spikes a frame.
- LOD rings mirror terrain rings: **grass** on the nearest ring(s) only; **flowers/
  bushes** a bit further; **trees** on more rings (they read from far). Fade
  instances in/out by distance (shader alpha/scale) so nothing pops.
- Rendering is GPU-instanced (`InstancedMesh` / `InstancedBufferGeometry`): one
  draw call per flora type per tile (or per ring). Animation is vertex work → ~free
  per plant; the real budgets are **draw calls** (instancing) and **vertex count**
  (LOD + distance fade + per-tile caps).
- Trees far away → 2-tri **billboard impostor** baked from the mesh; near → full
  mesh. **Colliders only within ~1 tile of the player/car** so vehicles can smash
  them while distant trees stay visual-only.
- Zero per-frame allocation: pooled instance buffers per tile.

---

## 6. Physics / collision
- Grass, flowers: none (visual + shader-reactive only).
- Bushes: optional cheap trigger.
- Trees: static trunk collider (cuboid/cylinder) within the near collider ring;
  the disturber/bend system does the visual reaction. Eventual: fell big trees
  (swap to a dynamic body + topple + become an obstacle).

---

## 7. Lab-first methodology
**Phase 1 — Flora Lab** (`flora.html` → `demo/floralab.js`): isolated scene,
rolling ground, a car + the free-fly cam, sliders (density, wind, species mix), and
the car wired as a live **disturber** so we can watch grass bend as it drives
through. Live instance counts + frametime graph. Iterate the look and the
animation here, then merge into the map — same path the car, ragdoll, and terrain
took.

---

## 8. Phased roadmap
1. **Flora Lab** scaffold + instanced **grass sprigs** (static) + rough biome density.
2. **Disturber system** — car drives through grass → bends away + lays along its
   path + springs back. *(The headline data-driven feature, first.)*
3. **Wind** shader (sway + flutter + gusts, per-instance phase).
4. **Flowers + bushes** (instanced, tinted, same shader).
5. **Trees** — pine + oak procedural generators, instancing, near colliders,
   per-tree hit-bend spring.
6. **Placement + StreamedTerrain integration** + LOD/fade + per-frame budget.
7. **Merge into the map / Big Island**; wire the game to feed disturbers (cars,
   player, ragdolls) + wind.
8. **Eventual:** persistent trample trails (trample RT), tree felling, seasonal /
   biome color palettes.

---

## 9. Planned files
- `src/flora.js` — `FloraField` (instancing, scatter, LOD, `setWind`/
  `setDisturbers`), the procedural mesh generators (grass/flower/bush/tree), and the
  shared bend shader.
- `floraAt(x,z)` biome→flora sampler (in `worldgen.js` or a `floradef.js`).
- `demo/floralab.js` + `flora.html` — the lab (add to `vite.config.js`).
- Hooks in `streamworld.js` (decorate) + `maplab.js` / `bigisland.js` (feed
  disturbers + wind).

---

## 10. Decisions to confirm with Erik
1. **Procedural trees vs Synty models?** Recommend procedural (needed for the bend
   animation); Synty stays available for static props.
2. **Grass draw distance / density target** — lush vs framerate. Start conservative,
   dial up in the lab.
3. **Order** — plan does **hits before wind** per your priority; confirm.
4. **Persistent flattened trails** (a path stays matted after you drive through) —
   want that, or is spring-back enough for now?
5. **Tree felling** (smash big trees down) — in scope soon, or later?

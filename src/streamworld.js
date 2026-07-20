import * as THREE from "three";

/**
 * StreamedTerrain — infinite/massive worlds from a pure height function.
 *
 * The world is math: heightAt(x, z) can be evaluated anywhere, so physics
 * needs no mesh and tiles of geometry stream in around an anchor (the
 * player/camera) in LOD rings. One tile builds per frame — no hitches.
 *
 *   world.spawn("terrain").add(new StreamedTerrain({
 *     heightAt: (x, z) => ...,
 *     colorAt: (x, z, h, slope, outColor) => ...,
 *     decorate: (tile, addCollider) => ...,   // trees/buildings per tile
 *   }));
 *
 * - rings: [[ringRadius, resolution], ...] — nearest ring wins. A tile's
 *   mesh is rebuilt when its LOD changes (old stays until the new is ready).
 * - skirts: each tile's edge drops a curtain so LOD seams never show holes.
 * - Bodies/vehicles automatically stand on it (heightAt/slopeAt interface).
 */
export class StreamedTerrain {
  constructor({
    heightAt,
    colorAt = (x, z, h, s, out) => out.setHSL(0.3, 0.4, 0.35),
    decorate = null,
    tileSize = 128,
    rings = [[1, 48], [2, 24], [4, 12]],
    skirt = 12,
    anchor = null,                 // fn() → THREE.Vector3; defaults to camera
  }) {
    this._fn = heightAt;
    this._colorAt = colorAt;
    this._decorate = decorate;
    this.tileSize = tileSize;
    this.rings = rings;
    this.skirt = skirt;
    this.anchorFn = anchor;
    this.maxRing = rings[rings.length - 1][0];
    this._tiles = new Map();       // "ix,iz" → { res, group, building }
    this._queue = [];
    this.tileCount = 0;
  }

  heightAt(x, z) { return this._fn(x, z); }
  slopeAt(x, z, e = 1.5) {
    const h = this._fn(x, z);
    return Math.max(Math.abs(this._fn(x + e, z) - h), Math.abs(this._fn(x, z + e) - h)) / e;
  }

  update(dt, { world, engine, entity }) {
    this._entity = entity;
    const a = this.anchorFn ? this.anchorFn() : world.camera.position;
    const cx = Math.floor(a.x / this.tileSize), cz = Math.floor(a.z / this.tileSize);

    // wanted tiles + their LOD
    const wanted = new Map();
    for (let dz = -this.maxRing; dz <= this.maxRing; dz++)
      for (let dx = -this.maxRing; dx <= this.maxRing; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const res = this.rings.find(([r]) => ring <= r)?.[1];
        if (res === undefined) continue;
        wanted.set((cx + dx) + "," + (cz + dz), res);
      }

    // drop tiles far outside, queue missing/wrong-LOD ones
    for (const [key, t] of this._tiles) {
      if (!wanted.has(key) && !t.building) this._dispose(world, key);
    }
    this._queue.length = 0;
    for (const [key, res] of wanted) {
      const t = this._tiles.get(key);
      if (!t || (t.res !== res && !t.building)) {
        const [ix, iz] = key.split(",").map(Number);
        const d = Math.max(Math.abs(ix - cx), Math.abs(iz - cz));
        this._queue.push({ key, ix, iz, res, d });
      }
    }
    this._queue.sort((p, q) => p.d - q.d);

    // build ONE tile per frame — the no-hitch rule
    if (this._queue.length) {
      const job = this._queue.shift();
      this._build(world, entity, job);
    }
    this.tileCount = this._tiles.size;
  }

  _build(world, parentEntity, { key, ix, iz, res }) {
    const old = this._tiles.get(key);
    const size = this.tileSize;
    const x0 = ix * size, z0 = iz * size;
    const group = new THREE.Group();

    // ---- terrain grid with a skirt ring -------------------------------------
    const N = res + 1;                   // interior verts per side
    const W = N + 2;                     // + skirt verts each side
    const pos = new Float32Array(W * W * 3);
    const col = new Float32Array(W * W * 3);
    const c = new THREE.Color();
    const step = size / res;
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const ci = Math.min(Math.max(i - 1, 0), N - 1);
        const cj = Math.min(Math.max(j - 1, 0), N - 1);
        const wx = x0 + ci * step, wz = z0 + cj * step;
        const inSkirt = i === 0 || j === 0 || i === W - 1 || j === W - 1;
        const h = this._fn(wx, wz);
        const o = (j * W + i) * 3;
        pos[o] = wx; pos[o + 1] = inSkirt ? h - this.skirt : h; pos[o + 2] = wz;
        const slope = this.slopeAt(wx, wz);
        this._colorAt(wx, wz, h, slope, c);
        if (inSkirt) c.multiplyScalar(0.55);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    const idx = [];
    for (let j = 0; j < W - 1; j++)
      for (let i = 0; i < W - 1; i++) {
        const a = j * W + i, b = a + 1, d = a + W, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    // analytic normals from the height function — seamless across tiles
    // (computeVertexNormals would shade each tile island-alone → visible seams)
    const nrm = new Float32Array(W * W * 3);
    const eps = step;
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const o = (j * W + i) * 3;
        const wx = pos[o], wz = pos[o + 2];
        const dhdx = (this._fn(wx + eps, wz) - this._fn(wx - eps, wz)) / (2 * eps);
        const dhdz = (this._fn(wx, wz + eps) - this._fn(wx, wz - eps)) / (2 * eps);
        const inv = 1 / Math.hypot(dhdx, 1, dhdz);
        nrm[o] = -dhdx * inv; nrm[o + 1] = inv; nrm[o + 2] = -dhdz * inv;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, TERRAIN_MAT);
    mesh.receiveShadow = true;
    group.add(mesh);

    // ---- per-tile content ---------------------------------------------------
    const tile = {
      key, ix, iz, res, group,
      x0, z0, size,
      colliders: [],
      cleanup: [],                 // fns run when the tile is disposed
      building: false,
      addCollider: null,
    };
    if (this._decorate) {
      tile.addCollider = (collider) => {
        collider.entity = parentEntity;
        collider._tileKey = key;
        tile.colliders.push(collider);
      };
      this._decorate(tile, group);
    }
    // physics/streaming hook: onTile(tile, mesh) — push undo fns to
    // tile.cleanup (e.g. remove the tile's Rapier collider when it unloads)
    if (this.onTile) this.onTile(tile, mesh);

    // replace-on-ready: retire the old LOD only after the new tile is built
    if (old) this._dispose(world, key, old);
    parentEntity.object3d.add(group);
    for (const cdr of tile.colliders) parentEntity.components.push(cdr);
    this._tiles.set(key, tile);
  }

  _dispose(world, key, tileOverride = null) {
    const t = tileOverride ?? this._tiles.get(key);
    if (!t) return;
    t.dead = true;
    for (const f of t.cleanup ?? []) f();
    t.group.parent?.remove(t.group);
    t.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !o.material._shared) o.material.dispose?.();
    });
    if (t.colliders.length && this._entity) {
      const dead = new Set(t.colliders);
      this._entity.components = this._entity.components.filter((c) => !dead.has(c));
    }
    if (!tileOverride) this._tiles.delete(key);
  }

  /** dispose all current tiles so update() re-decorates them — used when async content
   * (e.g. Synty buildings) finishes loading after the spawn tiles already decorated. */
  rebuild(world) {
    for (const key of [...this._tiles.keys()]) this._dispose(world, key);
  }
}

const TERRAIN_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
TERRAIN_MAT._shared = true;

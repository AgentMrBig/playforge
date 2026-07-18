import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

/**
 * Asset loading with sane normalization (the pipeline CabForge proved):
 * whatever the DCC tool exported — Z-up, off-center, kilometer-scale —
 * comes out Y-up, centered on X/Z, seated on the floor, scaled to size.
 *
 *   const { group, size } = await loadModel("/models/mycar.glb", { targetLength: 4.4 });
 *
 * Formats: .glb / .gltf (preferred — one file, materials included, animations
 * survive) and .obj (tries a sibling .mtl automatically). Results are cached
 * by URL; call again and you get a cheap clone.
 *
 * For drivable cars there's a best-effort adapter:
 *
 *   const car = await loadCarModel("/models/mycar.glb", { targetLength: 4.6 });
 *   world.spawn("car").mesh(car.visual)
 *     .add(new VehicleBody({ chassis: car.chassis, wheels: car.wheels }));
 *
 * Wheel detection is by node name: fl/front_left/wheelFL etc. If the model
 * has no named wheels, you still get a working car — the wheels just don't
 * visibly spin/steer.
 */
const CACHE = new Map();

export async function loadModel(url, {
  zUp = "auto",            // true | false | "auto" (guess: taller than long+wide = probably Z-up export)
  center = true,
  seatOnGround = true,
  targetLength = 0,        // scale so max(x,z) extent equals this (0 = keep)
  rotateY = 0,             // extra yaw if the model faces the wrong way
  alignLengthToZ: opts_alignZ = false, // vehicles: ensure long axis is Z
  shadows = true,
} = {}) {
  const key = url + "|" + targetLength + "|" + zUp + "|" + rotateY + "|" + opts_alignZ;
  if (CACHE.has(key)) {
    const c = CACHE.get(key);
    return { group: c.group.clone(true), size: c.size.clone() };
  }

  let root;
  if (/\.(glb|gltf)$/i.test(url)) {
    const gltf = await new GLTFLoader().loadAsync(url);
    root = gltf.scene;
    root.animations = gltf.animations ?? [];
  } else if (/\.obj$/i.test(url)) {
    const mtlUrl = url.replace(/\.obj$/i, ".mtl");
    let materials = null;
    try { materials = await new MTLLoader().loadAsync(mtlUrl); materials.preload(); } catch {}
    const loader = new OBJLoader();
    if (materials) loader.setMaterials(materials);
    root = await loader.loadAsync(url);
  } else if (/\.fbx$/i.test(url)) {
    root = await new FBXLoader().loadAsync(url);
  } else {
    throw new Error("loadModel: unsupported format " + url);
  }

  // ---- normalize ----------------------------------------------------------
  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());
  const up = zUp === "auto" ? size.z > size.y && size.z > size.x * 0.8 : zUp;
  if (up) {
    root.traverse((o) => { if (o.isMesh) o.geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)); });
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  // vehicles must be long along Z (the engine's forward); rotate if X-long
  if (opts_alignZ && size.x > size.z) {
    root.rotation.y = Math.PI / 2;
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  if (rotateY) {
    root.rotation.y += rotateY;
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  if (targetLength > 0) {
    const s = targetLength / Math.max(size.x, size.z);
    root.scale.setScalar(s);
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  if (center || seatOnGround) {
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    root.position.x -= center ? cx : 0;
    root.position.z -= center ? cz : 0;
    root.position.y -= seatOnGround ? box.min.y : 0;
  }
  if (shadows) root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

  const group = new THREE.Group();
  group.add(root);
  CACHE.set(key, { group, size: size.clone() });
  return { group: group.clone(true), size };
}

const WHEEL_PATTERNS = {
  fl: /(wheel|tyre|tire)?[\W_]*(f(ront)?[\W_]*l(eft)?|fl)\b|l(eft)?[\W_]*f(ront)?\b/i,
  fr: /(wheel|tyre|tire)?[\W_]*(f(ront)?[\W_]*r(ight)?|fr)\b|r(ight)?[\W_]*f(ront)?\b/i,
  rl: /(wheel|tyre|tire)?[\W_]*(r(ear|ight)?[\W_]*l(eft)?|rl|bl)\b/i,
  rr: /(wheel|tyre|tire)?[\W_]*(r(ear)?[\W_]*r(ight)?|rr|br)\b/i,
};

/**
 * Geometric wheel surgery for baked single-mesh cars: find the 4 corner
 * clusters of triangles in the mesh's lower band, split them out as indexed
 * geometries SHARING the body's vertex buffers, and wrap each in a pivot at
 * its own center so it can steer and spin. Returns null if the mesh doesn't
 * look like it has 4 corner wheels.
 */
function extractWheels(mesh, { heightFrac = 0.34, axleFrac = 0.45 } = {}) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  // FBX often ships non-indexed triangle soup — synthesize an index over it
  const idx = geo.index ? geo.index.array
            : Uint32Array.from({ length: pos.count }, (_, i) => i);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const size = new THREE.Vector3(); bb.getSize(size);
  const longAxis = size.x >= size.z ? "x" : "z";   // model-space length axis
  const latAxis = longAxis === "x" ? "z" : "x";
  const yCut = bb.min.y + size.y * heightFrac;      // wheels live low
  const longCut = (longAxis === "x" ? size.x : size.z) * 0.5 * axleFrac; // near axles
  const longMid = (bb.min[longAxis] + bb.max[longAxis]) / 2;
  const latMid = (bb.min[latAxis] + bb.max[latAxis]) / 2;

  // sort triangles: 4 wheel quadrants vs body, preserving material groups
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx.length, materialIndex: 0 }];
  const clusters = { fl: [], fr: [], rl: [], rr: [] }; // [ [indices…], groups rebuilt later ]
  const cGroups = { fl: [], fr: [], rl: [], rr: [] };
  const cLong = { fl: [], fr: [], rl: [], rr: [] };    // long-axis centroid per tri
  const bodyIdx = [];
  const bodyGroups = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const g of groups) {
    const bodyStart = bodyIdx.length;
    const cStarts = {};
    for (const k of Object.keys(clusters)) cStarts[k] = clusters[k].length;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, idx[i + k]);
      const cy = (v[0].y + v[1].y + v[2].y) / 3;
      const cl = (v[0][longAxis] + v[1][longAxis] + v[2][longAxis]) / 3 - longMid;
      const ct = (v[0][latAxis] + v[1][latAxis] + v[2][latAxis]) / 3 - latMid;
      if (cy < yCut && Math.abs(cl) > longCut) {
        const key = (cl < 0 ? "f" : "r") + (ct < 0 ? "l" : "r"); // front = -long (checked visually)
        clusters[key].push(idx[i], idx[i + 1], idx[i + 2]);
        cLong[key].push(cl);                    // remember long-axis position
      } else {
        bodyIdx.push(idx[i], idx[i + 1], idx[i + 2]);
      }
    }
    if (bodyIdx.length > bodyStart)
      bodyGroups.push({ start: bodyStart, count: bodyIdx.length - bodyStart, materialIndex: g.materialIndex });
    for (const k of Object.keys(clusters))
      if (clusters[k].length > cStarts[k])
        cGroups[k].push({ start: cStarts[k], count: clusters[k].length - cStarts[k], materialIndex: g.materialIndex });
  }
  // refine: initial capture grabs bumpers/skirts too. Wheels are COMPACT
  // along the car's length — iterate: find each cluster's long-axis center,
  // return outlier triangles to the body, recompute. Two passes settle it.
  const wheelHalf = size.y * 0.45;              // wheel diameter ≈ height·0.5
  for (const key of Object.keys(clusters)) {
    for (let pass = 0; pass < 2; pass++) {
      const longs = cLong[key];
      if (!longs.length) break;
      const sorted = [...longs].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const keepIdx = [], keepLong = [], keepG = [];
      const dropped = [];
      // walk triangles with their group tags preserved
      let gi = 0;
      for (let tri = 0; tri < longs.length; tri++) {
        while (gi < cGroups[key].length - 1 && tri * 3 >= cGroups[key][gi].start + cGroups[key][gi].count) gi++;
        const mat = cGroups[key][gi]?.materialIndex ?? 0;
        const t3 = tri * 3;
        if (Math.abs(longs[tri] - median) <= wheelHalf) {
          keepIdx.push(clusters[key][t3], clusters[key][t3 + 1], clusters[key][t3 + 2]);
          keepLong.push(longs[tri]);
          keepG.push(mat);
        } else {
          dropped.push(clusters[key][t3], clusters[key][t3 + 1], clusters[key][t3 + 2]);
        }
      }
      // rebuild this cluster's index + groups (runs of equal material)
      clusters[key] = keepIdx;
      cLong[key] = keepLong;
      const grps = [];
      for (let tri = 0; tri < keepG.length; tri++) {
        const last = grps[grps.length - 1];
        if (last && last.materialIndex === keepG[tri]) last.count += 3;
        else grps.push({ start: tri * 3, count: 3, materialIndex: keepG[tri] });
      }
      cGroups[key] = grps;
      for (const d of dropped) bodyIdx.push(d);
      if (!dropped.length) break;
    }
  }
  // returned-to-body triangles need a group; tack them onto a neutral group 0
  if (bodyIdx.length > (bodyGroups.at(-1)?.start ?? 0) + (bodyGroups.at(-1)?.count ?? 0))
    bodyGroups.push({
      start: (bodyGroups.at(-1)?.start ?? 0) + (bodyGroups.at(-1)?.count ?? 0),
      count: bodyIdx.length - ((bodyGroups.at(-1)?.start ?? 0) + (bodyGroups.at(-1)?.count ?? 0)),
      materialIndex: bodyGroups[0]?.materialIndex ?? 0,
    });

  // sanity: all four clusters need real geometry
  if (Object.values(clusters).some((c) => c.length < 60)) return null;

  const mkGeo = (indices, grps) => {
    const g2 = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g2.setAttribute(name, attr);
    g2.setIndex(indices);
    for (const gr of grps) g2.addGroup(gr.start, gr.count, gr.materialIndex);
    return g2;
  };
  mesh.geometry = mkGeo(bodyIdx, bodyGroups);   // body keeps its materials

  const wheels = {};
  let radius = 0.32;
  for (const [key, indices] of Object.entries(clusters)) {
    const wg = mkGeo(indices, cGroups[key]);
    // pivot at the cluster's own center (in mesh-local space)
    const cb = new THREE.Box3();
    const p = new THREE.Vector3();
    for (const i of indices) cb.expandByPoint(p.fromBufferAttribute(pos, i));
    const center = cb.getCenter(new THREE.Vector3());
    const wm = new THREE.Mesh(wg, mesh.material);
    wm.position.copy(center).negate();
    const pivot = new THREE.Group();
    pivot.rotation.order = "YXZ";
    pivot.position.copy(center);
    pivot.add(wm);
    mesh.add(pivot);
    wheels[key] = pivot;
    radius = cb.getSize(new THREE.Vector3()).y / 2;
  }
  return { wheels, radius };
}

/** load + adapt a model for VehicleBody: returns { visual, chassis, wheels } */
export async function loadCarModel(url, opts = {}) {
  const { group } = await loadModel(url, { targetLength: 4.4, alignLengthToZ: true, ...opts });
  // baked shadow/ground planes ride along in many exports — drop them
  const junk = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const s = o.geometry.boundingBox.getSize(new THREE.Vector3());
    const flat = Math.min(s.x, s.y, s.z) < Math.max(s.x, s.y, s.z) * 0.01;
    if (/floor|shadow|ground|plane/i.test(o.name) || (flat && o.geometry.attributes.position.count < 500))
      junk.push(o);
  });
  for (const j of junk) j.parent?.remove(j);
  const wheels = {};
  const candidates = [];
  group.traverse((o) => { if (/wheel|tyre|tire/i.test(o.name)) candidates.push(o); });
  for (const [key, re] of Object.entries(WHEEL_PATTERNS)) {
    const hit = candidates.find((o) => re.test(o.name) && !Object.values(wheels).includes(o));
    if (hit) {
      // re-pivot: wrap in a group at the wheel's center so steer/spin rotate in place
      const box = new THREE.Box3().setFromObject(hit);
      const c = box.getCenter(new THREE.Vector3());
      const pivot = new THREE.Group();
      pivot.rotation.order = "YXZ";
      hit.parent.add(pivot);
      pivot.position.copy(hit.parent.worldToLocal(c.clone()));
      hit.position.sub(pivot.position);
      pivot.add(hit);
      wheels[key] = pivot;
    }
  }
  if (Object.keys(wheels).length)
    return { visual: group, chassis: group.children[0] ?? group, wheels, wheelRadius: null };

  // no named wheels: try cutting them out of the biggest baked mesh
  let biggest = null;
  group.traverse((o) => {
    if (o.isMesh && (!biggest || o.geometry.attributes.position.count > biggest.geometry.attributes.position.count))
      biggest = o;
  });
  const cut = biggest ? extractWheels(biggest) : null;
  if (cut) {
    // radius comes back in MESH-local units; convert to world via the
    // normalization scale baked onto the group tree
    const scale = new THREE.Vector3();
    biggest.getWorldScale(scale);
    return { visual: group, chassis: group.children[0] ?? group, wheels: cut.wheels, wheelRadius: cut.radius * scale.y };
  }
  return { visual: group, chassis: group.children[0] ?? group, wheels: null, wheelRadius: null };
}

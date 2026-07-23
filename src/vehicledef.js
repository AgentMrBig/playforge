import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Vehicle framework — turns a part-named car model (FBX/GLB) into a fully
 * rigged, drivable vehicle: steering + spinning wheels, openable doors / hood
 * / trunk, a steering wheel that turns, and switchable lights.
 *
 *   const rig = await loadVehicle("/models/sedanpack/Assets/Car.fbx",
 *                                 { targetLength: 4.6 });
 *   world.spawn("car").mesh(rig.visual)
 *     .add(new VehicleBody({ chassis: rig.chassis, wheels: rig.wheels,
 *                            wheelRadius: rig.wheelRadius, ...tuning }))
 *     .add(new VehicleRig(rig));   // steering wheel + openables + lights
 *
 * Part detection is by keyword on the node names (case-insensitive), the
 * convention this pack uses and most car assets follow:
 *   *hood* *trunk* *steering* *door*(fl/fr/bl/br) *wheel*(fl/fr) *wheels_b*
 *   *light* (emergency bar).  Everything else stays as static body detail.
 *
 * The rig object:
 *   { visual, chassis, wheels:{fl,fr,rl,rr}, wheelRadius,
 *     doors:{fl,fr,bl,br}, hood, trunk, steering, lights:{brake,reverse,...},
 *     openParts:[...]  // everything animatable, for VehicleRig }
 */

const LOADERS = {
  fbx: () => new FBXLoader(),
  glb: () => new GLTFLoader(),
  gltf: () => new GLTFLoader(),
};

function classify(name) {
  const n = name.toLowerCase();
  if (n.includes("door"))
    return { role: "door", sub: n.includes("fl") ? "fl" : n.includes("fr") ? "fr"
                              : n.includes("bl") ? "bl" : n.includes("br") ? "br" : null };
  if (n.includes("steering")) return { role: "steering" };
  if (n.includes("wheel")) {
    if (n.includes("fl")) return { role: "wheel", sub: "fl" };
    if (n.includes("fr")) return { role: "wheel", sub: "fr" };
    return { role: "wheel", sub: "rear" };           // Wheels_B (single rear mesh)
  }
  if (n.includes("hood") || n.includes("bonnet")) return { role: "hood" };
  if (n.includes("trunk") || n.includes("boot")) return { role: "trunk" };
  if (n.includes("search")) return { role: "searchlight" };
  if (n.includes("light")) return { role: "lightbar" };
  if (n.includes("radio")) return { role: "radio" };
  if (n.includes("base") || n.includes("body")) return { role: "body" };
  return { role: "detail" };
}

/** reparent `mesh` under a fresh pivot Group at `worldHinge`, preserving pose */
function repivot(mesh, worldHinge, order = "XYZ") {
  const parent = mesh.parent;
  parent.updateWorldMatrix(true, false);
  const pivot = new THREE.Group();
  pivot.rotation.order = order;
  pivot.position.copy(parent.worldToLocal(worldHinge.clone()));
  parent.add(pivot);
  pivot.attach(mesh);                                // keeps mesh world transform
  return pivot;
}

export async function loadVehicle(url, {
  targetLength = 4.6,
  glassOpacity = 0.55,
  shadows = true,
  textureDir = null,        // rebind material maps from here (fixes broken FBX refs)
  textureMap = null,        // {materialKeyword: filename} override
  textureFlipY = false,     // per-pack UV convention (sedan pack false, Assetsville true)
  preYaw = 0,               // rotate the model about Y before measuring/baking —
                            // the Synty tank's long axis is X, so preYaw=π/2 faces it forward
} = {}) {
  const ext = url.split(".").pop().toLowerCase();
  const loaderFn = LOADERS[ext];
  if (!loaderFn) throw new Error("loadVehicle: unsupported " + ext);
  const loaded = await loaderFn().loadAsync(url);
  const root = loaded.scene ?? loaded;               // GLTF wraps in .scene
  // orientation fix: rotate the model about Y before any measuring/baking so the
  // corrected forward axis flows through bbox → scale → convex hull (the Synty
  // tank's long axis is X; preYaw=π/2 turns it to face forward on +Z)
  if (preYaw) { root.rotation.y = preYaw; root.updateMatrixWorld(true); }

  // ---- rebind textures: FBX often references the wrong folder/filename ----
  if (textureDir) {
    const texLoader = new THREE.TextureLoader().setPath(textureDir.replace(/\/?$/, "/"));
    const cache = new Map();
    const get = (file) => {
      if (!cache.has(file)) {
        const t = texLoader.load(file);
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = textureFlipY;                       // pack-specific UV convention
        cache.set(file, t);
      }
      return cache.get(file);
    };
    const resolve = (matName) => {
      const n = matName.toLowerCase();
      if (textureMap) for (const [k, f] of Object.entries(textureMap)) if (n.includes(k)) return f;
      if (n.includes("glass")) return null;           // handled by tint below
      if (n.includes("police")) return "Car_Police.png";
      if (n.includes("taxi")) return "Car_Taxi.png";
      if (n.includes("number")) return "Car_Number.png";
      if (n.includes("detail")) return "Car_details.png";
      if (n.includes("base") || n.includes("color") || n.includes("body")) return "Car_color.png";
      return null;
    };
    const done = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (!m || done.has(m)) return;
        done.add(m);
        const file = resolve(m.name || "");
        if (file) { m.map = get(file); m.color.setHex(0xffffff); m.needsUpdate = true; }
      });
    });
  }

  // ---- SKELETAL vehicle path (UE exports: wheel BONES + one skinned mesh) --
  // Fab/UE vehicles rig wheels as bones (wheelFL/FR/RL/RR) deforming a single
  // SkinnedMesh — no separate wheel meshes to re-pivot. The bones ARE the
  // pivots: spin/steer them and the skinning does the rest.
  {
    const boneWheels = {};
    let hasSkin = false;
    root.traverse((o) => {
      if (o.isSkinnedMesh) hasSkin = true;
      if (!o.isBone) return;
      const n = o.name.toLowerCase();
      if (!n.includes("wheel")) return;
      const sub = n.includes("fl") ? "fl" : n.includes("fr") ? "fr"
                : n.includes("rl") ? "rl" : n.includes("rr") ? "rr" : null;
      if (sub) boneWheels[sub] = o;
    });
    if (hasSkin && Object.keys(boneWheels).length >= 4)
      return rigSkeletalVehicle(root, boneWheels, { targetLength, glassOpacity, shadows, textureDir, textureMap });
  }

  // ---- catalog meshes by role (surgery happens in raw model space) --------
  const parts = { wheels: {}, doors: {}, hood: null, trunk: null, steering: null,
                  body: null, lightbar: null, searchlight: null, radio: null };
  const lights = {};
  const paintMats = new Set();       // body-paint materials, for setPaint()
  const box = new THREE.Box3();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });

  for (const mesh of meshes) {
    const { role, sub } = classify(mesh.name);
    box.setFromObject(mesh);
    const c = box.getCenter(new THREE.Vector3());
    const mn = box.min.clone(), mx = box.max.clone();

    // collect switchable light materials from any mesh that carries them
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => {
      if (!m) return;
      const mn2 = (m.name || "").toLowerCase();
      if (mn2.includes("stop")) lights.brake = m;
      else if (mn2.includes("backlight")) lights.reverse = m;
      else if (mn2.includes("turnlight_l")) lights.turnL = m;
      else if (mn2.includes("turnlight_r")) lights.turnR = m;
      else if (mn2.includes("lightforward")) lights.head = m;
      else if (mn2.includes("base") || mn2.includes("_color") || mn2 === "car_police" || mn2 === "car_taxi")
        paintMats.add(m);            // the body paint (tintable)
      if (m.name === "Glass" || mn2.includes("glass")) {
        m.transparent = true; m.opacity = glassOpacity;
        m.color.setHex(0x20303a); m.shininess = 90;
      }
      if (shadows && m.emissive) m.emissiveIntensity = m.emissiveIntensity ?? 1;
    });

    if (role === "wheel") {
      const pivot = repivot(mesh, c, "YXZ");
      if (sub === "rear") { parts.wheels.rl = pivot; parts.wheels.rr = pivot; }
      else parts.wheels[sub] = pivot;
      parts._wheelR = (mx.y - mn.y) / 2;              // model-space radius
      if (sub === "fl" || sub === "fr") parts._wheelW = mx.x - mn.x; // tire width (axle extent)
    } else if (role === "door" && sub) {
      // hinge at the door's FRONT edge (+Z), vertical axis
      const hinge = new THREE.Vector3(c.x, c.y, mx.z);
      const pivot = repivot(mesh, hinge, "YXZ");
      const left = c.x > 0;                            // +X is left in this model
      parts.doors[sub] = { pivot, axis: "y", open: (left ? -1 : 1) * 1.15 };
    } else if (role === "hood") {
      const hinge = new THREE.Vector3(c.x, mx.y, mn.z); // rear edge, top
      parts.hood = { pivot: repivot(mesh, hinge, "XYZ"), axis: "x", open: -1.0 };
    } else if (role === "trunk") {
      const hinge = new THREE.Vector3(c.x, mx.y, mx.z); // front edge, top
      parts.trunk = { pivot: repivot(mesh, hinge, "XYZ"), axis: "x", open: 0.95 };
    } else if (role === "steering") {
      parts.steering = repivot(mesh, c, "ZYX");
    } else if (role === "searchlight") {
      parts.searchlight = repivot(mesh, c, "YXZ"); // spins around Y (sweeps)
    } else if (role === "radio") {
      parts.radio = mesh;
    } else if (role === "body" && !parts.body) {
      parts.body = mesh;
    } else if (role === "lightbar") {
      parts.lightbar = mesh;
    }
    if (shadows) mesh.castShadow = true;
  }

  // ---- normalize: center X/Z, seat on ground, scale to length -------------
  box.setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.x, size.z);
  root.scale.setScalar(scale);
  box.setFromObject(root);
  const c2 = box.getCenter(new THREE.Vector3());
  root.position.x -= c2.x;
  root.position.z -= c2.z;
  root.position.y -= box.min.y;

  const visual = new THREE.Group();
  visual.add(root);

  // ---- suspension rig: move the wheels onto a level node (siblings of the
  //      body) so the body can roll/pitch/heave on springs while the wheels
  //      stay planted on the ground and never clip through it ---------------
  let suspension = null;
  const wheelKeys = Object.keys(parts.wheels);
  if (wheelKeys.length) {
    const S = root.scale.x;
    const wheelRoot = new THREE.Group();
    wheelRoot.scale.copy(root.scale);          // same scale; identity pos/rot so
    // the wheels sit in plain visual space (attach preserves their world pose)
    visual.add(wheelRoot);
    visual.updateMatrixWorld(true);              // so getWorldPosition is valid
    const corners = {};
    const moved = new Set();
    const wp = new THREE.Vector3();
    for (const key of wheelKeys) {
      const pivot = parts.wheels[key];
      pivot.getWorldPosition(wp);                // visual-space meters (car at origin)
      const ox = wp.x, oz = wp.z;
      if (!moved.has(pivot)) { wheelRoot.attach(pivot); moved.add(pivot); }
      corners[key] = { ox, oz, restLy: pivot.position.y };
    }
    suspension = {
      bodyRoot: root, wheelRoot, scale: S,
      wheelRadius: (parts._wheelR ?? 0.32) * scale,
      wheelWidth: (parts._wheelW ?? 0.4) * scale,   // real tire width (meters)
      baseBodyY: root.position.y, corners, wheels: parts.wheels,
      track: Math.abs((corners.fl?.ox ?? 0.7) - (corners.fr?.ox ?? -0.7)) || 1.4,
      wheelbase: Math.abs((corners.fl?.oz ?? 1.4) - (corners.rl?.oz ?? -1.4)) || 2.6,
      rearOffset: Math.abs(corners.rl?.oz ?? 1.3),   // rear axle behind center
    };
  }

  const openParts = [];
  for (const [k, d] of Object.entries(parts.doors)) openParts.push({ name: "door_" + k, ...d });
  if (parts.hood) openParts.push({ name: "hood", ...parts.hood });
  if (parts.trunk) openParts.push({ name: "trunk", ...parts.trunk });
  for (const p of openParts) { p.t = 0; p.target = 0; p.pivot.rotation[p.axis] = 0; }

  return {
    visual, chassis: root,
    wheels: wheelKeys.length ? parts.wheels : null,
    wheelRadius: (parts._wheelR ?? 0.32) * scale,
    suspension,
    doors: parts.doors, hood: parts.hood, trunk: parts.trunk,
    steering: parts.steering, lightbar: parts.lightbar,
    searchlight: parts.searchlight, radio: parts.radio,
    lights, paintMats: [...paintMats],
    openParts,
    /** repaint the body: tints the paint material(s) — hex like 0xff2020 */
    setPaint(hex) { for (const m of paintMats) m.color.setHex(hex); },
  };
}
/**
 * Skeletal vehicle rig (UE/Fab exports): one rigidly-skinned mesh whose
 * vertices each belong 100% to one bone (carBody / wheelFL/FR/RL/RR).
 *
 * Strategy: DE-SKIN AT LOAD. Every vertex is baked through its bone's bind
 * transform once (applyBoneTransform — the renderer's own math), the mesh is
 * split into a static body + four wheel meshes on plain pivot Groups at the
 * measured wheel centers, and the original hierarchy is thrown away. No
 * skinning at runtime, no bind matrices, no UE frame conventions — the
 * result feeds the exact same suspension-rig contract as the mesh path.
 * (Rigid skinning deforms nothing, so nothing is lost.)
 */
function rigSkeletalVehicle(root, boneWheels, { targetLength, glassOpacity, shadows }) {
  const skins = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });

  // ---- bake all vertices through the skinning math (raw world frame) ------
  // buckets: "body" + wheel keys; each bucket → per-material triangle soup
  const boneKeyByIndex = new Map();
  for (const skin of skins)
    skin.skeleton.bones.forEach((b, i) => {
      for (const [key, wb] of Object.entries(boneWheels)) if (b === wb) boneKeyByIndex.set(skin.uuid + ":" + i, key);
    });
  const buckets = {};                     // key → matIndex → {pos:[], uv:[], col:[]}
  const clusters = {};                    // wheel key → {sum, n, min, max}
  const bb = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) };
  const matList = [];                     // final material array
  const matIndexOf = new Map();
  const v = new THREE.Vector3();
  for (const skin of skins) {
    const geo = skin.geometry;
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    const col = geo.attributes.color;     // Assetsville paints via VERTEX COLORS
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const mats = Array.isArray(skin.material) ? skin.material : [skin.material];
    for (const m of mats) if (!matIndexOf.has(m)) { matIndexOf.set(m, matList.length); matList.push(m); }
    const groups = geo.groups?.length ? geo.groups : [{ start: 0, count: (geo.index ?? pos).count, materialIndex: 0 }];
    const matForFace = (f) => {
      const idx = f * 3;
      for (const g of groups) if (idx >= g.start && idx < g.start + g.count) return matIndexOf.get(mats[g.materialIndex] ?? mats[0]);
      return matIndexOf.get(mats[0]);
    };
    const keyForVert = (i) => {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) { bw = w; best = si.getComponent(i, k); }
      }
      return boneKeyByIndex.get(skin.uuid + ":" + best) ?? "body";
    };
    const baked = (i, out) => {
      out.fromBufferAttribute(pos, i);
      skin.applyBoneTransform(i, out);
      return out.applyMatrix4(skin.matrixWorld);
    };
    const idxArr = geo.index ? geo.index.array : null;
    const faceCount = (idxArr ? idxArr.length : pos.count) / 3;
    for (let f = 0; f < faceCount; f++) {
      const ia = idxArr ? idxArr[f * 3] : f * 3;
      const ib = idxArr ? idxArr[f * 3 + 1] : f * 3 + 1;
      const ic = idxArr ? idxArr[f * 3 + 2] : f * 3 + 2;
      const key = keyForVert(ia);
      const mi = matForFace(f);
      const bkt = (buckets[key] ?? (buckets[key] = {}));
      const slot = (bkt[mi] ?? (bkt[mi] = { pos: [], uv: [], col: [] }));
      for (const i of [ia, ib, ic]) {
        baked(i, v);
        slot.pos.push(v.x, v.y, v.z);
        if (uv) slot.uv.push(uv.getX(i), uv.getY(i));
        // NOTE: the source 'color' attribute is all zeros (UE vertex-paint
        // default) — copying it + FBXLoader's vertexColors=true multiplied
        // every car to BLACK. Drop it entirely.
        bb.min.min(v); bb.max.max(v);
        if (key !== "body") {
          const cl = clusters[key] ?? (clusters[key] = { sum: new THREE.Vector3(), n: 0, min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) });
          cl.sum.add(v); cl.n++; cl.min.min(v); cl.max.max(v);
        }
      }
    }
  }
  const centers = {};
  for (const [k, cl] of Object.entries(clusters)) centers[k] = cl.sum.clone().divideScalar(cl.n);

  // ---- PASS A: rotation from the wheel-center rectangle (points transform
  // exactly; boxes under rotation do NOT — that bug sank two attempts) ------
  const spread = (axis) => {
    const vals = Object.values(centers).map((p) => p[axis]);
    return Math.max(...vals) - Math.min(...vals);
  };
  const R = new THREE.Matrix4();
  const rstep = (m) => {
    R.premultiply(m);
    for (const p of Object.values(centers)) p.applyMatrix4(m);
  };
  if (spread("z") < spread("y") && spread("z") < spread("x")) rstep(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  else if (spread("x") < spread("y") && spread("x") < spread("z")) rstep(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  if (spread("x") > spread("z")) rstep(new THREE.Matrix4().makeRotationY(-Math.PI / 2));

  // ---- PASS B: stream every baked vertex through R once for EXACT bounds --
  let rb, rcl, bodyB;
  const passB = () => {
    rb = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) };
    rcl = {}; bodyB = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) };
    for (const [key, bkt] of Object.entries(buckets)) {
      for (const slot of Object.values(bkt)) {
        for (let i = 0; i < slot.pos.length; i += 3) {
          v.set(slot.pos[i], slot.pos[i + 1], slot.pos[i + 2]).applyMatrix4(R);
          rb.min.min(v); rb.max.max(v);
          if (key === "body") { bodyB.min.min(v); bodyB.max.max(v); }
          else {
            const c2 = rcl[key] ?? (rcl[key] = { min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) });
            c2.min.min(v); c2.max.max(v);
          }
        }
      }
    }
  };
  passB();
  // up-SIGN check: the wheel rectangle is symmetric, so the axis pick can't
  // tell floor from roof — the police car came out upside down once. The
  // body's mass must sit ABOVE the wheel centers; flip 180° if not.
  {
    const wheelMidY = Object.values(rcl).reduce((a, c2) => a + (c2.min.y + c2.max.y) / 2, 0) / Object.keys(rcl).length;
    const bodyMidY = (bodyB.min.y + bodyB.max.y) / 2;
    if (bodyMidY < wheelMidY) {
      R.premultiply(new THREE.Matrix4().makeRotationZ(Math.PI));
      for (const p of Object.values(centers)) p.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI));
      passB();
    }
  }
  // FRONT-sign check: same symmetry problem fore/aft — the Hearse arrived
  // 180° flipped, so the "front" indices steered its REAR wheels (Erik:
  // wheels spin but don't turn). The BONE NAMES are the ground truth:
  // FL/FR must sit at greater +Z than RL/RR. Spin the car if they don't.
  {
    const frontZ = ((centers.fl?.z ?? 0) + (centers.fr?.z ?? 0)) / 2;
    const rearZ = ((centers.rl?.z ?? 0) + (centers.rr?.z ?? 0)) / 2;
    if (frontZ < rearZ) {
      R.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
      for (const p of Object.values(centers)) p.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI));
      passB();
    }
  }
  const len = Math.max(rb.max.x - rb.min.x, rb.max.z - rb.min.z);
  const s = targetLength / len;
  let floorY = 1e9;
  for (const c2 of Object.values(rcl)) floorY = Math.min(floorY, c2.min.y);
  const cx = (rb.min.x + rb.max.x) / 2, cz = (rb.min.z + rb.max.z) / 2;
  const fix = new THREE.Matrix4().makeTranslation(-cx * s, -floorY * s, -cz * s)
    .multiply(new THREE.Matrix4().makeScale(s, s, s))
    .multiply(R);
  // final wheel centers + cluster extents (exact, scaled)
  for (const [key, p] of Object.entries(centers)) {
    p.multiplyScalar(s).add(new THREE.Vector3(-cx * s, -floorY * s, -cz * s));
    const c2 = rcl[key];
    clusters[key].min.copy(c2.min).multiplyScalar(s);
    clusters[key].max.copy(c2.max).multiplyScalar(s);
  }

  // ---- build plain meshes: body group + wheel pivots at their centers -----
  const visual = new THREE.Group();
  const bodyRoot = new THREE.Group();
  const wheelRoot = new THREE.Group();
  visual.add(bodyRoot, wheelRoot);
  const paintMats = new Set();
  for (const m of matList) {
    const n = (m.name || "").toLowerCase();
    if (n.includes("glass")) { m.transparent = true; m.opacity = glassOpacity; m.color.setHex(0x20303a); }
    // UE material-INSTANCE parameters (each car's paint job) do not survive
    // FBX export — the palette texture carries liveries/details, and per-car
    // paint gets re-applied via setPaint. Every material is tintable here
    // (each loadVehicle call owns its own material instances).
    else paintMats.add(m);
    // FBXLoader saw the (all-zero) color attribute and enabled vertexColors —
    // which multiplied everything to black. The attribute is dropped; make
    // sure the flag is off too.
    m.vertexColors = false;
    m.needsUpdate = true;
  }
  const hullPts = [];                                  // visual-space body verts for the physics hull
  const buildMeshes = (bkt, parent, offset, collectHull) => {
    for (const [mi, slot] of Object.entries(bkt)) {
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array(slot.pos);
      for (let i = 0; i < arr.length; i += 3) {
        v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(fix);
        if (collectHull && (i % 24 === 0)) hullPts.push(v.x, v.y, v.z);
        if (offset) v.sub(offset);
        arr[i] = v.x; arr[i + 1] = v.y; arr[i + 2] = v.z;
      }
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      if (slot.uv.length) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(slot.uv), 2));
      g.computeVertexNormals();                        // flat facets (non-indexed)
      const mesh = new THREE.Mesh(g, matList[+mi]);
      if (shadows) mesh.castShadow = true;
      parent.add(mesh);
    }
  };
  buildMeshes(buckets.body ?? {}, bodyRoot, null, true);
  const wheels = {}, corners = {};
  let radius = 0.32, width = 0.24;
  for (const key of ["fl", "fr", "rl", "rr"]) {
    if (!buckets[key]) continue;
    const c = centers[key], cl = clusters[key];
    const pivot = new THREE.Group();
    pivot.rotation.order = "YXZ";        // steer (yaw) FIRST, then spin about
    pivot.position.copy(c);              // the yawed axle — default XYZ made
    wheelRoot.add(pivot);                // steered wheels wobble on two axes
    buildMeshes(buckets[key], pivot, c);
    wheels[key] = pivot;
    corners[key] = { ox: c.x, oz: c.z, restLy: c.y };
    radius = Math.max(0.15, (cl.max.y - cl.min.y) / 2);
    width = Math.max(0.12, cl.max.x - cl.min.x);
  }

  const suspension = {
    bodyRoot, wheelRoot, scale: 1,
    hullPoints: hullPts,                 // exact visual-space physics hull, no scene-graph math
    wheelRadius: radius, wheelWidth: width,
    baseBodyY: 0, corners, wheels,
    track: Math.abs(corners.fl.ox - corners.fr.ox) || 1.5,
    wheelbase: Math.abs(corners.fl.oz - corners.rl.oz) || 2.8,
    rearOffset: Math.abs(corners.rl.oz),
  };

  return {
    visual, chassis: bodyRoot,
    wheels, wheelRadius: radius, suspension,
    doors: {}, hood: null, trunk: null, steering: null, lightbar: null,
    searchlight: null, radio: null, lights: {}, paintMats: [...paintMats],
    openParts: [],
    setPaint(hex) { for (const m of paintMats) m.color.setHex(hex); },
  };
}

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * VehicleRig — drives the cosmetic rig off a sibling VehicleBody:
 * steering-wheel rotation, brake/reverse light emissives, and open/close
 * animation of doors/hood/trunk. Call rig.toggle("door_fl" | "hood" | ...)
 * or openAll()/closeAll() from your controls.
 */
export class VehicleRig {
  constructor(rig, { steeringRatio = 6, sirenHz = 0, headlights = false } = {}) {
    this.rig = rig;
    this.steeringRatio = steeringRatio;
    this.sirenHz = sirenHz;                            // >0 flashes lightbar + spins searchlight
    this.headlights = headlights;
    this._t = 0;
  }
  init() {
    // remember rest emissive so we can pulse without drift
    for (const key of ["brake", "reverse"]) {
      const m = this.rig.lights[key];
      if (m) { m.emissive = m.emissive ?? new THREE.Color(0); m._rest = m.emissive.clone(); }
    }
  }
  toggle(name) {
    const p = this.rig.openParts.find((o) => o.name === name);
    if (p) p.target = p.target > 0.5 ? 0 : 1;
  }
  openAll() { for (const p of this.rig.openParts) p.target = 1; }
  closeAll() { for (const p of this.rig.openParts) p.target = 0; }

  update(dt, { entity }) {
    this._t += dt;
    const body = entity.components.find((c) => c.steer !== undefined && c.throttle !== undefined);
    // steering wheel follows the front wheels
    if (this.rig.steering && body)
      this.rig.steering.rotation.z = -body.steer * this.steeringRatio;
    // open/close animation
    for (const p of this.rig.openParts) {
      if (p.t !== p.target) {
        p.t += Math.sign(p.target - p.t) * dt * 3.2;
        p.t = THREE.MathUtils.clamp(p.t, 0, 1);
      }
      p.pivot.rotation[p.axis] = p.open * smooth(p.t);
    }
    // lights
    const L = this.rig.lights;
    if (body) {
      const braking = body.throttle < -0.05 && body.speed > 0.5;
      const reversing = body.speed < -0.3;
      if (L.brake) L.brake.emissive.setScalar(braking ? 0.9 : 0.12);
      if (L.reverse) L.reverse.emissive.setScalar(reversing ? 0.8 : 0);
      if (L.head) { L.head.emissive = L.head.emissive ?? new THREE.Color(0);
                    L.head.emissive.setScalar(this.headlights ? 0.8 : 0.25); }
      // turn signals blink with steering intent (~2.5 Hz amber)
      const blink = Math.floor(this._t * 2.5) % 2 === 0 ? 0.9 : 0;
      const wantL = body.steer > 0.08, wantR = body.steer < -0.08;
      if (L.turnL) { L.turnL.emissive = L.turnL.emissive ?? new THREE.Color(0);
                     L.turnL.emissive.setRGB(wantL ? blink : 0, wantL ? blink * 0.4 : 0, 0); }
      if (L.turnR) { L.turnR.emissive = L.turnR.emissive ?? new THREE.Color(0);
                     L.turnR.emissive.setRGB(wantR ? blink : 0, wantR ? blink * 0.4 : 0, 0); }
    }
    // police rotating searchlight
    if (this.rig.searchlight && this.sirenHz > 0)
      this.rig.searchlight.rotation.y += dt * 3.0;
    // police siren flash: pulse the lightbar's red/blue emissive materials
    if (this.sirenHz > 0 && this.rig.lightbar && !this._sirenMats) {
      this._sirenMats = { red: [], blue: [] };
      this.rig.lightbar.traverse((o) => {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (!m?.name) return;
          const n = m.name.toLowerCase();
          if (n.includes("red")) { m.emissive = m.emissive ?? new THREE.Color(0); this._sirenMats.red.push(m); }
          else if (n.includes("blue")) { m.emissive = m.emissive ?? new THREE.Color(0); this._sirenMats.blue.push(m); }
        });
      });
    }
    if (this._sirenMats) {
      const phase = Math.floor(this._t * this.sirenHz) % 2;
      for (const m of this._sirenMats.red) m.emissive.setRGB(phase ? 0.9 : 0.05, 0, 0);
      for (const m of this._sirenMats.blue) m.emissive.setRGB(0, 0, phase ? 0.05 : 0.9);
    }
  }
}

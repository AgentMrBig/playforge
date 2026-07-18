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

/** load + adapt a model for VehicleBody: returns { visual, chassis, wheels } */
export async function loadCarModel(url, opts = {}) {
  const { group } = await loadModel(url, { targetLength: 4.4, alignLengthToZ: true, ...opts });
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
  return { visual: group, chassis: group.children[0] ?? group, wheels: Object.keys(wheels).length ? wheels : null };
}

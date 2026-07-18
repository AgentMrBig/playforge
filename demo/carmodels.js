// GTA3-tier procedural car models. Each returns { visual, chassis, wheels }
// ready for VehicleBody ({ chassis, wheels }). No asset files — all boxes,
// wedges, and cylinders, but with real silhouettes: hood/cabin/trunk masses,
// raked windshields, bumpers, emissive head/tail lights, rims, mirrors.
import * as THREE from "three";

const GLASS = new THREE.MeshStandardMaterial({ color: 0x1a2734, roughness: 0.15, metalness: 0.6 });
const TIRE = new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.95 });
const RIM = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.35, metalness: 0.8 });
const CHROME = new THREE.MeshStandardMaterial({ color: 0xcfd4da, roughness: 0.25, metalness: 0.9 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7 });
const HEAD = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffefb0, emissiveIntensity: 0.9 });
const TAIL = new THREE.MeshStandardMaterial({ color: 0xff2a22, emissive: 0xcc1a12, emissiveIntensity: 0.8 });
for (const m of [GLASS, TIRE, RIM, CHROME, DARK, HEAD, TAIL]) m._shared = true;

function paint(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.45 });
}
function box(mat, w, h, d, x, y, z, castShadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  return m;
}
// a box with its top face narrowed along z — instant raked windshield/fastback
function wedge(mat, w, h, d, x, y, z, frontShrink = 0.5, backShrink = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      const zz = p.getZ(i);
      if (zz > 0) p.setZ(i, zz - d * frontShrink * 0.5);
      else p.setZ(i, zz + d * backShrink * 0.5);
    }
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
function wheel(radius, width, x, y, z) {
  const pivot = new THREE.Group();
  pivot.rotation.order = "YXZ";                 // steer (Y) then spin (X)
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 14), TIRE);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 8), RIM);
  rim.rotation.z = Math.PI / 2;
  pivot.add(tire, rim);
  pivot.position.set(x, y, z);
  return pivot;
}
function mirrors(g, mat, w, y, z) {
  for (const s of [-1, 1]) g.add(box(mat, 0.08, 0.1, 0.16, s * (w / 2 + 0.09), y, z));
}
function lights(g, w, y, zFront, zBack) {
  for (const s of [-1, 1]) {
    g.add(box(HEAD, 0.28, 0.12, 0.06, s * (w / 2 - 0.25), y, zFront, false));
    g.add(box(TAIL, 0.3, 0.12, 0.06, s * (w / 2 - 0.25), y, zBack, false));
  }
}

/** family sedan — three-box, upright cabin, chrome bumpers */
export function sedan(color = 0xd8d8d8) {
  const body = paint(color);
  const g = new THREE.Group(), chassis = new THREE.Group();
  chassis.add(
    box(body, 1.7, 0.42, 4.1, 0, 0.62, 0),                     // main mass
    box(body, 1.68, 0.18, 1.2, 0, 0.85, 1.35),                 // hood top
    box(body, 1.68, 0.16, 0.9, 0, 0.84, -1.5),                 // trunk
    wedge(GLASS, 1.5, 0.5, 1.9, 0, 1.1, -0.15, 0.55, 0.35),    // greenhouse
    box(CHROME, 1.74, 0.12, 0.18, 0, 0.44, 2.05),              // bumpers
    box(CHROME, 1.74, 0.12, 0.18, 0, 0.44, -2.05),
  );
  mirrors(chassis, body, 1.7, 0.95, 0.75);
  lights(chassis, 1.7, 0.62, 2.06, -2.06);
  const wheels = {
    fl: wheel(0.34, 0.24, -0.78, 0.34, 1.32), fr: wheel(0.34, 0.24, 0.78, 0.34, 1.32),
    rl: wheel(0.34, 0.24, -0.78, 0.34, -1.32), rr: wheel(0.34, 0.24, 0.78, 0.34, -1.32),
  };
  g.add(chassis, ...Object.values(wheels));
  return { visual: g, chassis, wheels };
}

/** muscle car — long hood, scoop, low fastback, fat rear tires */
export function muscle(color = 0xc23b3b) {
  const body = paint(color);
  const g = new THREE.Group(), chassis = new THREE.Group();
  chassis.add(
    box(body, 1.85, 0.4, 4.4, 0, 0.58, 0),
    box(body, 1.8, 0.22, 1.9, 0, 0.86, 1.15),                  // long hood
    box(DARK, 0.5, 0.14, 0.7, 0, 0.99, 1.2),                   // scoop
    wedge(GLASS, 1.6, 0.44, 1.7, 0, 1.06, -0.6, 0.65, 0.5),    // fastback
    box(body, 1.82, 0.2, 0.8, 0, 0.8, -1.75),                  // rear deck
    box(DARK, 1.86, 0.14, 0.2, 0, 0.5, 2.2),
    box(DARK, 1.86, 0.14, 0.2, 0, 0.5, -2.2),
  );
  mirrors(chassis, body, 1.85, 0.95, 0.35);
  lights(chassis, 1.85, 0.6, 2.21, -2.21);
  const wheels = {
    fl: wheel(0.34, 0.26, -0.82, 0.34, 1.4), fr: wheel(0.34, 0.26, 0.82, 0.34, 1.4),
    rl: wheel(0.38, 0.34, -0.8, 0.38, -1.45), rr: wheel(0.38, 0.34, 0.8, 0.38, -1.45),
  };
  g.add(chassis, ...Object.values(wheels));
  return { visual: g, chassis, wheels };
}

/** supercar — low wide wedge, mid cabin, rear wing */
export function sports(color = 0xd8a13b) {
  const body = paint(color);
  const g = new THREE.Group(), chassis = new THREE.Group();
  chassis.add(
    wedge(body, 1.95, 0.34, 4.3, 0, 0.5, 0, 0.35, 0.1),        // wedge body
    wedge(GLASS, 1.55, 0.4, 1.8, 0, 0.86, 0.1, 0.75, 0.55),    // canopy
    box(body, 1.9, 0.16, 0.7, 0, 0.62, -1.8),
    box(DARK, 1.7, 0.06, 0.42, 0, 1.02, -2.0),                 // wing
    box(DARK, 0.1, 0.3, 0.1, -0.65, 0.85, -2.0),
    box(DARK, 0.1, 0.3, 0.1, 0.65, 0.85, -2.0),
  );
  lights(chassis, 1.95, 0.5, 2.14, -2.14);
  const wheels = {
    fl: wheel(0.33, 0.28, -0.85, 0.33, 1.42), fr: wheel(0.33, 0.28, 0.85, 0.33, 1.42),
    rl: wheel(0.36, 0.34, -0.83, 0.36, -1.4), rr: wheel(0.36, 0.34, 0.83, 0.36, -1.4),
  };
  g.add(chassis, ...Object.values(wheels));
  return { visual: g, chassis, wheels };
}

/** top fuel dragster — rail frame, tiny front wheels, monster slicks, wing */
export function dragster(color = 0x2f2f34) {
  const body = paint(color);
  const g = new THREE.Group(), chassis = new THREE.Group();
  chassis.add(
    box(body, 0.5, 0.3, 6.4, 0, 0.42, 0.4),                    // rail
    wedge(body, 0.5, 0.34, 1.6, 0, 0.6, 2.9, 0.8, 0),          // nose cone
    box(DARK, 0.45, 0.5, 0.7, 0, 0.72, -1.0),                  // engine block
    box(CHROME, 0.16, 0.5, 0.16, -0.28, 1.0, -1.0),            // pipes
    box(CHROME, 0.16, 0.5, 0.16, 0.28, 1.0, -1.0),
    wedge(GLASS, 0.44, 0.3, 0.6, 0, 0.78, -0.1, 0.6, 0.3),     // canopy
    box(DARK, 2.3, 0.08, 0.6, 0, 1.9, -2.4),                   // huge wing
    box(DARK, 0.12, 0.9, 0.12, -0.5, 1.4, -2.4),
    box(DARK, 0.12, 0.9, 0.12, 0.5, 1.4, -2.4),
  );
  lights(chassis, 0.6, 0.5, 3.6, -2.9);
  const wheels = {
    fl: wheel(0.2, 0.1, -0.75, 0.2, 2.9), fr: wheel(0.2, 0.1, 0.75, 0.2, 2.9),
    rl: wheel(0.55, 0.5, -0.85, 0.55, -2.2), rr: wheel(0.55, 0.5, 0.85, 0.55, -2.2),
  };
  g.add(chassis, ...Object.values(wheels));
  return { visual: g, chassis, wheels };
}

export const CAR_MODELS = { sedan, muscle, sports, dragster };

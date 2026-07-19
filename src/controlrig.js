// PlayForge CONTROL RIG — Erik (2026-07-19): "dragging by end effector is pretty cool
// and I want to keep that, but we need a control rig that I can basically animate the
// character's behaviors."
//
// Owned by General (character lane). Clickable HANDLES on the body:
//   🟠 hands + feet  → the existing two-bone IK (with poles)
//   🟡 hips          → drag TRANSLATES the pelvis (weight shifting / crouching lean)
//   🔵 chest + head  → drag ROTATES (dx = twist around up, dy = lean toward camera-up)
// Handles reposition onto their bones every frame; picking is a real mouse ray.
// Poses made with the rig feed the same 📸 keyframes + behavior timeline.

import * as THREE from "three";
import { rotateWorld } from "./ik.js";

const COLORS = { hand: 0xffa53b, foot: 0xffa53b, hips: 0xffd84d, chest: 0x53c8ff, head: 0x53c8ff, aim: 0xc07aff };

/** find ONE connected bone by name regex, skipping this rig's duplicate wrappers:
 * prefer the bone whose parent does NOT share its name (outermost of a nested dup run)
 * and which has children (connected), searched from the skinned skeleton's bone list. */
function findBone(playerObj, re) {
  let best = null;
  playerObj.traverse((o) => {
    if (best || !o.isSkinnedMesh || !o.skeleton) return;
    for (const b of o.skeleton.bones) {
      if (!re.test(b.name)) continue;
      let top = b; while (top.parent && re.test(top.parent.name)) top = top.parent;   // outermost of the dup run
      best = top; break;
    }
  });
  return best;
}

export class ControlRig {
  /** @param {object} o.scene @param {object} o.playerObj character root @param {object} o.player entity */
  constructor({ scene, playerObj, player }) {
    this.scene = scene; this.playerObj = playerObj; this.player = player;
    this.visible = false;
    this._ray = new THREE.Raycaster();
    this._handles = {};                    // id → { mesh, kind, limb?, bone? }
    // control CURVES (Maya-style, per Erik's reference): rings/boxes/ground circles,
    // plus an invisible pick-sphere collider at each control (raycasting lines is flaky)
    const lineMat = (kind) => new THREE.LineBasicMaterial({ color: COLORS[kind], depthTest: false, transparent: true, opacity: 0.9 });
    const ring = (r, kind, flat = true) => {
      const pts = []; for (let i = 0; i <= 32; i++) { const a = (i / 32) * Math.PI * 2;
        pts.push(flat ? new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r) : new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(kind));
      l.renderOrder = 998; return l;
    };
    const box = (w, h, d, kind) => {
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), lineMat(kind));
      l.renderOrder = 998; return l;
    };
    const SHAPES = {
      hand: () => ring(0.1, "hand"),
      foot: () => { const g = new THREE.Group(); const r = ring(0.17, "foot"); r.position.y = -0.05; g.add(r); return g; },
      hips: () => ring(0.3, "hips"),
      chest: () => box(0.42, 0.28, 0.26, "chest"),
      head: () => { const g = new THREE.Group(); const r = ring(0.16, "head"); r.position.y = 0.18; g.add(r); return g; },
      // pole-vector aim (knee/elbow): small crossed-ring locator, Maya-style
      aim: () => { const g = new THREE.Group(); g.add(ring(0.06, "aim", true)); g.add(ring(0.06, "aim", false)); return g; },
    };
    const add = (id, kind, opts = {}) => {
      const g = new THREE.Group();
      g.add(SHAPES[kind]());
      const picker = new THREE.Mesh(
        new THREE.SphereGeometry(kind === "hand" ? 0.1 : kind === "aim" ? 0.07 : 0.16, 8, 6),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      picker.userData.rigId = id;
      g.add(picker);
      g.visible = false;
      scene.add(g);
      this._handles[id] = { mesh: g, picker, kind, ...opts };
    };
    add("handL", "hand", { limb: "handL" }); add("handR", "hand", { limb: "handR" });
    add("footL", "foot", { limb: "footL" }); add("footR", "foot", { limb: "footR" });
    add("hips", "hips", { re: /^hips$/i });
    add("chest", "chest", { re: /^spine2$/i });
    add("head", "head", { re: /^head$/i });
    // knee/elbow aims — where the joint POINTS (pole vectors, Erik: "research the knee
    // aims and elbow aims"). aimFor names the limb whose mid-joint they steer.
    add("kneeL", "aim", { aimFor: "footL" }); add("kneeR", "aim", { aimFor: "footR" });
    add("elbowL", "aim", { aimFor: "handL" }); add("elbowR", "aim", { aimFor: "handR" });
    // dashed guide line from each mid joint to its aim (visual link, Maya-style)
    this._aimLines = {};
    for (const id of ["kneeL", "kneeR", "elbowL", "elbowR"]) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color: COLORS.aim, dashSize: 0.05, gapSize: 0.04, depthTest: false, transparent: true, opacity: 0.6 }));
      l.renderOrder = 997; l.visible = false; scene.add(l);
      this._aimLines[id] = l;
    }
  }

  setVisible(on) {
    this.visible = on;
    for (const id in this._handles) this._handles[id].mesh.visible = on;
    if (!on) for (const id in this._aimLines) this._aimLines[id].visible = false;
  }

  /** reposition + ORIENT handles onto their bones (call per frame while visible).
   * Watch rule (Erik): a ring wears its bone like a watch — its axis follows the bone's
   * length direction, never twisting into the limb. Axis measured from world positions
   * (parent → bone), NOT bind frames (this rig's bind frames lie). */
  update(limbChainFn, poleFn = null) {
    if (!this.visible) return;
    const up = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(), pp = new THREE.Vector3();
    for (const id in this._handles) {
      const h = this._handles[id];
      // aim controls sit at the limb's pole position (override or computed default)
      if (h.aimFor) {
        if (!poleFn) { h.mesh.visible = false; continue; }
        h.mesh.visible = this.visible;
        h.mesh.position.copy(poleFn(h.aimFor));
        const chain = limbChainFn(this.playerObj, h.aimFor);
        const line = this._aimLines[id];
        if (chain && line) {
          const pos = line.geometry.attributes.position;
          chain.mid.getWorldPosition(pp);
          pos.setXYZ(0, pp.x, pp.y, pp.z);
          pos.setXYZ(1, h.mesh.position.x, h.mesh.position.y, h.mesh.position.z);
          pos.needsUpdate = true;
          line.computeLineDistances();
          line.visible = true;
        }
        continue;
      }
      let bone = h.bone;
      if (!bone) {
        bone = h.bone = h.limb ? (limbChainFn(this.playerObj, h.limb) || {}).eff : findBone(this.playerObj, h.re);
      }
      if (!bone) continue;
      bone.getWorldPosition(h.mesh.position);
      if (h.kind === "hand" || h.kind === "chest") {
        // ring/box axis = the bone's length direction, like a watch band on the wrist.
        // Skip same-named wrapper parents (RightHand→RightHand sit at the SAME spot = zero axis)
        let par = bone.parent; while (par && par.name === bone.name) par = par.parent;
        (par || bone.parent).getWorldPosition(pp);
        axis.copy(h.mesh.position).sub(pp);
        if (axis.lengthSq() > 1e-8) h.mesh.quaternion.setFromUnitVectors(up, axis.normalize());
      }
      // hips band / head halo / foot circles stay world-flat by design
    }
  }

  /** highlight the grabbed control white; null restores base colors */
  highlight(id) {
    if (this._hl === id) return;
    this._hl = id;
    for (const k in this._handles) {
      const h = this._handles[k];
      h.mesh.traverse((o) => { if (o.isLine || o.isLineSegments) o.material.color.setHex(k === id ? 0xffffff : COLORS[h.kind]); });
    }
  }

  /** mouse-ray pick: returns handle id or null. nx/ny = NDC (-1..1) */
  pick(nx, ny, camera) {
    if (!this.visible) return null;
    this._ray.setFromCamera({ x: nx, y: ny }, camera);
    this._ray.params.Points = this._ray.params.Points || {};
    const pickers = Object.values(this._handles).map((h) => h.picker);
    for (const h of Object.values(this._handles)) h.mesh.updateMatrixWorld(true);   // GROUP matrices (parent of pickers) may predate the next render
    const hit = this._ray.intersectObjects(pickers, false)[0];
    return hit ? hit.object.userData.rigId : null;
  }

  /** apply a drag to a non-limb control. dRight/dUp = world-space camera-plane delta; camera for axes */
  drag(id, dRight, dUp, camera) {
    const h = this._handles[id]; if (!h || !h.bone) return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (h.kind === "hips") {
      // translate the pelvis in the camera plane (world → the bone's parent space)
      const bone = h.bone, parent = bone.parent;
      const w = bone.getWorldPosition(new THREE.Vector3()).addScaledVector(right, dRight).addScaledVector(up, dUp);
      bone.position.copy(parent.worldToLocal(w));
    } else {
      // chest/head: dx twists around world-up, dy leans around camera-right
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dRight * 2.2)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dUp * 2.2));
      rotateWorld(h.bone, q);
    }
  }
}

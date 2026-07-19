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

const COLORS = { hand: 0xffa53b, foot: 0xffa53b, hips: 0xffd84d, chest: 0x53c8ff, head: 0x53c8ff };

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
    const add = (id, kind, opts = {}) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(kind === "hips" ? 0.06 : 0.045, 12, 10),
        new THREE.MeshBasicMaterial({ color: COLORS[kind], depthTest: false, transparent: true, opacity: 0.85 }));
      m.renderOrder = 998; m.visible = false; m.userData.rigId = id;
      scene.add(m);
      this._handles[id] = { mesh: m, kind, ...opts };
    };
    add("handL", "hand", { limb: "handL" }); add("handR", "hand", { limb: "handR" });
    add("footL", "foot", { limb: "footL" }); add("footR", "foot", { limb: "footR" });
    add("hips", "hips", { re: /^hips$/i });
    add("chest", "chest", { re: /^spine2$/i });
    add("head", "head", { re: /^head$/i });
  }

  setVisible(on) {
    this.visible = on;
    for (const id in this._handles) this._handles[id].mesh.visible = on;
  }

  /** reposition handles onto their bones (call per frame while visible) */
  update(limbChainFn) {
    if (!this.visible) return;
    for (const id in this._handles) {
      const h = this._handles[id];
      let bone = h.bone;
      if (!bone) {
        bone = h.bone = h.limb ? (limbChainFn(this.playerObj, h.limb) || {}).eff : findBone(this.playerObj, h.re);
      }
      if (bone) bone.getWorldPosition(h.mesh.position);
    }
  }

  /** mouse-ray pick: returns handle id or null. nx/ny = NDC (-1..1) */
  pick(nx, ny, camera) {
    if (!this.visible) return null;
    this._ray.setFromCamera({ x: nx, y: ny }, camera);
    this._ray.params.Points = this._ray.params.Points || {};
    const meshes = Object.values(this._handles).map((h) => h.mesh);
    for (const m of meshes) m.updateMatrixWorld(true);   // handles move per-frame; matrices may predate the next render
    const hit = this._ray.intersectObjects(meshes, false)[0];
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

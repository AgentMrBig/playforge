// PlayForge FOOT PLANTING — Erik (2026-07-19): in idle "the feet would actually stay
// planted and he would be shifting his weight back and forth" — but the clip sways the
// pelvis and the feet slide because nothing pins them.
//
// Owned by General (character lane). Each frame AFTER the animator writes the clip pose:
// while standing still on the ground, each foot's target LOCKS to where it first touched;
// two-bone IK (hip→knee→ankle, knee-forward pole) pulls the leg back onto the lock while
// the body keeps swaying above. If the clip moves a foot far enough (a real step/turn),
// the lock releases and re-plants — so it never fights actual locomotion.

import * as THREE from "three";
import { solveTwoBone, limbChain } from "./ik.js";

const _v = new THREE.Vector3();

export class FootPlant {
  /**
   * @param {object} o
   * @param {object} o.playerObj   character root (bones live under it)
   * @param {object} o.player      the entity (for facing / position)
   * @param {(x:number,z:number)=>number} [o.heightAt]  terrain height (feet snap to it)
   */
  constructor({ playerObj, player, heightAt = null, rayGround = null, footOffset = 0.02 } = {}) {
    this.playerObj = playerObj; this.player = player; this.heightAt = heightAt;
    // rayGround(x, z, footY) => surface Y | null — a physics raycast so feet plant on
    // the REAL surface (ramps, steps, obstacles), not just a flat height function.
    this.rayGround = rayGround;
    // the IK effector is the ANKLE bone, which naturally sits this far ABOVE the sole.
    // Target it to groundY+footOffset so the SOLE touches (0.02 targeted ground level,
    // which is unreachable → the leg over-extended and LIFTED the foot).
    this.footOffset = footOffset;
    this.enabled = true;
    this.releaseDist = 0.22;      // clip moved the foot this far → real step, re-plant
    this.locks = { footL: null, footR: null };   // world Vector3 targets
    if (typeof window !== "undefined") window.__footPlant = this;
  }

  /** surface Y under a foot: raycast first (sees obstacles), else the height function */
  _groundY(x, z, footY) {
    if (this.rayGround) { const y = this.rayGround(x, z, footY); if (y != null) return y; }
    return this.heightAt ? this.heightAt(x, z) : null;
  }

  /** call once per frame, after the animator + aim layers.
   * standing: idle → feet LOCK in place. moving: feet CONFORM — never sink into terrain
   * (Erik: "automatic feet touch the ground and react"). */
  update(standing, moving = false) {
    if (!this.enabled || (!standing && !moving)) { this.locks.footL = this.locks.footR = null; return; }
    if (!standing && moving) {
      this.locks.footL = this.locks.footR = null;
      if (!this.heightAt && !this.rayGround) return;
      // locomotion ground-conform: if the clip puts a foot BELOW the surface (slopes,
      // steps, obstacles), IK it up onto it; above-surface swing is the clip's business
      for (const limb of ["footL", "footR"]) {
        const chain = limbChain(this.playerObj, limb);
        if (!chain) continue;
        chain.eff.getWorldPosition(_v);
        const g = this._groundY(_v.x, _v.z, _v.y);
        if (g == null) continue;
        const ground = g + this.footOffset;
        if (_v.y < ground - 0.015) {
          const target = _v.clone(); target.y = ground;
          const anchor = chain.root.getWorldPosition(new THREE.Vector3());
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.object3d.quaternion);
          const pole = anchor.clone().addScaledVector(fwd, 0.8).add(new THREE.Vector3(0, 0.4, 0));
          solveTwoBone({ ...chain, target, pole, iterations: 2 });
        }
      }
      return;
    }
    for (const limb of ["footL", "footR"]) {
      const chain = limbChain(this.playerObj, limb);
      if (!chain) continue;
      chain.eff.getWorldPosition(_v);
      let lock = this.locks[limb];
      if (!lock || _v.distanceTo(lock) > this.releaseDist) {
        // (re)plant where the clip has the foot now, snapped to the real surface
        lock = this.locks[limb] = _v.clone();
        const g = this._groundY(lock.x, lock.z, _v.y);
        if (g != null) lock.y = g + this.footOffset;
      }
      // knee-forward pole from the character's facing
      const anchor = chain.root.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.object3d.quaternion);
      const pole = anchor.clone().addScaledVector(fwd, 0.8).add(new THREE.Vector3(0, 0.4, 0));
      solveTwoBone({ ...chain, target: lock, pole, iterations: 2 });
    }
  }
}

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

const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _hip = new THREE.Vector3();
const _anchor = new THREE.Vector3(), _fwd = new THREE.Vector3(), _pole = new THREE.Vector3();

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
    this.plantBand = 0.14;        // a foot within this of the surface = STANCE (plant it); higher = SWING (leave to clip)
    this.maxReach = 0.45;         // if a locked foot is farther than this (horiz) from its hip, re-plant — stops the leg splaying into a split
    this.idleNarrow = 0.62;       // idle stance width vs the clip (0.62 → pulls the wide clip stance ~38% narrower)
    this.locks = { footL: null, footR: null };   // world Vector3 targets
    if (typeof window !== "undefined") window.__footPlant = this;
  }

  /** surface Y under a foot: raycast first (sees obstacles), else the height function */
  _groundY(x, z, footY) {
    if (this.rayGround) { const y = this.rayGround(x, z, footY); if (y != null) return y; }
    return this.heightAt ? this.heightAt(x, z) : null;
  }

  /** call once per frame, after the animator + aim layers.
   * FOOT LOCKING: whenever a foot is planted (near the surface = stance) its WORLD
   * position is LOCKED and the leg IK holds it there while the body moves over it — so
   * it doesn't slide even if the clip's stride cadence doesn't match ground speed. The
   * lock releases the instant the clip lifts the foot to swing; it re-plants where the
   * foot next comes down. Works for both standing and walking/running. */
  update(standing, moving = false) {
    if (!this.enabled || (!standing && !moving)) { this.locks.footL = this.locks.footR = null; return; }
    if (!this.heightAt && !this.rayGround) return;
    for (const limb of ["footL", "footR"]) {
      const chain = limbChain(this.playerObj, limb);
      if (!chain) continue;
      chain.eff.getWorldPosition(_v);
      const surf = this._groundY(_v.x, _v.z, _v.y);
      if (surf == null) { this.locks[limb] = null; continue; }
      const target = surf + this.footOffset;             // ankle height so the sole sits on the surface
      if (standing) {
        // IDLE: conform to the surface HEIGHT only — NO horizontal lock, so the idle clip
        // freely settles the feet TOGETHER when he stops (the lock used to freeze him in a
        // mid-stride stance). He's stationary, so there's no ground motion to slide anyway.
        this.locks[limb] = null;
        if (_v.y - target < this.plantBand) { _t.copy(_v); _t.y = target; this._solveFoot(chain, _t); }
      } else {
        // MOVING: LOCK the planted foot in world space (anti-slide); releases when the clip
        // lifts it to swing. Clip playback is speed-matched so it releases on time (no drag);
        // over-reach-clamped so an outrun foot slides to the reach limit, never a split.
        const planted = _v.y - target < this.plantBand;
        if (!planted) { this.locks[limb] = null; continue; }
        let lock = this.locks[limb];
        if (!lock) lock = this.locks[limb] = _v.clone();
        chain.root.getWorldPosition(_hip);
        const dx = lock.x - _hip.x, dz = lock.z - _hip.z, r = Math.hypot(dx, dz);
        if (r > this.maxReach) { const s = this.maxReach / r; lock.x = _hip.x + dx * s; lock.z = _hip.z + dz * s; }
        lock.y = target;
        this._solveFoot(chain, lock);
      }
    }
  }

  /** two-bone IK the leg onto `target`, knee poled forward from the character's facing */
  _solveFoot(chain, target) {
    chain.root.getWorldPosition(_anchor);
    _fwd.set(0, 0, 1).applyQuaternion(this.player.object3d.quaternion);
    _pole.copy(_anchor).addScaledVector(_fwd, 0.8); _pole.y += 0.4;
    solveTwoBone({ ...chain, target, pole: _pole, iterations: 4 });   // converge tight so the lock holds (no residual slide)
  }
}

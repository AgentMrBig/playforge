// PlayForge procedural character posing — layered OVER the mocap clips. Owned by
// General (character lane). Runs AFTER the Animator (THREE.AnimationMixer) each frame
// and ADDS an aim/crouch pose on top of whatever clip is playing: raise the arms to
// hold the weapon, pitch the upper body toward where you're aiming, and crouch.
//
// Erik wants procedural (never blocked on mocap) + a ship->look->tune loop. Bone axes
// depend on the skeleton's bind orientation and can't be verified headless, so EVERY
// amount lives in `this.p` and is exposed at `window.__pfAnim.p` for live tuning:
//   __pfAnim.p.armRaise = 1.2   // dial arm lift live, no redeploy
//   __pfAnim.p.armAxis  = "z"   // flip the rotation axis if a bone bends the wrong way
// Values blend in/out smoothly (no snapping), and are ADDED to the clip pose so walk/
// idle still play underneath.

import * as THREE from "three";

const find = (bones, res) => { for (const re of res) for (const k in bones) if (re.test(k)) return bones[k]; return null; };

export class CharacterAim {
  /**
   * @param {Object<string,THREE.Bone>} bones  name->bone map from loadCharacter
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {()=>boolean} [o.isArmed]   hold/aim pose active (default: never)
   * @param {()=>boolean} [o.isCrouch]
   */
  constructor(bones, { camera, isArmed = () => false, isCrouch = () => false } = {}) {
    this.camera = camera; this.isArmed = isArmed; this.isCrouch = isCrouch;
    this.b = {
      spine: find(bones, [/spine2/i, /spine1/i, /chest/i, /spine/i]),
      armR: find(bones, [/rightarm/i, /(upperarm|arm)_r\b/i, /shoulder_r/i]),
      foreR: find(bones, [/rightforearm/i, /(lowerarm|forearm)_r\b/i]),
      armL: find(bones, [/leftarm/i, /(upperarm|arm)_l\b/i, /shoulder_l/i]),
      foreL: find(bones, [/leftforearm/i, /(lowerarm|forearm)_l\b/i]),
      upLegR: find(bones, [/rightupleg/i, /(thigh|upperleg)_r\b/i]),
      loLegR: find(bones, [/rightleg/i, /(calf|lowerleg|shin)_r\b/i]),
      upLegL: find(bones, [/leftupleg/i, /(thigh|upperleg)_l\b/i]),
      loLegL: find(bones, [/leftleg/i, /(calf|lowerleg|shin)_l\b/i]),
    };
    this.aim = 0; this.crouch = 0;
    // NEUTRALIZED 2026-07-19: blind axis-guess stretched the arms + floated on crouch.
    // Amounts default to 0 (character = pure mocap) until the correct bone axes are
    // determined headlessly (pose the skeleton, read hand/foot positions). Re-enable by
    // setting these live via window.__pfAnim.p once the axes are proven.
    // Axes proven headless (pose skeleton, read tip world pos): Spine2.x leans the
    // upper body fwd/back = aim pitch (sign already right). Arm rifle-hold needs 2 axes
    // (finicky) and crouch needs foot-IK — both deferred, kept at 0 until done right.
    this.p = {
      spinePitch: 0.45, spineAxis: "x",
      // arm rifle-hold — axes MEASURED headless (probe_arm3, skeleton bones): right arm
      // local x-neg raises the hand UP, z-pos brings it FORWARD. Additive on the clip so
      // still tune to taste via __pfAnim.p.{armRaise,armFwd,foreBend}.
      armRaise: 0.7, armFwd: 0.5, foreBend: 0.6,
      crouchKnee: 0, crouchAxis: "x", blend: 10,
    };
    if (typeof window !== "undefined") window.__pfAnim = this;
  }

  _rot(bone, axis, amt) { if (bone && amt) bone.rotation[axis] += amt; }

  update(dt) {
    const k = 1 - Math.exp(-this.p.blend * dt);
    this.aim += ((this.isArmed() ? 1 : 0) - this.aim) * k;
    this.crouch += ((this.isCrouch() ? 1 : 0) - this.crouch) * k;
    const p = this.p;

    // aim: pitch the upper body toward the camera look, raise both arms to hold the weapon
    if (this.aim > 0.001) {
      let pitch = 0;
      if (this.camera) { const d = new THREE.Vector3(); this.camera.getWorldDirection(d); pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)); }
      this._rot(this.b.spine, p.spineAxis, -pitch * p.spinePitch * this.aim);
      // right (trigger) arm: raise (x-neg) + bring forward (z-pos) into the hold, bend elbow
      this._rot(this.b.armR, "x", -p.armRaise * this.aim);
      this._rot(this.b.armR, "z", p.armFwd * this.aim);
      this._rot(this.b.foreR, "x", -p.foreBend * this.aim);
      // left (support) arm: mirror the forward reach so both hands come to the weapon
      this._rot(this.b.armL, "x", -p.armRaise * 0.9 * this.aim);
      this._rot(this.b.armL, "z", -p.armFwd * this.aim);
      this._rot(this.b.foreL, "x", -p.foreBend * this.aim);
    }

    // crouch: bend the knees (hips drop falls out of the leg bend naturally)
    if (this.crouch > 0.001) {
      this._rot(this.b.upLegR, p.crouchAxis, p.crouchKnee * this.crouch);
      this._rot(this.b.loLegR, p.crouchAxis, -p.crouchKnee * 1.5 * this.crouch);
      this._rot(this.b.upLegL, p.crouchAxis, p.crouchKnee * this.crouch);
      this._rot(this.b.loLegL, p.crouchAxis, -p.crouchKnee * 1.5 * this.crouch);
    }
  }

  /** report which bones were resolved (for wiring sanity) */
  found() { const o = {}; for (const k in this.b) o[k] = !!this.b[k]; return o; }
}

// PlayForge trajectory leaning — the first slice of the RDR2-tier "weight" pass.
// Owned by General (character lane). Runs AFTER the Animator each frame and ADDS a
// spine lean on top of whatever clip is playing, driven by the capsule's ACCELERATION:
//   • accelerate forward → torso tips into the run
//   • brake / stop hard  → torso pitches back, digging the heels in
//   • hard turn          → the body banks into the turn
// This is Step 3 of Erik's roadmap: manually inject procedural lean matrices before any
// full motion-matching, for the immediate heavy-weight illusion at zero new physics cost.
//
// Bone axes + gains depend on the skeleton's bind pose and CAN'T be judged headless, so
// every amount is live-tunable at window.__pfLean.p (same play as __pfAnim / __rag.tone):
//   __pfLean.p.fwdGain = 0.02    // stronger start/stop lean
//   __pfLean.p.sideGain = 0.02   // stronger bank into turns
//   __pfLean.p.pitchAxis = "x"   // flip if the torso bends the wrong way
//   __pfLean.enabled = false     // kill it

import * as THREE from "three";

const find = (bones, res) => { for (const re of res) for (const k in bones) if (re.test(k)) return bones[k]; return null; };

export class TrajectoryLean {
  /**
   * @param {Object<string,THREE.Bone>} bones  name->bone map from loadCharacter
   * @param {()=>({velocity:THREE.Vector3})|null} bodyRef  returns the CharacterBody (has .velocity)
   */
  constructor(bones, bodyRef) {
    this.bodyRef = bodyRef;
    // spread the lean across the spine chain for a natural curve (more up top)
    this.chain = [
      { bone: find(bones, [/spine2/i, /chest/i]), share: 0.55 },
      { bone: find(bones, [/spine1/i]), share: 0.30 },
      { bone: find(bones, [/^spine$/i, /spine\b/i, /pelvis/i, /hips/i]), share: 0.15 },
    ].filter((s) => s.bone);
    if (!this.chain.length) { const s = find(bones, [/spine/i]); if (s) this.chain = [{ bone: s, share: 1 }]; }

    this.enabled = true;
    this.velPrev = new THREE.Vector3();
    this.accel = new THREE.Vector3();          // smoothed world accel (xz)
    this.heading = new THREE.Vector3(0, 0, 1); // last known travel direction
    this.lean = { pitch: 0, roll: 0 };         // smoothed applied lean (rad)
    this._v = new THREE.Vector3(); this._raw = new THREE.Vector3();
    this.p = {
      fwdGain: 0.012,   // rad per (m/s²) of along-heading accel  (start/stop lean)
      sideGain: 0.012,  // rad per (m/s²) of lateral accel        (bank into turns)
      max: 0.32,        // clamp each lean channel (rad)
      pitchAxis: "x",   // proven: Spine2.x pitches the torso fwd/back
      rollAxis: "z",    // bank axis — UNPROVEN, confirm live (may need "y")
      accelSmooth: 9,   // accel low-pass (higher = snappier)
      blend: 11,        // applied-lean low-pass (higher = snappier)
    };
    if (typeof window !== "undefined") window.__pfLean = this;
  }

  update(dt) {
    if (!this.enabled || !this.chain.length || dt <= 0) return;
    const body = this.bodyRef && this.bodyRef();
    if (!body || !body.velocity) return;
    const p = this.p;

    // smoothed horizontal acceleration = d(velocity)/dt, low-passed
    this._v.set(body.velocity.x, 0, body.velocity.z);
    this._raw.copy(this._v).sub(this.velPrev).multiplyScalar(1 / dt);
    const ka = 1 - Math.exp(-p.accelSmooth * dt);
    this.accel.lerp(this._raw, ka);
    this.velPrev.copy(this._v);

    // heading = travel direction (only trust it while actually moving)
    const spd = Math.hypot(this._v.x, this._v.z);
    if (spd > 0.4) this.heading.set(this._v.x / spd, 0, this._v.z / spd);
    const hx = this.heading.x, hz = this.heading.z;
    const rx = hz, rz = -hx;                          // right = heading rotated -90°

    const fwdA = this.accel.x * hx + this.accel.z * hz;   // along heading (+ speeding up)
    const sideA = this.accel.x * rx + this.accel.z * rz;  // lateral (+ turning right)
    const clamp = (v) => Math.max(-p.max, Math.min(p.max, v));
    const tPitch = clamp(fwdA * p.fwdGain);
    const tRoll = clamp(-sideA * p.sideGain);   // bank INTO the turn (Erik: was mirrored)

    // low-pass the applied lean so it eases in and settles (no snap)
    const kl = 1 - Math.exp(-p.blend * dt);
    this.lean.pitch += (tPitch - this.lean.pitch) * kl;
    this.lean.roll += (tRoll - this.lean.roll) * kl;
    if (!isFinite(this.lean.pitch)) this.lean.pitch = 0;
    if (!isFinite(this.lean.roll)) this.lean.roll = 0;

    // ADD onto the clip pose across the spine chain (mixer wrote absolute rot this frame)
    for (const s of this.chain) {
      s.bone.rotation[p.pitchAxis] += this.lean.pitch * s.share;
      s.bone.rotation[p.rollAxis] += this.lean.roll * s.share;
    }
  }

  /** which spine bones resolved + their shares (wiring sanity) */
  found() { return this.chain.map((s) => ({ bone: s.bone?.name, share: s.share })); }
}

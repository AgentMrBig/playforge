// PlayForge MOTION RECORDER — Erik (2026-07-20): "we have capture active, we run and jump
// and land, then depress capture moment. Now we can rewind that moment, slow motion, and
// by scrubbing + tweaking with our tools + capturing poses, create that spinning jump kick."
//
// Owned by General (character lane). A rolling buffer continuously holds the last ~15s of
// the character's motion (every bone's rotation + the root's world position, per frame).
// captureLast() freezes the tail into an editable MOMENT; start/stopRec() takes a deliberate
// longer take. A moment is time-indexed, so Anima can scrub / slow-mo / frame-step it and
// slerp the pose smoothly between recorded frames — then pose-edit any frame into a behavior.
// The root path is kept (root motion) so travelling moves reproduce their real displacement.

import * as THREE from "three";

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class MotionRecorder {
  /** @param {THREE.Object3D} playerObj character root @param {object} player entity (world pos) */
  constructor(playerObj, player, { maxFrames = 1000 } = {}) {
    this.playerObj = playerObj; this.player = player;
    this.maxFrames = maxFrames;
    this.buf = [];              // rolling window: [{ t, q:Float32Array(n*4), rp:[x,y,z] }]
    this.t = 0;
    this.recording = false;     // explicit start/stop take
    this._explicit = null;
    this._bones = null;
    if (typeof window !== "undefined") window.__pfRec = this;
  }

  bones() {
    if (!this._bones) { this._bones = []; this.playerObj.traverse((o) => { if (o.isBone) this._bones.push(o); }); }
    return this._bones;
  }

  _snap() {
    const B = this.bones(), q = new Float32Array(B.length * 4);
    for (let i = 0; i < B.length; i++) { const b = B[i].quaternion; q[i * 4] = b.x; q[i * 4 + 1] = b.y; q[i * 4 + 2] = b.z; q[i * 4 + 3] = b.w; }
    const p = this.player.position;
    return { t: this.t, q, rp: [p.x, p.y, p.z] };
  }

  /** per frame — always sampling, so a moment is ready the instant you ask for it */
  update(dt) {
    if (!(dt > 0)) return;
    this.t += dt;
    const f = this._snap();
    this.buf.push(f);
    if (this.buf.length > this.maxFrames) this.buf.shift();
    if (this.recording) this._explicit.push(f);
  }

  startRec() { this.recording = true; this._explicit = []; }
  stopRec() { this.recording = false; return this._finalize(this._explicit); }

  /** freeze the last `seconds` of the rolling buffer into an editable moment */
  captureLast(seconds = 12) {
    const cutoff = this.t - seconds;
    return this._finalize(this.buf.filter((f) => f.t >= cutoff));
  }

  _finalize(frames) {
    if (!frames || frames.length < 2) return null;
    const t0 = frames[0].t;
    return {
      n: this.bones().length,
      dur: +(frames[frames.length - 1].t - t0).toFixed(3),
      frames: frames.map((f) => ({ t: +(f.t - t0).toFixed(3), q: Array.from(f.q), rp: f.rp.slice() })),
    };
  }

  /** set the skeleton to the moment's pose at time t (slerped between recorded frames) */
  applyAtTime(moment, t) {
    const F = moment.frames; if (!F || !F.length) return;
    t = Math.max(0, Math.min(moment.dur, t));
    let i = 0; while (i < F.length - 1 && F[i + 1].t <= t) i++;
    const a = F[i], b = F[Math.min(F.length - 1, i + 1)];
    const span = (b.t - a.t) || 1, u = Math.max(0, Math.min(1, (t - a.t) / span));
    const B = this.bones();
    for (let k = 0; k < B.length && k < moment.n; k++) {
      _qa.set(a.q[k * 4], a.q[k * 4 + 1], a.q[k * 4 + 2], a.q[k * 4 + 3]);
      _qb.set(b.q[k * 4], b.q[k * 4 + 1], b.q[k * 4 + 2], b.q[k * 4 + 3]);
      B[k].quaternion.copy(_qa).slerp(_qb, u);
    }
  }

  /** the root world position at time t (for root motion / travelling moves) */
  rootAtTime(moment, t) {
    const F = moment.frames; if (!F || !F.length) return null;
    t = Math.max(0, Math.min(moment.dur, t));
    let i = 0; while (i < F.length - 1 && F[i + 1].t <= t) i++;
    const a = F[i], b = F[Math.min(F.length - 1, i + 1)];
    const span = (b.t - a.t) || 1, u = Math.max(0, Math.min(1, (t - a.t) / span));
    return [a.rp[0] + (b.rp[0] - a.rp[0]) * u, a.rp[1] + (b.rp[1] - a.rp[1]) * u, a.rp[2] + (b.rp[2] - a.rp[2]) * u];
  }

  save(name, moment) { try { localStorage.setItem(`pf.moment.${name}`, JSON.stringify(moment)); } catch {} }
  load(name) { try { return JSON.parse(localStorage.getItem(`pf.moment.${name}`) || "null"); } catch { return null; } }
  del(name) { try { localStorage.removeItem(`pf.moment.${name}`); } catch {} }
  list() { const o = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("pf.moment.")) o.push(k.slice(10)); } } catch {} return o.sort(); }
}

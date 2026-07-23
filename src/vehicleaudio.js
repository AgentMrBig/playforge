import { EngineSound } from "./enginesound.js";

/**
 * VehicleAudio — sandbox audio for the proving-ground car. Owns the AudioContext,
 * reuses the game's procedural EngineSound (gearbox → firing-frequency oscillator
 * stack + roughness + crackle), and adds a slip-driven TYRE SQUEAL bus. Adapts the
 * carphysics Car to the { entity: { components: [body] } } shape EngineSound reads.
 *
 *   const audio = new VehicleAudio({ hp: 450 });
 *   audio.start();               // on the first user gesture (autoplay policy)
 *   audio.update(dt, car);       // each frame
 */
export class VehicleAudio {
  constructor({ hp = 450 } = {}) {
    this.ctx = null;
    this.hp = hp;
    this.engine = null;
    // reused adapter object EngineSound reads from (no per-frame allocation)
    this._body = { speed: 0, throttle: 0, topSpeed: 50, wheelspin: false, handbrake: false };  // ~180 km/h — gears spread the real range
  }

  /** create + resume the context (must be called from a user gesture) */
  start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.engine = new EngineSound(this, { hp: this.hp });
      this.engine.start();
      this._buildScreech();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  _buildScreech() {
    const ctx = this.ctx;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    this.screechGain.connect(ctx.destination);
    this.screechHp = ctx.createBiquadFilter();
    this.screechHp.type = "highpass"; this.screechHp.frequency.value = 900;
    this.screechBp = ctx.createBiquadFilter();
    this.screechBp.type = "bandpass"; this.screechBp.frequency.value = 1800; this.screechBp.Q.value = 6;
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.screechSrc = ctx.createBufferSource();
    this.screechSrc.buffer = buf; this.screechSrc.loop = true;
    this.screechSrc.connect(this.screechHp);
    this.screechHp.connect(this.screechBp);
    this.screechBp.connect(this.screechGain);
    this.screechSrc.start();
  }

  update(dt, car) {
    if (!this.ctx) return;
    // adapt the car to EngineSound's expected body shape
    const b = this._body;
    b.speed = (car.speedKmh || 0) / 3.6;                 // m/s
    b.throttle = car.throttle || 0;
    b.wheelspin = (car.driveSpin || 0) > 6;              // ACTUAL wheelspin flares the revs
    // only a genuine locked-rear drift drags the engine — a line-lock burnout revs free
    b.handbrake = !!car.handbrake && !car.burnout;
    this.engine.update(dt, { entity: { components: [b] } });

    // suspension clunk on hard bumps (kerbs, landings, potholes)
    if (car.bumpPulse > 0) { this._thud(Math.min(1, car.bumpPulse)); car.bumpPulse = 0; }

    // exhaust backfire: lift off suddenly at high revs → 1-3 sharp pops
    const th = Math.max(0, car.throttle || 0);
    if ((this._prevTh || 0) > 0.65 && th < 0.15 && this.engine && this.engine.rpm > this.engine.redline * 0.45) {
      const pops = 1 + Math.floor(Math.random() * 3);
      let t = 0;
      for (let i = 0; i < pops; i++) {
        this._pop(t);
        if (this.onPop) this.onPop(t);      // visual flame, synced to each bang
        t += 0.07 + Math.random() * 0.18;
      }
    }
    this._prevTh = th;

    // tyre squeal: volume from slide×force, pitch from slide speed (Erik: force-driven)
    const sc = Math.max(0, Math.min(1, car.screech || 0));
    const pitch = Math.max(0, Math.min(1, car.screechPitch || 0));
    const now = this.ctx.currentTime;
    this.screechGain.gain.setTargetAtTime(sc * (0.22 + 0.4 * pitch), now, 0.04);   // louder under more force
    this.screechBp.frequency.setTargetAtTime(1400 + pitch * 2600, now, 0.05);       // higher as it slides faster
    this.screechHp.frequency.setTargetAtTime(700 + pitch * 900, now, 0.06);
    this.screechBp.Q.setTargetAtTime(5 + pitch * 4, now, 0.06);                      // tighter/whinier at speed
  }

  /** one-shot exhaust POP: a sharp lowpassed noise bang, randomized pitch/volume */
  _pop(delay = 0) {
    const ctx = this.ctx, t0 = ctx.currentTime + delay;
    const n = ctx.createBufferSource();
    n.buffer = this.screechSrc.buffer;             // reuse the noise buffer
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 450 + Math.random() * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t0);
    g.gain.exponentialRampToValueAtTime(0.45 + Math.random() * 0.35, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07 + Math.random() * 0.06);
    n.connect(lp); lp.connect(g); g.connect(ctx.destination);
    n.start(t0, Math.random() * 1.5); n.stop(t0 + 0.2);
  }

  /** one-shot procedural suspension clunk: low sine thump + a metallic noise tick */
  _thud(mag) {
    const ctx = this.ctx, now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.exponentialRampToValueAtTime(0.45 * mag + 0.05, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(100 + 50 * mag, now);
    o.frequency.exponentialRampToValueAtTime(42, now + 0.12);
    o.connect(g); o.start(now); o.stop(now + 0.16);
    const n = ctx.createBufferSource();
    n.buffer = this.screechSrc.buffer;             // reuse the noise buffer
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 900 + 600 * mag; bp.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.22 * mag, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    n.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
    n.start(now, Math.random() * 1.5); n.stop(now + 0.08);
  }

  /** VIOLENT one-shot crash (Erik: "a more violent sound when it hits hard") —
   *  sub-bass boom + distorted noise wall + ringing metal clangs, all scaled by
   *  severity k (0..1). Rate-limited so a grinding scrape can't machine-gun it. */
  crash(k) {
    if (!this.ctx || !this.screechSrc) return;    // audio not started yet (needs a user gesture)
    const ctx = this.ctx, now = ctx.currentTime;
    if (this._crashT && now - this._crashT < 0.2) return;
    this._crashT = now;
    k = Math.max(0.15, Math.min(1, k));
    // ---- master bus with a hard clipper for that overdriven slam ----
    const sh = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * (1.5 + 2.5 * k)); }
    sh.curve = curve;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.5 + 0.45 * k, now);
    sh.connect(master); master.connect(ctx.destination);
    // ---- layer 1: sub-bass BOOM (the body slam you feel) ----
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(60 + 25 * k, now);
    o.frequency.exponentialRampToValueAtTime(24, now + 0.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.001, now);
    og.gain.exponentialRampToValueAtTime(0.9 * k, now + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    o.connect(og); og.connect(sh); o.start(now); o.stop(now + 0.6);
    // ---- layer 2: crushing noise WALL (sheet metal folding) ----
    const n = ctx.createBufferSource();
    n.buffer = this.screechSrc.buffer;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(3800 + 2000 * k, now);
    lp.frequency.exponentialRampToValueAtTime(160, now + 0.55);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.85 * k, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    n.connect(lp); lp.connect(ng); ng.connect(sh);
    n.start(now, Math.random() * 1.2); n.stop(now + 0.65);
    // ---- layer 3: ringing metal CLANGS (parts banging around after) ----
    const clangs = 2 + Math.floor(k * 3);
    for (let i = 0; i < clangs; i++) {
      const t0 = now + Math.random() * 0.22 * (i / clangs + 0.2);
      const c = ctx.createBufferSource();
      c.buffer = this.screechSrc.buffer;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
      bp.frequency.value = 380 + Math.random() * 2200; bp.Q.value = 9 + Math.random() * 7;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.28 * k, t0);
      cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2 + Math.random() * 0.25);
      c.connect(bp); bp.connect(cg); cg.connect(sh);
      c.start(t0, Math.random() * 1.5); c.stop(t0 + 0.5);
    }
  }

  get rpm() { return this.engine ? this.engine.rpm : 0; }
}

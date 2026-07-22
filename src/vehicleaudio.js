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
    this._body = { speed: 0, throttle: 0, topSpeed: 24, wheelspin: false, handbrake: false };
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
    b.wheelspin = car.throttle > 0.6 && (car.speedKmh || 0) < 26;   // burnout → revs flare
    b.handbrake = !!car.handbrake;
    this.engine.update(dt, { entity: { components: [b] } });

    // tyre squeal from the car's real slip signal
    const sc = Math.max(0, Math.min(1, car.screech || 0));
    const now = this.ctx.currentTime;
    this.screechGain.gain.setTargetAtTime(sc * 0.35, now, 0.04);
    this.screechBp.frequency.setTargetAtTime(1500 + sc * 1400, now, 0.06);
  }

  get rpm() { return this.engine ? this.engine.rpm : 0; }
}

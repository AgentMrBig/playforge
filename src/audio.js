/**
 * Audio — WebAudio with zero assets: the synth-SFX approach proven across
 * four shipped games. Named recipes, one call to play.
 *
 *   const audio = new Audio();
 *   audio.play("pickup");            // built-in recipe
 *   audio.define("laser", { type: "square", from: 900, to: 200, dur: 0.12, vol: 0.3 });
 *   audio.music("bg.mp3", { volume: 0.35 });   // looping file track (optional)
 *
 * Context unlocks automatically on first user gesture.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.recipes = new Map(Object.entries({
      pickup: { type: "sine", from: 340, to: 1200, dur: 0.09, vol: 0.4 },
      jump:   { type: "sine", from: 260, to: 520, dur: 0.12, vol: 0.3 },
      hit:    { type: "square", from: 220, to: 60, dur: 0.15, vol: 0.35, noise: 0.4 },
      die:    { type: "sawtooth", from: 300, to: 40, dur: 0.5, vol: 0.4 },
      click:  { type: "square", from: 850, to: 850, dur: 0.04, vol: 0.25 },
      win:    { type: "sine", from: 520, to: 1040, dur: 0.35, vol: 0.4 },
      crash:    { type: "triangle", from: 130, to: 28, dur: 0.42, vol: 0.5, noise: 0.9 },
      crashBig: { type: "triangle", from: 90, to: 22, dur: 0.85, vol: 0.65, noise: 1.25 },
    }));
    this._music = null;
    const unlock = () => {
      this._ensure();
      if (this.ctx.state === "suspended") this.ctx.resume();
      if (this._music?.paused) this._music.play().catch(() => {});
    };
    for (const ev of ["pointerdown", "keydown", "touchstart"])
      window.addEventListener(ev, unlock, { once: false });
  }

  _ensure() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }

  define(name, recipe) { this.recipes.set(name, recipe); }

  play(name, { pitch = 1, volume = 1 } = {}) {
    const r = this.recipes.get(name);
    if (!r) return;
    this._ensure();
    const ctx = this.ctx, t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime((r.vol ?? 0.3) * volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + r.dur);
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = r.type ?? "sine";
    osc.frequency.setValueAtTime(r.from * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, r.to * pitch), t + r.dur);
    osc.connect(gain);
    osc.start(t); osc.stop(t + r.dur);

    if (r.noise) {
      const len = Math.floor(ctx.sampleRate * r.dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const ng = ctx.createGain();
      ng.gain.value = r.noise * (r.vol ?? 0.3) * volume;
      src.connect(ng).connect(ctx.destination);
      src.start(t);
    }
  }

  /** looping background music from a file URL */
  music(url, { volume = 0.35 } = {}) {
    if (this._music) this._music.pause();
    this._music = new window.Audio(url);
    this._music.loop = true;
    this._music.volume = volume;
    this._music.play().catch(() => {}); // will start on first gesture via unlock
  }
  stopMusic() { this._music?.pause(); this._music = null; }
}

/**
 * EngineSound — engine audio simulation driven by the vehicle's real specs.
 *
 *   car.add(new EngineSound(audio, { hp: 450, cylinders: 8 }));
 *
 * The sound is SIMULATED, not sampled:
 *  - a 5-speed gearbox turns body.speed into RPM (climb, shift dip, climb...)
 *  - the fundamental is the cylinder firing frequency: rpm/60 · cyl/2
 *  - horsepower sets the "meanness" curve:
 *      ~100 hp  → polite sine-ish hum, soft filter
 *      ~450 hp  → saw+sub stack, mild waveshaper growl
 *      ~800 hp  → hot distortion, wide detune, exhaust noise
 *      10000 hp → top fuel: full drive, sub-bass thump, misfire crackle —
 *                 all hell breaks loose, as requested
 *  - throttle opens a lowpass + swells gain (lift-off = burble down)
 *
 * Reads any component with `speed`/`kmh`/`throttle` (VehicleBody works as-is).
 */
export class EngineSound {
  constructor(audio, {
    hp = 200,
    cylinders = hp > 3000 ? 8 : hp > 350 ? 8 : hp > 180 ? 6 : 4,
    redline = hp > 3000 ? 8400 : 6800,
    idleRpm = hp > 3000 ? 1400 : 850,
    gears = 5,
    volume = 1,
  } = {}) {
    this.audio = audio;
    Object.assign(this, { hp, cylinders, redline, idleRpm, gears, volume });
    // meanness 0..1: log curve so 100→0.18, 450→0.45, 800→0.55, 10000→1.0
    this.mean = Math.min(1, Math.log10(hp / 40) / Math.log10(250));
    this.rpm = idleRpm;
    this._gear = 0;
    this._shiftT = 0;
    this._nodes = null;
    this._crackleT = 0;
    this.running = false;
  }

  start() { this.running = true; }
  stop() {
    this.running = false;
    if (this._nodes) { try { for (const o of this._nodes.oscs) o.stop(); } catch {} this._nodes = null; }
  }
  dispose() { this.stop(); }

  _build() {
    const ctx = this.audio.ctx;
    const master = ctx.createGain();
    master.gain.value = 0;

    // distortion: drive curve scales with meanness
    const shaper = ctx.createWaveShaper();
    const drive = 2 + this.mean * 48;
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive * 0.6);
    }
    shaper.curve = curve;

    // two cascaded lowpasses = 24 dB/oct — keeps the top end from whining
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 400;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = "lowpass";
    lp2.frequency.value = 600;

    // oscillator stack: fundamental + sub + harmonics (meaner = more of them)
    const oscs = [], oscGains = [];
    // baseGain + rpmFade: how much of the voice survives at redline.
    // Upper harmonics FADE with rpm (that was the whine); sub and noise grow.
    const spec = [
      { type: "sawtooth", mult: 1, gain: 0.45, rpmFade: 0.35 },
      { type: "square", mult: 0.5, gain: 0.4 + this.mean * 0.3, rpmFade: 0 },   // sub growl: stays
      { type: "sawtooth", mult: 2, gain: 0.08 + this.mean * 0.22, detune: 9, rpmFade: 0.75 },
      { type: "sawtooth", mult: 3, gain: this.mean * 0.15, detune: -13, rpmFade: 0.9 },
      { type: "square", mult: 0.25, gain: Math.max(0, this.mean - 0.55) * 0.9, rpmFade: 0 }, // top-fuel thump
    ];
    for (const s of spec) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = s.type;
      if (s.detune) o.detune.value = s.detune;
      g.gain.value = s.gain;
      o.connect(g).connect(shaper);
      o.start();
      oscs.push(o); oscGains.push(g);
      o._mult = s.mult;
      g._base = s.gain;
      g._rpmFade = s.rpmFade;
    }

    // exhaust noise: looping noise buffer through an rpm-tracking bandpass
    const nLen = ctx.sampleRate;
    const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nd = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nBuf; noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 1.2;
    const nGain = ctx.createGain();
    nGain.gain.value = 0.04 + this.mean * 0.3;
    noise.connect(bp).connect(nGain).connect(shaper);
    noise.start();
    oscs.push(noise);

    // crackle: a gain we spike for misfire pops (top-fuel and lift-off burble)
    const crackle = ctx.createGain();
    crackle.gain.value = 0;
    bp.connect(crackle).connect(master);

    shaper.connect(lp).connect(lp2).connect(master);
    master.connect(ctx.destination);
    this._nodes = { master, shaper, lp, lp2, oscs, oscGains, bp, crackle, nGain };
  }

  update(dt, { entity }) {
    if (!this.audio.ctx) return;                 // waits for the unlock gesture
    if (!this._nodes && this.running) this._build();
    if (!this._nodes) return;
    const n = this._nodes;
    const body = entity.components.find((c) => c.speed !== undefined && c.throttle !== undefined);
    if (!body || !this.running) { n.master.gain.value *= 0.9; return; }

    // ---- gearbox: speed → gear → rpm --------------------------------------
    const topSpeed = body.topSpeed ?? 38;
    const s = Math.abs(body.speed);
    const band = topSpeed / this.gears;
    const gear = Math.min(this.gears - 1, Math.floor(s / band));
    if (gear !== this._gear) { this._shiftT = 0.14; this._gear = gear; }
    this._shiftT = Math.max(0, this._shiftT - dt);
    let inGear = (s - gear * band) / band;        // 0..1 within the gear
    let rpmN = 0.12 + inGear * 0.88;
    if (this._shiftT > 0) rpmN *= 0.62;           // clutch dip on the shift
    const idleN = this.idleRpm / this.redline;
    const wantRpm = this.redline * Math.max(idleN, rpmN * Math.max(0.35, Math.abs(body.throttle)) + (1 - Math.abs(body.throttle)) * rpmN * 0.8);
    this.rpm += (wantRpm - this.rpm) * (1 - Math.exp(-dt * 8));

    // ---- firing frequency drives the stack (one octave down: warm, not
    // whiney — pitch still tracks rpm, just in a listenable register) -------
    const revN = this.rpm / this.redline;
    const fire = (this.rpm / 60) * (this.cylinders / 2) * 0.5;
    for (let i = 0; i < n.oscs.length; i++) {
      const o = n.oscs[i];
      if (!o._mult) continue;
      o.frequency.value = fire * o._mult;
      const g = n.oscGains[i];
      if (g?._base !== undefined)          // upper harmonics fade as revs rise
        g.gain.value = g._base * (1 - g._rpmFade * revN);
    }
    n.bp.frequency.value = 140 + fire * 1.6;
    // roar takes over from tone at high rpm — loud but not piercing
    n.nGain.gain.value = (0.05 + this.mean * 0.28) * (0.45 + 0.9 * revN);

    // ---- throttle: loudness + a MUCH tamer brightness curve ---------------
    const t = Math.abs(body.throttle);
    const load = 0.25 + t * 0.75;
    const cutoff = 240 + this.mean * 420 + t * 520 + revN * 260;   // caps ~1.4k
    n.lp.frequency.value = cutoff;
    n.lp2.frequency.value = cutoff * 1.6;
    const vol = (0.05 + 0.1 * this.mean) * load * this.volume * (0.65 + 0.35 * revN);
    n.master.gain.value += (vol - n.master.gain.value) * (1 - Math.exp(-dt * 10));

    // ---- misfire crackle: top-fuel idle/lift-off chaos --------------------
    this._crackleT -= dt;
    const crackleP = this.mean > 0.6
      ? (t < 0.2 ? 18 : 7) * (this.mean - 0.55)   // meaner = poppier
      : (t < 0.15 && this.rpm > this.redline * 0.4 ? 2.2 : 0); // burble on lift-off
    if (this._crackleT <= 0 && Math.random() < crackleP * dt) {
      const ctx = this.audio.ctx, now = ctx.currentTime;
      n.crackle.gain.cancelScheduledValues(now);
      n.crackle.gain.setValueAtTime(0.5 + this.mean * 0.8, now);
      n.crackle.gain.exponentialRampToValueAtTime(0.001, now + 0.04 + Math.random() * 0.05);
      this._crackleT = 0.03;
    }
  }
}

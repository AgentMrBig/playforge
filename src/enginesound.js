/**
 * EngineSound — procedural engine audio driven by the vehicle's real specs.
 *
 *   car.add(new EngineSound(audio, { hp: 450, cylinders: 8 }));
 *
 * The sound is SIMULATED, not sampled. This is a proper ADDITIVE ENGINE-ORDER
 * synth (the technique used for good procedural car sound), not a single sawtooth:
 *
 *  - a 5-speed gearbox turns body.speed into RPM (climb, shift dip, climb...)
 *  - the crankshaft rotation frequency is  f0 = rpm/60  (Hz)
 *  - the engine is voiced as a stack of ENGINE ORDERS (sine partials at
 *    multiples of f0). The dominant order is the FIRING order = cylinders/2
 *    (4th order for a V8). Crucially we also put energy on the HALF orders
 *    (0.5, 1.5, 2.5 ...): a cross-plane V8 fires its two banks at uneven
 *    90/180 intervals, and that unevenness is exactly what puts energy on the
 *    half-orders — it is the physical origin of the muscle-car "potato-potato"
 *    rumble/lope. A single saw can't do that; a weighted order stack can.
 *  - each order gets a tiny fixed detune + a slow independent random drift so
 *    the partials never phase-lock into a sterile buzz (the "80s computer" tell)
 *  - the summed orders pass through a tanh WAVESHAPER (combustion growl +
 *    intermodulation) and then a bank of FIXED-frequency FORMANT peaks (the
 *    exhaust/airbox/cabin resonances). Because the formants are fixed while the
 *    pitch sweeps, the timbre "opens a vowel" as revs rise — the realistic bit.
 *  - LOAD (throttle) opens the top orders + intake peak + waveshaper drive
 *    (engine "comes on song"); lift-off closes them and adds overrun burble.
 *  - horsepower sets the "meanness" curve (how bright/distorted/noisy it gets).
 *  - the existing backfire pops are still driven by VehicleAudio via onPop.
 *
 * Reads any component with `speed`/`kmh`/`throttle` (VehicleBody works as-is).
 *
 * ── TUNING ──────────────────────────────────────────────────────────────────
 * Live-tunable at runtime via window.__pfEngineSound.tune (rebuild not needed —
 * values are read every frame). Key dials:
 *   tune.pitchScale   overall register of the whole engine (0.72 ≈ Erik's pref)
 *   tune.growl        waveshaper drive amount (0 clean … 1 default … 2 nasty)
 *   tune.rasp         gain of the high (bark) orders under load
 *   tune.rumble       gain of the low + half orders (the V8 lope/thump)
 *   tune.noise        exhaust roar (broadband) level
 *   tune.volume       final master trim
 * Also  .roughness  (URL ?rough=) drives the irregular idle lope.
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

    // combustion ROUGHNESS (Ember 2026-07-20, Erik: "still sounds like the cars
    // are powered by an 80s computer"). The #1 synthetic tell is perfect
    // periodicity — a real engine's firing is irregular (idle LOPE, roughest at
    // low load, smoothing out under power). This drives a smoothed random wobble
    // on the firing frequency + amplitude flutter. Tunable live:
    // window.__pfEngineSound.roughness (0 = old sterile tone, 1 = default, 2 = lumpy).
    this.roughness = (typeof location !== "undefined" && /(?:\?|&)rough=([\d.]+)/.exec(location.search)) ? +RegExp.$1 : 1;
    this._lope = 0;

    // ── live-tunable synthesis dials (read every frame in update) ────────────
    this.tune = {
      pitchScale: 0.72,  // register of the whole order stack (Erik heard best ~0.72)
      growl: 1.0,        // waveshaper drive scaler
      rasp: 1.0,         // high-order (bark/rasp) gain scaler
      rumble: 1.0,       // low + half-order (lope/thump) gain scaler
      noise: 1.0,        // exhaust broadband roar scaler
      volume: 1.0,       // final master trim
      formant: 1.0,      // exhaust formant emphasis scaler
    };

    // ── ENGINE ORDER TABLE ───────────────────────────────────────────────────
    // Each partial is a sine at (order × f0). Weighted for a cross-plane V8:
    //   firing order = cylinders/2 (4 for a V8) is the loudest; strong half
    //   orders below it give the lope; a few high orders give exhaust rasp.
    // Fields: [order, baseGain, loadBright, rpmFade, detuneCents, band]
    //   loadBright  how much throttle opens this partial (upper orders open most)
    //   rpmFade     how much it fades toward redline (kills top-end whine),
    //               but load halves the fade so it can still scream under power
    //   band        "lo" = scaled by tune.rumble, "hi" = scaled by tune.rasp
    const fire = Math.max(2, this.cylinders / 2);   // firing order (4 for a V8)
    this._orderSpec = [
      // deep sub + half orders: the potato-potato lope / chest rumble
      [fire * 0.125, 0.16, 0.15, 0.05, -7, "lo"],  // 0.5-order (deep cross-plane sub)
      [fire * 0.25,  0.30, 0.25, 0.12,  5, "lo"],  // 1st order (crank rotation)
      [fire * 0.375, 0.20, 0.40, 0.18, -6, "lo"],  // 1.5-order (signature burble)
      [fire * 0.5,   0.42, 0.35, 0.14,  4, "lo"],  // 2nd order (fat low body)
      [fire * 0.625, 0.14, 0.55, 0.28,  8, "lo"],  // 2.5-order
      [fire * 0.75,  0.26, 0.55, 0.28, -5, "lo"],  // 3rd order
      // firing frequency + its harmonics: the "note" + exhaust rasp
      [fire * 1.0,   0.85, 0.65, 0.22,  3, "mid"], // FIRING FREQUENCY (dominant)
      [fire * 1.25,  0.18, 0.85, 0.45,  6, "hi"],  // 5th order
      [fire * 1.5,   0.30, 0.95, 0.45, -4, "hi"],  // firing×1.5 rasp
      [fire * 2.0,   0.32, 1.20, 0.55,  5, "hi"],  // 2× firing (exhaust bark)
      [fire * 2.5,   0.14, 1.50, 0.70,  7, "hi"],  // bright top (load only)
      [fire * 3.0,   0.16, 1.70, 0.78, -6, "hi"],  // brightest (load only)
    ];

    if (typeof window !== "undefined") window.__pfEngineSound = this;
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

    // ── sum bus: all the sine orders + the noise roar mix here first ─────────
    const sum = ctx.createGain();
    sum.gain.value = 0.5;   // headroom before the waveshaper

    // ── combustion growl: tanh waveshaper adds harmonics + intermodulation
    //    between the summed orders (a pure order sum alone is too "clean") ────
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._makeDriveCurve(2 + this.mean * 40);
    shaper._drive = 2 + this.mean * 40;
    sum.connect(shaper);

    // ── two cascaded lowpasses (24 dB/oct) tame the very top under load ──────
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 500; lp.Q.value = 0.6;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = "lowpass"; lp2.frequency.value = 800; lp2.Q.value = 0.6;
    shaper.connect(lp).connect(lp2);

    // ── EXHAUST FORMANTS: fixed-frequency peaks = the exhaust/airbox/cabin
    //    resonances. They stay put while the pitch sweeps, so the timbre opens
    //    a "vowel" as revs climb — this is what makes it read as a real pipe. ─
    const f1 = ctx.createBiquadFilter(); // chest thump / drone
    f1.type = "peaking"; f1.frequency.value = 90;  f1.Q.value = 1.1; f1.gain.value = 8;
    const f2 = ctx.createBiquadFilter(); // low body
    f2.type = "peaking"; f2.frequency.value = 200; f2.Q.value = 1.3; f2.gain.value = 5;
    const f3 = ctx.createBiquadFilter(); // rasp / body
    f3.type = "peaking"; f3.frequency.value = 520; f3.Q.value = 1.5; f3.gain.value = 4;
    // intake honk: opens with throttle (engine "sucking air" under load)
    const intake = ctx.createBiquadFilter();
    intake.type = "peaking"; intake.frequency.value = 800; intake.Q.value = 1.8; intake.gain.value = 0;
    lp2.connect(f1).connect(f2).connect(f3).connect(intake).connect(master);
    master.connect(ctx.destination);

    // ── ENGINE-ORDER sine partials ───────────────────────────────────────────
    const oscs = [], oscGains = [], drift = [];
    for (const s of this._orderSpec) {
      const [order, gain, lb, rf, det, band] = s;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";                 // sines: no aliasing, cheap, clean stack
      o.detune.value = det;
      g.gain.value = 0;
      o.connect(g).connect(sum);
      o.start();
      oscs.push(o); oscGains.push(g); drift.push(0);
      o._order = order; o._det = det;
      g._base = gain; g._lb = lb; g._rf = rf; g._band = band;
    }

    // ── exhaust noise: looping noise through an rpm-tracking bandpass = the
    //    broadband roar/air that grows with revs and load ─────────────────────
    const nLen = ctx.sampleRate;
    const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nd = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nBuf; noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 1.1;
    const nGain = ctx.createGain();
    nGain.gain.value = 0.04;
    noise.connect(bp).connect(nGain).connect(sum);
    noise.start();
    oscs.push(noise);   // so stop() shuts it down too

    // ── crackle bus: spiked for misfire pops / lift-off burble ───────────────
    const crackle = ctx.createGain();
    crackle.gain.value = 0;
    bp.connect(crackle).connect(master);

    this._nodes = { master, sum, shaper, lp, lp2, f1, f2, f3, intake, oscs, oscGains, drift, bp, crackle, nGain };
  }

  _makeDriveCurve(drive) {
    const curve = new Float32Array(256);
    const norm = Math.tanh(drive * 0.6) || 1;
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
    return curve;
  }

  update(dt, { entity }) {
    if (!this.audio.ctx) return;                 // waits for the unlock gesture
    if (!this._nodes && this.running) this._build();
    if (!this._nodes) return;
    const n = this._nodes;
    const body = entity.components.find((c) => c.speed !== undefined && c.throttle !== undefined);
    if (!body || !this.running) { n.master.gain.value *= 0.9; return; }
    const T = this.tune;

    // ---- gearbox + engine state: RPM is SIMULATED, not a map of road speed.
    // The engine is clutched to the DRIVEN wheels — wheelspin revs it past
    // road speed, locked rears drag it down, and it carries its own inertia. ---
    const topSpeed = body.topSpeed ?? 38;
    const s = Math.abs(body.speed);
    const t0 = Math.abs(body.throttle);
    const band = topSpeed / this.gears;
    if (s > (this._gear + 1) * band * 1.02 && this._gear < this.gears - 1) { this._gear++; this._shiftT = 0.18; }
    else if (s < this._gear * band * 0.82 && this._gear > 0) { this._gear--; this._shiftT = 0.12; }
    this._shiftT = Math.max(0, this._shiftT - dt);
    const inGear = Math.min(1.15, Math.max(0, (s - this._gear * band) / band));
    let wheelRpmN = 0.3 + inGear * 0.7;
    if (body.wheelspin) wheelRpmN = Math.max(wheelRpmN, 0.93);   // burnout: revs flare free
    if (body.handbrake && s > 3) wheelRpmN *= 0.55;              // locked rears drag the clutch
    const idleN = this.idleRpm / this.redline;
    let wantN = Math.max(idleN, this._shiftT > 0 ? wheelRpmN * 0.62 : wheelRpmN);
    const curN = this.rpm / this.redline;
    const rate = wantN > curN ? (2.2 + 6 * t0) * (body.wheelspin ? 1.6 : 1) : 1.4;
    const step = Math.max(-rate * dt, Math.min(rate * dt, wantN - curN));
    this.rpm = (curN + step) * this.redline;

    // ---- LOAD: throttle "opens up" the engine timbre. Under a shift cut the
    // throttle is momentarily lifted (interrupter), which we treat as low load. -
    const revN = this.rpm / this.redline;
    const t = Math.abs(body.throttle);
    const load = Math.max(0, Math.min(1, (this._shiftT > 0 ? 0.15 : 0.2) + t * 0.8));

    // ---- combustion roughness: a smoothed random walk wobbles the firing
    // rate — real engines aren't perfectly periodic. Strongest at low load
    // (idle LOPE), smooths out under power (clean pull). ------------------------
    const lopeAmt = this.roughness * (0.55 + 0.45 * this.mean) * (1 - 0.72 * load);
    this._lope = this._lope * 0.86 + (Math.random() * 2 - 1) * 0.14;   // -1..1 smoothed
    const roughN = 1 + this._lope * 0.06 * lopeAmt;                    // ±~6% firing wobble at idle

    // ---- crankshaft rotation frequency drives EVERY order.  f0 = rpm/60.
    // pitchScale drops the whole stack into the warm register Erik liked. -------
    const f0 = (this.rpm / 60) * T.pitchScale * roughN;

    // per-frame slow detune drift keeps partials from phase-locking (anti-buzz)
    for (let i = 0; i < n.oscGains.length; i++) {
      const g = n.oscGains[i];
      const o = n.oscs[i];
      if (g._base === undefined) continue;
      // frequency = order × f0
      o.frequency.value = f0 * o._order;
      // slow random-walk detune, ±~10 cents, gentle (more alive at idle)
      n.drift[i] = n.drift[i] * 0.9 + (Math.random() * 2 - 1) * (0.6 + 4 * (1 - load));
      o.detune.value = o._det + n.drift[i];
      // gain: base × load-opening × rpm-fade (load halves the fade so it screams)
      const bandScale = g._band === "hi" ? T.rasp : g._band === "lo" ? T.rumble : 1;
      const fade = 1 - g._rf * revN * (1 - 0.5 * load);
      g.gain.value = g._base * bandScale * (1 + g._lb * load) * Math.max(0.05, fade);
    }

    // ---- exhaust broadband roar: tracks firing frequency, grows with revs+load
    const fireFreq = f0 * (this.cylinders / 2);
    n.bp.frequency.value = 140 + fireFreq * 1.4;
    n.nGain.gain.value = (0.04 + this.mean * 0.26) * (0.35 + 0.9 * revN) * (0.5 + 0.6 * load) * T.noise;

    // ---- formants drift only slightly with revs (mostly fixed = realistic).
    // The intake honk opens with load. ----------------------------------------
    n.f1.frequency.value = 88 + revN * 40;
    n.f1.gain.value = 8 * T.formant;
    n.f3.gain.value = (3 + 3 * load) * T.formant;               // rasp comes up on power
    n.intake.frequency.value = 650 + revN * 900;
    n.intake.gain.value = load * 6 * T.formant;                 // "sucking air" under throttle

    // ---- waveshaper drive rises with load + revs (engine snarls under power) --
    const wantDrive = (2 + this.mean * 40) * T.growl * (0.7 + 0.6 * load) * (0.85 + 0.3 * revN);
    if (Math.abs(wantDrive - n.shaper._drive) > 1.5) {          // rebuild curve only when it moves
      n.shaper.curve = this._makeDriveCurve(wantDrive);
      n.shaper._drive = wantDrive;
    }

    // ---- top lowpass: brightness follows load + revs, capped so it never whines
    const cutoff = 320 + this.mean * 380 + load * 900 + revN * 500;
    n.lp.frequency.value = cutoff;
    n.lp2.frequency.value = cutoff * 1.5;

    // ---- master gain: loud under load, quieter on overrun; amplitude flutter
    // pairs with the pitch wobble so the lope reads as a lumpy idle, not vibrato.
    const flutter = 1 + this._lope * 0.05 * lopeAmt;
    const vol = (0.06 + 0.1 * this.mean) * load * this.volume * T.volume * (0.6 + 0.4 * revN) * flutter;
    n.master.gain.value += (vol - n.master.gain.value) * (1 - Math.exp(-dt * 10));

    // ---- misfire crackle: overrun burble + top-fuel idle chaos ---------------
    this._crackleT -= dt;
    const crackleP = this.mean > 0.6
      ? (t < 0.2 ? 18 : 7) * (this.mean - 0.55)   // meaner = poppier
      : (t < 0.15 && this.rpm > this.redline * 0.4 ? 2.6 : 0); // burble on lift-off
    if (this._crackleT <= 0 && Math.random() < crackleP * dt) {
      const ctx = this.audio.ctx, now = ctx.currentTime;
      n.crackle.gain.cancelScheduledValues(now);
      n.crackle.gain.setValueAtTime(0.5 + this.mean * 0.8, now);
      n.crackle.gain.exponentialRampToValueAtTime(0.001, now + 0.04 + Math.random() * 0.05);
      this._crackleT = 0.03;
    }
  }
}

/**
 * EngineSound — procedural engine audio driven by the vehicle's real specs.
 *
 *   car.add(new EngineSound(audio, { preset: "muscle", hp: 450 }));
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
 *  - the existing backfire pops are still driven by VehicleAudio via onPop.
 *
 * ── ENGINE PRESETS (voicings) ────────────────────────────────────────────────
 * Different vehicles/tunes sound distinct via named presets. Each preset is a
 * full voicing: the engine-order weight table + all tunables + engine params.
 *   "normal"     calm smoother inline-4 daily driver
 *   "muscle"     burly cross-plane V8 (DEFAULT — do not regress)
 *   "alcohol"    wild methanol top-fuel/alcohol dragster
 *   "motorcycle" high-revving inline-4 sportbike
 * Select at construction  EngineSound({ preset: "alcohol" })  or at runtime
 * window.__pfEngineSound.setPreset("motorcycle"). VehicleAudio also honours a
 * ?engine=alcohol URL param on proving.html for easy A/B.
 *
 * ── LIVE TUNING ──────────────────────────────────────────────────────────────
 * window.__pfEngineSound.tune.{pitchScale,growl,rasp,rumble,noise,formant,
 * volume,crackle} are read every frame (no rebuild needed). setPreset() rebuilds
 * the order stack. .roughness drives the irregular idle lope.
 *
 * Reads any component with `speed`/`kmh`/`throttle` (VehicleBody works as-is).
 */

// ── PRESET TABLE ──────────────────────────────────────────────────────────────
// order rows: [order, baseGain, loadBright, rpmFade, detuneCents, band]
//   band  "lo" scaled by tune.rumble · "hi" scaled by tune.rasp · "mid" neither
//   loadBright  how much throttle opens this partial (upper orders open most)
//   rpmFade     fade toward redline (kills whine); load halves it so it screams
// tune: pitchScale (register) · growl (waveshaper drive) · rasp/rumble/noise/
//   formant (band + roar + resonance emphasis) · volume · crackle (idle pop rate)
// engine: cylinders/redline/idleRpm/roughness/formantShift/revRate, optional mean
export const ENGINE_PRESETS = {
  // 1) NORMAL — calm inline-4 daily driver: thin low end, little growl/crackle,
  //    even firing so almost no half-order lope, higher & brighter register.
  normal: {
    cylinders: 4, redline: 6200, idleRpm: 820, roughness: 0.5, mean: 0.24,
    formantShift: 1.12, revRate: 1.0,
    tune: { pitchScale: 0.9, growl: 0.35, rasp: 0.7, rumble: 0.5, noise: 0.6, formant: 0.7, volume: 0.9, crackle: 0, topEnd: 0.7 },
    orders: [
      [1.0, 0.14, 0.20, 0.15,  4, "lo"],   // crank rotation (subtle)
      [2.0, 0.55, 0.40, 0.18,  3, "mid"],  // FIRING (I4 = 2nd order) — dominant
      [3.0, 0.12, 0.50, 0.35, -4, "lo"],
      [4.0, 0.30, 0.70, 0.40,  5, "hi"],   // 2× firing
      [6.0, 0.16, 0.90, 0.55, -5, "hi"],
      [8.0, 0.10, 1.10, 0.70,  6, "hi"],
    ],
  },

  // 2) MUSCLE — burly cross-plane V8 (the default; mirrors what shipped and
  //    Erik approved). mean left undefined so it tracks hp (0.45 at 450 hp).
  muscle: {
    cylinders: 8, redline: 6800, idleRpm: 850, roughness: 1.0,
    formantShift: 1.0, revRate: 1.0,
    tune: { pitchScale: 0.72, growl: 1.0, rasp: 1.0, rumble: 1.0, noise: 1.0, formant: 1.0, volume: 1.0, crackle: 0, topEnd: 1.0 },
    orders: [
      [0.5,  0.16, 0.15, 0.05, -7, "lo"],  // deep cross-plane sub
      [1.0,  0.30, 0.25, 0.12,  5, "lo"],  // crank rotation
      [1.5,  0.20, 0.40, 0.18, -6, "lo"],  // signature half-order burble
      [2.0,  0.42, 0.35, 0.14,  4, "lo"],  // fat low body
      [2.5,  0.14, 0.55, 0.28,  8, "lo"],
      [3.0,  0.26, 0.55, 0.28, -5, "lo"],
      [4.0,  0.85, 0.65, 0.22,  3, "mid"], // FIRING FREQUENCY (dominant)
      [5.0,  0.18, 0.85, 0.45,  6, "hi"],
      [6.0,  0.30, 0.95, 0.45, -4, "hi"],  // firing×1.5 rasp
      [8.0,  0.32, 1.20, 0.55,  5, "hi"],  // 2× firing (exhaust bark)
      [10.0, 0.14, 1.50, 0.70,  7, "hi"],
      [12.0, 0.16, 1.70, 0.78, -6, "hi"],
    ],
  },

  // 3) ALCOHOL — methanol top-fuel/alcohol dragster: massive sub, violent lopey
  //    idle, hard crackle/pop, screaming top end. mean forced to max (nasty).
  alcohol: {
    cylinders: 8, redline: 8600, idleRpm: 1500, roughness: 2.1, mean: 1.0,
    formantShift: 0.85, revRate: 1.35,
    tune: { pitchScale: 0.68, growl: 1.9, rasp: 1.5, rumble: 1.6, noise: 1.4, formant: 1.2, volume: 1.1, crackle: 2.6, topEnd: 1.5 },
    orders: [
      [0.5,  0.30, 0.15, 0.03, -9, "lo"],  // huge sub thump
      [1.0,  0.45, 0.20, 0.08,  7, "lo"],
      [1.5,  0.35, 0.40, 0.15, -8, "lo"],  // brutal lope
      [2.0,  0.55, 0.35, 0.12,  5, "lo"],
      [2.5,  0.22, 0.55, 0.25,  9, "lo"],
      [3.0,  0.34, 0.55, 0.25, -6, "lo"],
      [4.0,  0.90, 0.70, 0.18,  4, "mid"], // FIRING FREQUENCY
      [5.0,  0.28, 0.90, 0.40,  7, "hi"],
      [6.0,  0.40, 1.00, 0.40, -5, "hi"],
      [8.0,  0.42, 1.40, 0.50,  6, "hi"],  // exhaust bark
      [10.0, 0.24, 1.70, 0.60,  8, "hi"],
      [12.0, 0.26, 1.90, 0.70, -7, "hi"],
      [16.0, 0.16, 2.20, 0.80,  5, "hi"],  // top-end scream
    ],
  },

  // 4) MOTORCYCLE — high-revving inline-4 sportbike: very high redline, thin/
  //    raspy, minimal low rumble, bright wail, quick throttle response.
  motorcycle: {
    cylinders: 4, redline: 14000, idleRpm: 1300, roughness: 0.7, mean: 0.55,
    formantShift: 1.8, revRate: 1.9,
    tune: { pitchScale: 1.05, growl: 0.7, rasp: 1.4, rumble: 0.35, noise: 0.9, formant: 1.3, volume: 0.95, crackle: 0.35, topEnd: 1.6 },
    orders: [
      [1.0,  0.10, 0.20, 0.20,  4, "lo"],
      [2.0,  0.45, 0.40, 0.20,  3, "mid"], // FIRING (I4 = 2nd order)
      [3.0,  0.14, 0.60, 0.40, -4, "hi"],
      [4.0,  0.35, 0.80, 0.35,  5, "hi"],  // 2× firing — the wail
      [6.0,  0.28, 1.00, 0.45, -5, "hi"],
      [8.0,  0.24, 1.20, 0.50,  6, "hi"],
      [10.0, 0.16, 1.40, 0.60,  7, "hi"],
      [12.0, 0.12, 1.60, 0.70, -6, "hi"],
    ],
  },
};

export class EngineSound {
  constructor(audio, {
    preset = "muscle",
    hp = 200,
    cylinders,
    redline,
    idleRpm,
    gears = 5,
    volume = 1,
  } = {}) {
    this.audio = audio;
    this.hp = hp;
    this.gears = gears;
    this._volOpt = volume;
    // explicit constructor overrides win over the preset's engine params
    this._override = { cylinders, redline, idleRpm };

    this.rpm = idleRpm ?? 850;
    this._gear = 0;
    this._shiftT = 0;
    this._nodes = null;
    this._crackleT = 0;
    this._lope = 0;
    this.running = false;

    // combustion ROUGHNESS (Ember 2026-07-20, Erik: "still sounds like the cars
    // are powered by an 80s computer"). Real firing is irregular (idle LOPE,
    // roughest at low load, smoothing under power). URL ?rough= overrides the
    // preset's base roughness for quick A/B.
    this._roughUrl = (typeof location !== "undefined" && /(?:\?|&)rough=([\d.]+)/.exec(location.search)) ? +RegExp.$1 : null;

    this.preset = preset;
    this._applyPreset(ENGINE_PRESETS[preset] || ENGINE_PRESETS.muscle);

    if (typeof window !== "undefined") window.__pfEngineSound = this;
  }

  /** list of available preset names (for menus / console discovery) */
  get presets() { return Object.keys(ENGINE_PRESETS); }

  /** switch voicing at runtime; rebuilds the order stack on the next frame */
  setPreset(name) {
    const p = ENGINE_PRESETS[name];
    if (!p) { console.warn("[EngineSound] unknown preset:", name, "— have:", this.presets.join(", ")); return false; }
    this.preset = name;
    this._applyPreset(p);
    // tear down the current graph so update() rebuilds with the new order stack
    if (this._nodes) { try { for (const o of this._nodes.oscs) o.stop(); } catch {} this._nodes = null; }
    return true;
  }

  _applyPreset(p) {
    // engine params: explicit constructor override > preset > hp-derived default
    const ov = this._override || {};
    this.cylinders = ov.cylinders ?? p.cylinders ?? (this.hp > 180 ? 8 : 6);
    this.redline   = ov.redline   ?? p.redline   ?? 6800;
    this.idleRpm   = ov.idleRpm   ?? p.idleRpm   ?? 850;
    // meanness 0..1: preset may pin it; else log curve on hp (100→0.18…10000→1.0)
    this.mean = p.mean ?? Math.min(1, Math.log10(this.hp / 40) / Math.log10(250));
    this.roughness = this._roughUrl ?? p.roughness ?? 1;
    this.formantShift = p.formantShift ?? 1;
    this.revRate = p.revRate ?? 1;
    this._orderSpec = p.orders;
    // live-tunable dials (a copy so window edits don't mutate the preset table)
    const t = p.tune || {};
    this.tune = {
      pitchScale: t.pitchScale ?? 0.72,
      growl:   t.growl   ?? 1.0,
      rasp:    t.rasp    ?? 1.0,
      rumble:  t.rumble  ?? 1.0,
      noise:   t.noise   ?? 1.0,
      formant: t.formant ?? 1.0,
      volume:  (t.volume ?? 1.0) * this._volOpt,
      crackle: t.crackle ?? 0,
      // topEnd: how aggressively the 4k→redline range opens up (bright + rasp +
      // snarl). Higher = a bigger, faster-sounding climb to the redline note.
      topEnd:  t.topEnd  ?? 1.0,
    };
    // clamp rpm into the new engine's range
    this.rpm = Math.max(this.idleRpm, Math.min(this.redline, this.rpm));
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

    // ── combustion growl: tanh waveshaper adds harmonics + intermodulation ───
    const shaper = ctx.createWaveShaper();
    shaper._drive = 2 + this.mean * 40;
    shaper.curve = this._makeDriveCurve(shaper._drive);
    sum.connect(shaper);

    // ── two cascaded lowpasses (24 dB/oct) tame the very top under load ──────
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 500; lp.Q.value = 0.6;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = "lowpass"; lp2.frequency.value = 800; lp2.Q.value = 0.6;
    shaper.connect(lp).connect(lp2);

    // ── EXHAUST FORMANTS: fixed-frequency peaks = exhaust/airbox/cabin
    //    resonances. Fixed while pitch sweeps → timbre opens a "vowel". The
    //    preset's formantShift moves the whole set (bike = higher/raspier). ───
    const fs = this.formantShift;
    const f1 = ctx.createBiquadFilter(); // chest thump / drone
    f1.type = "peaking"; f1.frequency.value = 90 * fs;  f1.Q.value = 1.1; f1.gain.value = 8;
    const f2 = ctx.createBiquadFilter(); // low body
    f2.type = "peaking"; f2.frequency.value = 200 * fs; f2.Q.value = 1.3; f2.gain.value = 5;
    const f3 = ctx.createBiquadFilter(); // rasp / body
    f3.type = "peaking"; f3.frequency.value = 520 * fs; f3.Q.value = 1.5; f3.gain.value = 4;
    // intake honk: opens with throttle (engine "sucking air" under load)
    const intake = ctx.createBiquadFilter();
    intake.type = "peaking"; intake.frequency.value = 800 * fs; intake.Q.value = 1.8; intake.gain.value = 0;
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

    // ── exhaust noise: looping noise → rpm-tracking bandpass = broadband roar ─
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

    // ---- gearbox + engine state: RPM is SIMULATED, not a map of road speed. ---
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
    // engine inertia: revRate lets light engines (bikes) spin up snappier.
    // Climb rate raised (was 2.2+6·t0) so rpm no longer LAGS behind a fast
    // low-gear pull — before, a quick sweep upshifted at ~0.94 redline so only
    // sustained top-gear WOT ever reached the true redline note (Erik). Now the
    // engine catches its target in every gear and hits redline at each upshift.
    const climb = (3.4 + 9.5 * t0) * (body.wheelspin ? 1.6 : 1) * this.revRate;
    const rate = (wantN > curN ? climb : 1.6 * this.revRate);
    const step = Math.max(-rate * dt, Math.min(rate * dt, wantN - curN));
    this.rpm = (curN + step) * this.redline;

    // ---- LOAD: throttle "opens up" the timbre; a shift cut reads as low load. -
    const revN = this.rpm / this.redline;
    const t = Math.abs(body.throttle);
    const load = Math.max(0, Math.min(1, (this._shiftT > 0 ? 0.15 : 0.2) + t * 0.8));

    // ---- combustion roughness: smoothed random walk wobbles the firing rate.
    // Strongest at low load (idle LOPE), smooths under power. -------------------
    const lopeAmt = this.roughness * (0.55 + 0.45 * this.mean) * (1 - 0.72 * load);
    this._lope = this._lope * 0.86 + (Math.random() * 2 - 1) * 0.14;   // -1..1 smoothed
    const roughN = 1 + this._lope * 0.06 * lopeAmt;                    // ±~6% firing wobble at idle

    // ---- crankshaft rotation frequency drives EVERY order.  f0 = rpm/60. ------
    const f0 = (this.rpm / 60) * T.pitchScale * roughN;

    // rpmBright: a curved 0..1 that drives the 4k→redline "opening up". The
    // exponent < 1 makes the change bite HARDER in the upper range (the region
    // Erik said sounded flat), so revs climbing toward redline audibly rasp/
    // brighten instead of the old near-flat top. te scales the whole effect.
    const te = T.topEnd;
    const rpmBright = Math.pow(revN, 0.8);

    for (let i = 0; i < n.oscGains.length; i++) {
      const g = n.oscGains[i];
      const o = n.oscs[i];
      if (g._base === undefined) continue;
      o.frequency.value = f0 * o._order;             // frequency = order × f0
      // slow random-walk detune (anti phase-lock; livelier at idle)
      n.drift[i] = n.drift[i] * 0.9 + (Math.random() * 2 - 1) * (0.6 + 4 * (1 - load));
      o.detune.value = o._det + n.drift[i];
      // gain: base × load-opening × rpm-fade × top-end bloom.
      // fade now cancels fully under load (was ·0.5, which muted the top just
      // when it should scream); overrun (low load) still closes the top off.
      const bandScale = g._band === "hi" ? T.rasp : g._band === "lo" ? T.rumble : 1;
      const fade = 1 - g._rf * revN * (1 - load);
      // hi orders BLOOM toward redline under load → the upper range "opens up"
      const hiBloom = g._band === "hi" ? (1 + load * rpmBright * 0.9 * te) : 1;
      g.gain.value = g._base * bandScale * (1 + g._lb * load) * Math.max(0.05, fade) * hiBloom;
    }

    // ---- exhaust broadband roar: tracks firing frequency, grows hard with revs
    const fireFreq = f0 * (this.cylinders / 2);
    n.bp.frequency.value = 140 + fireFreq * 1.4;
    n.nGain.gain.value = (0.04 + this.mean * 0.26) * (0.3 + 1.0 * rpmBright) * (0.5 + 0.6 * load) * T.noise;

    // ---- formants: mostly fixed, tiny rev drift; intake honk opens with load. -
    const fs = this.formantShift;
    n.f1.frequency.value = (88 + revN * 40) * fs;
    n.f1.gain.value = 8 * T.formant;
    // rasp formant climbs with rpm under load — big part of the redline "bark"
    n.f3.gain.value = (3 + 3 * load + 4 * load * rpmBright * te) * T.formant;
    n.intake.frequency.value = (650 + revN * 900) * fs;
    n.intake.gain.value = load * (5 + 3 * rpmBright) * T.formant;   // "sucking air", opens with revs

    // ---- waveshaper drive rises with load + revs (engine snarls harder to the
    // redline). The revN term is now much stronger so the top-end really bites. -
    const wantDrive = (2 + this.mean * 40) * T.growl * (0.7 + 0.6 * load) * (0.75 + 0.6 * rpmBright * te);
    if (Math.abs(wantDrive - n.shaper._drive) > 1.5) {         // rebuild curve only when it moves
      n.shaper.curve = this._makeDriveCurve(wantDrive);
      n.shaper._drive = wantDrive;
    }

    // ---- top lowpass: brightness now sweeps ~1kHz across 4k→redline (was only
    // ~200 Hz — the compressed upper range Erik heard). The rpm-driven term is
    // dominant and scaled by topEnd, so lower gears that flash to redline get
    // the same wide-open brightness as a sustained top-gear pull. --------------
    const cutoff = 300 + this.mean * 340 + load * 280 + load * rpmBright * 1500 * te + revN * 150;
    n.lp.frequency.value = cutoff;
    n.lp2.frequency.value = cutoff * 1.5;

    // ---- master gain: loud under load, quieter on overrun; amplitude flutter
    // pairs with the pitch wobble so the lope reads as a lumpy idle, not vibrato.
    const flutter = 1 + this._lope * 0.05 * lopeAmt;
    const vol = (0.06 + 0.1 * this.mean) * load * T.volume * (0.55 + 0.5 * revN) * flutter;
    n.master.gain.value += (vol - n.master.gain.value) * (1 - Math.exp(-dt * 10));

    // ---- misfire crackle: overrun burble + preset-driven idle chaos ----------
    // tune.crackle sets how poppy the idle/low-load is (0 tame … 2.6 alcohol).
    this._crackleT -= dt;
    const overrun = (t < 0.15 && this.rpm > this.redline * 0.4) ? 2.8 : 0;   // lift-off burble
    const idleChaos = T.crackle * (t < 0.2 ? 16 : 6) * Math.max(0.4, this.mean);
    const crackleP = overrun + idleChaos;
    if (this._crackleT <= 0 && Math.random() < crackleP * dt) {
      const ctx = this.audio.ctx, now = ctx.currentTime;
      n.crackle.gain.cancelScheduledValues(now);
      n.crackle.gain.setValueAtTime(0.5 + this.mean * 0.8, now);
      n.crackle.gain.exponentialRampToValueAtTime(0.001, now + 0.04 + Math.random() * 0.05);
      this._crackleT = 0.03;
    }
  }
}

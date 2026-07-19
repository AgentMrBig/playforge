import * as THREE from "three";

/**
 * DayNight — Ember's lighting lane (Erik: "engineer a day and night cycle").
 *
 * A game-time clock (default: full 24h in 10 real minutes) drives the SUN's
 * actual position across the sky. Everything follows time of day:
 *   • sun elevation + azimuth (real arc: rises ~6h, noon 12h, sets ~18h)
 *   • sun color/intensity: warm orange at the horizon → white at noon → off below
 *   • MOON: dim cool light after sunset so night stays playable (takes over
 *     shadow-casting from the sun, so dawn/dusk stay one-shadow cheap)
 *   • hemisphere sky/ground bounce, background + fog color, tone exposure —
 *     all ramp through day → dusk → night stops
 *   • the phase-1 camera-following shadow box rides the time-driven sun
 *
 * Seam (test tools / URL): window.__pfSky — .hour (get/set), .setHour(h),
 * .daySeconds. URL: ?hour=18 start time, ?daylen=600 cycle length seconds,
 * ?hour=off freezes at 10am (defaults preserved for screenshots/regression).
 */

// color ramps keyed by sun elevation factor e = sin(elevation): 1 noon, 0
// horizon, negative night. Each stop: [e, color]. Lerped between stops.
const ramp = (stops, e, out) => {
  if (e <= stops[0][0]) return out.set(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i][0]) {
      const [e0, c0] = stops[i - 1], [e1, c1] = stops[i];
      return out.set(c0).lerp(new THREE.Color(c1), (e - e0) / (e1 - e0));
    }
  }
  return out.set(stops[stops.length - 1][1]);
};
const SUN_COL  = [[-0.05, 0x331705], [0.0, 0xff7a2a], [0.12, 0xffc26e], [0.35, 0xfff0d0]];
const SKY_COL  = [[-0.18, 0x070b16], [-0.04, 0x1a2033], [0.0, 0xd97a4e], [0.10, 0xe8a26e], [0.30, 0x8fb9dc]];
const HEMI_SKY = [[-0.15, 0x141c30], [0.0, 0xc98a5e], [0.25, 0xbfd7f0]];
const HEMI_GND = [[-0.15, 0x0c1018], [0.0, 0x6e4a34], [0.25, 0x8a7a5f]];

export class DayNight {
  constructor({ engine, world, daySeconds = 600, startHour = 10 } = {}) {
    this.engine = engine;
    this.world = world;
    const q = new URLSearchParams(location.search);
    this.daySeconds = Number(q.get("daylen")) || daySeconds;
    const qh = q.get("hour");
    this.frozen = qh === "off";
    this.hour = this.frozen ? 10 : (qh !== null && !isNaN(+qh) ? +qh : startHour);

    this.group = new THREE.Group();
    // SUN (phase-1 config: PCFSoft, camera-following box)
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
    this._shadowRig(this.sun);
    // MOON: cool dim opposite light — owns shadows at night
    this.moon = new THREE.DirectionalLight(0x8fa8d8, 0);
    this._shadowRig(this.moon);
    this.moon.castShadow = false;
    this.hemi = new THREE.HemisphereLight(0xbfd7f0, 0x8a7a5f, 0.75);
    // GI phase-3 candidate: sun BOUNCE fill — one shadowless directional from
    // the sun's mirror direction, tinted by the lit ground, so shaded faces
    // pick up warm reflected light instead of pure sky ambient. Cheapest
    // convincing indirect-light term there is; __pfSky.bounce to inspect/tune.
    this.bounce = new THREE.DirectionalLight(0xc9b08a, 0);
    this.bounce.castShadow = false;
    this.group.add(this.sun, this.sun.target, this.moon, this.moon.target, this.hemi, this.bounce, this.bounce.target);
    this._sky = new THREE.Color(); this._c = new THREE.Color();
    if (typeof window !== "undefined") window.__pfSky = this;
  }

  _shadowRig(light) {
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    const S = 95;
    light.shadow.camera.left = -S; light.shadow.camera.right = S;
    light.shadow.camera.top = S; light.shadow.camera.bottom = -S;
    light.shadow.camera.near = 1; light.shadow.camera.far = 500;
    light.shadow.bias = -0.0004; light.shadow.normalBias = 0.03;
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; }

  update(dt) {
    if (!this.frozen) this.setHour(this.hour + (dt / this.daySeconds) * 24);
    const t = this.hour;
    // real solar arc: elevation peaks at noon (~68°), below horizon at night;
    // azimuth sweeps the full circle once per day
    const elev = Math.sin(((t - 6) / 12) * Math.PI) * (Math.PI * 0.38);
    const az = ((t + 12) / 24) * Math.PI * 2;
    const e = Math.sin(elev);                     // -1..1 elevation factor
    const ce = Math.cos(elev);
    const dirX = Math.cos(az) * ce, dirZ = Math.sin(az) * ce;

    // daylight 0..1 with a WIDE dawn/dusk shoulder — golden hour should feel
    // like an hour, not a blink (at 0.18 the sun hit full power 40min after rise)
    const d = THREE.MathUtils.smoothstep(e, -0.06, 0.32);

    // ---- sun ----
    this.sun.intensity = 2.6 * d;
    ramp(SUN_COL, e, this.sun.color);
    // ---- moon: fades in as the sun dies; owns shadows at deep night ----
    const night = 1 - d;
    this.moon.intensity = 0.32 * night;
    const swap = e < -0.08;                        // sun well below horizon
    this.sun.castShadow = !swap;
    this.moon.castShadow = swap;
    // ---- ambient / sky / fog / exposure ----
    this.hemi.intensity = 0.12 + 0.63 * d;
    ramp(HEMI_SKY, e, this.hemi.color);
    ramp(HEMI_GND, e, this.hemi.groundColor);
    ramp(SKY_COL, e, this._sky);
    // scene.background (not renderer clear color!) — it's color-managed, so it
    // renders identically through the plain path AND the AO composer (a raw
    // clear color gets cleared linear then output-transformed = washed white)
    this.world.scene.background = this._sky;
    const fog = this.world.scene.fog;
    if (fog) fog.color.copy(this._sky);
    this.engine.renderer.toneMappingExposure = 0.9 + 0.25 * d;

    // ---- bounce: mirrors the sun from low on the opposite side, ground-tinted,
    // strongest when the sun is high (more light hitting the ground to reflect)
    this.bounce.intensity = 0.5 * d * Math.max(0, e);
    this.bounce.color.copy(this.hemi.groundColor).lerp(this.sun.color, 0.35);

    // ---- lights ride the camera (phase-1 follow box) ----
    const c = this.world.camera.position;
    this.sun.target.position.set(c.x, 0, c.z);
    this.sun.position.set(c.x + dirX * 220, Math.max(e, 0.06) * 220, c.z + dirZ * 220);
    this.moon.target.position.set(c.x, 0, c.z);
    // moon opposite the sun's azimuth, decently high
    this.moon.position.set(c.x - dirX * 220, 140, c.z - dirZ * 220);
    this.bounce.target.position.set(c.x, 30, c.z);       // aims slightly UP at faces
    this.bounce.position.set(c.x - dirX * 150, 8, c.z - dirZ * 150);
  }
}

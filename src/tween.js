/**
 * Tweens & timers — the quality-of-life layer.
 *
 *   tween(mesh.scale, { x: 2, y: 2, z: 2 }, 0.3, { ease: "backOut" });
 *   tween(entity.position, { y: 5 }, 1, { ease: "sineInOut", yoyo: true, repeat: Infinity });
 *   after(2, () => spawnBoss());
 *   every(0.5, () => emitter.burst(3));
 *
 * Driven by the engine: call Tweens.update(dt) once per frame (Engine does
 * this automatically when you use the exported singleton helpers).
 */

export const Ease = {
  linear: (t) => t,
  quadOut: (t) => 1 - (1 - t) * (1 - t),
  quadIn: (t) => t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  backOut: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  bounceOut: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
  elasticOut: (t) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
};

const active = [];
const timers = [];

/** animate obj's numeric properties toward `to` over `dur` seconds */
export function tween(obj, to, dur, { ease = "quadOut", delay = 0, yoyo = false, repeat = 0, onDone = null } = {}) {
  const t = {
    obj, to, dur, delay, yoyo, repeat, onDone,
    ease: typeof ease === "function" ? ease : Ease[ease] ?? Ease.quadOut,
    from: {}, t: 0, forward: true, dead: false,
  };
  for (const k of Object.keys(to)) t.from[k] = obj[k];
  active.push(t);
  return { cancel() { t.dead = true; } };
}

/** run fn once after `sec` seconds */
export function after(sec, fn) {
  const t = { left: sec, fn, repeat: false, dead: false };
  timers.push(t);
  return { cancel() { t.dead = true; } };
}

/** run fn every `sec` seconds until cancelled */
export function every(sec, fn) {
  const t = { left: sec, sec, fn, repeat: true, dead: false };
  timers.push(t);
  return { cancel() { t.dead = true; } };
}

export const Tweens = {
  update(dt) {
    for (let i = active.length - 1; i >= 0; i--) {
      const t = active[i];
      if (t.dead) { active.splice(i, 1); continue; }
      if (t.delay > 0) { t.delay -= dt; continue; }
      t.t = Math.min(t.t + dt / t.dur, 1);
      const k = t.ease(t.forward ? t.t : 1 - t.t);
      for (const key of Object.keys(t.to))
        t.obj[key] = t.from[key] + (t.to[key] - t.from[key]) * k;
      if (t.t >= 1) {
        if (t.yoyo && t.forward) { t.forward = false; t.t = 0; continue; }
        if (t.repeat > 0 || t.repeat === Infinity) {
          if (t.repeat !== Infinity) t.repeat--;
          t.forward = true; t.t = 0; continue;
        }
        t.onDone?.();
        active.splice(i, 1);
      }
    }
    for (let i = timers.length - 1; i >= 0; i--) {
      const t = timers[i];
      if (t.dead) { timers.splice(i, 1); continue; }
      t.left -= dt;
      if (t.left <= 0) {
        t.fn();
        if (t.repeat) t.left = t.sec;
        else timers.splice(i, 1);
      }
    }
  },
  clear() { active.length = 0; timers.length = 0; },
  get count() { return active.length + timers.length; },
};

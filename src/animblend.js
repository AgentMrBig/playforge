// PlayForge animation blending — play MULTIPLE clips at once (Erik: "the character
// keeps running and firing not because we have a running-and-firing animation but
// because we blend our running and shooting animations together live").
//
// Owned by General (character lane). Technique: UPPER/LOWER BODY SPLIT — the classic
// GTA layering. Each clip is split into two sub-clips by bone: legs+hips tracks, and
// spine/arms/head tracks. Playing runSplit.lower + fireSplit.upper simultaneously is
// conflict-free (disjoint tracks), so the legs sprint while the arms shoulder the gun.
// Weighted crossfades between blends come free from the mixer.

import * as THREE from "three";

const UPPER_RE = /spine|neck|head|shoulder|arm|hand|clavicle/i;

/** track target bone name ("Hips.quaternion" → "Hips") */
const trackBone = (t) => t.name.split(".")[0];

/** split a clip into { upper, lower } sub-clips by bone name */
export function splitClip(clip) {
  const upper = new THREE.AnimationClip(clip.name + ".upper", clip.duration, clip.tracks.filter((t) => UPPER_RE.test(trackBone(t))));
  const lower = new THREE.AnimationClip(clip.name + ".lower", clip.duration, clip.tracks.filter((t) => !UPPER_RE.test(trackBone(t))));
  return { upper, lower };
}

/**
 * BlendController — drives layered playback on an Animator's mixer.
 *   blend.set({ lower: "run", upper: "firingRifle" });  // legs run, arms fire
 *   blend.set(null);                                    // back to whole-clip mode
 */
export class BlendController {
  constructor(animator) {
    this.animator = animator;              // { mixer, clips (name→clip), actions, current }
    this._split = {};                      // clipName → { upper: action, lower: action }
    this.active = null;                    // { lower, upper } names or null
  }

  _action(clipName, half) {
    const key = `${clipName}.${half}`;
    if (!this._split[key]) {
      const src = this.animator.clips[clipName];
      if (!src) return null;
      const sub = splitClip(src)[half];
      if (!sub.tracks.length) return null;
      this._split[key] = this.animator.mixer.clipAction(sub);
    }
    return this._split[key];
  }

  /** engage a layered blend (or null to clear back to normal whole-clip playback) */
  set(layers, { fade = 0.18 } = {}) {
    if (!layers) {
      if (this.active) {
        // Just FADE the split layers to zero weight — do NOT schedule a stop(). A deferred
        // stop() was the T-pose bug: a rapid clear→re-engage (double-tap, or jump-then-move,
        // both only while armed) let the delayed stop kill the freshly-started blend, dropping
        // the upper body to bind pose. Faded-to-0 actions cost nothing and re-engage cleanly.
        for (const k in this._split) this._split[k].fadeOut(fade);
        this.active = null;
        this.animator.current = null;      // force the next whole-clip play to restart cleanly
      }
      return;
    }
    const { lower, upper } = layers;
    if (this.active && this.active.lower === lower && this.active.upper === upper) return;
    // fade the whole-clip action out so it doesn't fight the layers
    if (this.animator.current && this.animator.actions[this.animator.current]) {
      this.animator.actions[this.animator.current].fadeOut(fade);
      this.animator.current = "__blend__";  // sentinel: play() calls won't early-return on a real clip
    }
    // fade out any previous split actions that aren't in the new blend
    for (const k in this._split) {
      const keep = k === `${lower}.lower` || k === `${upper}.upper`;
      if (!keep && this._split[k].isRunning()) this._split[k].fadeOut(fade);
    }
    const lo = this._action(lower, "lower"), up = this._action(upper, "upper");
    for (const a of [lo, up]) {
      if (!a) continue;
      if (!a.isRunning()) { a.reset(); a.play(); }
      a.enabled = true;
      a.fadeIn(fade);                        // fade in from whatever weight (0 if just cleared)
    }
    this.active = { lower, upper };
  }
}

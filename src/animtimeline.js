// PlayForge BEHAVIOR TIMELINE — Erik's Maya-Trax-style non-linear animation editor
// (2026-07-19): "start with a basic animation and build a new one from it — place a
// marker on the timeline, choose where the behavior ends, and while that marker is
// selected move the character's bones with our system to the pose it needs."
//
// Owned by General (character lane). A BEHAVIOR = a base clip + pose KEYFRAMES at
// timeline markers. Playback runs the base clip and, near each marker, slerps every
// bone from the clip's pose toward the marker's authored pose (smoothstep window in/out)
// — so a "shoot from the hip" is the pistol clip + one posed keyframe, not new mocap.
// Author poses with the existing IK grab; capture writes them into the selected marker.

import * as THREE from "three";
import { applyWelds } from "./ik.js";

const smooth = (x) => x * x * (3 - 2 * x);
const _sq = new THREE.Quaternion();   // slerp target MUST be a real Quaternion (plain {x,y,z,w} reads _x internals = silent no-op)

export class BehaviorTimeline {
  /** @param {object} animator  { mixer, clips, actions, current }
   *  @param {object} playerObj the character root (to find the skinned skeleton) */
  constructor(animator, playerObj) {
    this.animator = animator; this.playerObj = playerObj;
    this.base = null;            // base clip name
    this.time = 0; this.playing = false;
    this.markers = [];           // [{ t, window, pose: {boneName: [x,y,z,w]} }]
    this.welds = {};             // hand → { pos } in the held weapon's frame (🔗, from TestMode)
    this.selected = -1;          // selected marker index (new markers auto-select — Erik)
    this._skel = null;
  }

  skeleton() {
    if (!this._skel) this.playerObj?.traverse((o) => { if (!this._skel && o.isSkinnedMesh && o.skeleton) this._skel = o.skeleton; });
    return this._skel;
  }
  /** EVERY bone under the player (stable traversal order) — the IK tool poses WRAPPER
   * bones that are NOT in skeleton.bones, so a skeleton-only snapshot misses exactly
   * the poses the author creates. Index-keyed over this list instead. */
  bones() {
    if (!this._bones) { this._bones = []; this.playerObj?.traverse((o) => { if (o.isBone) this._bones.push(o); }); }
    return this._bones;
  }
  duration() { const c = this.base && this.animator.clips[this.base]; return c ? c.duration : 0; }

  /** open a behavior on a base clip (resets markers unless keep) */
  setBase(name, keep = false) {
    this.base = name; this.time = 0; this.playing = false;
    if (!keep) { this.markers = []; this.selected = -1; }
    const a = this.animator.actions[name];
    if (a) { this.animator.mixer.stopAllAction(); this.animator.current = null; a.reset().play(); a.paused = true; }
  }

  /** scrub to time t (seconds) — shows base clip + marker influence at that moment */
  scrub(t) {
    this.time = Math.max(0, Math.min(this.duration(), t));
    const a = this.base && this.animator.actions[this.base];
    if (a) { a.paused = false; a.time = this.time; this.animator.mixer.update(0); a.paused = true; }
  }

  addMarker() {
    const m = { t: this.time, window: 0.35, pose: this._snapshot() };   // pose starts as "clip pose here"
    this.markers.push(m); this.markers.sort((x, y) => x.t - y.t);
    this.selected = this.markers.indexOf(m);                             // auto-select on create (Erik)
    return this.selected;
  }
  deleteMarker() { if (this.selected >= 0) { this.markers.splice(this.selected, 1); this.selected = -1; } }

  /** 📸 write the CURRENT skeleton pose (e.g. after IK dragging) into the selected marker */
  capturePoseToMarker() {
    if (this.selected < 0) return false;
    this.markers[this.selected].pose = this._snapshot();
    return true;
  }

  _snapshot() {
    // ★ keyed by bone INDEX — this rig has duplicate same-named bones, so a name map
    // collapses them (one quat applied to every dup = multiplied rotation)
    return this.bones().map((b) => b.quaternion.toArray());
  }

  /** per-frame (AFTER the mixer writes the clip pose): apply marker influence at this.time */
  evaluate(dt) {
    if (!this.base) return;
    const a = this.animator.actions[this.base];
    if (this.playing && a) {
      a.paused = false;
      this.time = a.time;                       // mixer advances; we follow
      if (this.time >= this.duration() - 0.016 || (a.loop === THREE.LoopOnce && !a.isRunning())) { this.playing = false; a.paused = true; }
    }
    const bones = this.bones(); if (!bones.length) return;
    for (const m of this.markers) {
      const d = Math.abs(this.time - m.t);
      if (d >= m.window) continue;
      const w = smooth(1 - d / m.window);
      for (let i = 0; i < bones.length; i++) {
        const q = m.pose[i];
        if (q) bones[i].quaternion.slerp(_sq.fromArray(q), w);
      }
    }
  }

  play({ once = false } = {}) {
    if (!this.base) return;
    if (this.time >= this.duration() - 0.02) this.scrub(0);
    const a = this.animator.actions[this.base];
    if (a) { a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = once; }
    this.playing = true;
  }
  pause() { this.playing = false; const a = this.base && this.animator.actions[this.base]; if (a) a.paused = true; }

  /** persist / restore a named behavior */
  save(name) {
    const data = { base: this.base, markers: this.markers, welds: this.welds };
    try { localStorage.setItem(`pf.behavior.${name}`, JSON.stringify(data)); } catch {}
    console.log(`[behavior saved: ${name}]`, JSON.stringify(data));
    return data;
  }
  load(name) {
    try {
      const d = JSON.parse(localStorage.getItem(`pf.behavior.${name}`) || "null");
      if (!d || !d.base) return false;
      this.setBase(d.base, true); this.markers = d.markers || []; this.welds = d.welds || {}; this.selected = -1;
      return true;
    } catch { return false; }
  }
  static list() {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("pf.behavior.")) out.push(k.slice(12)); } } catch {}
    return out;
  }

  /** hand animation control back to the game */
  close() { this.playing = false; this.base = null; this.animator.current = null; }
}

/** BehaviorTriggers — bind saved behaviors to KEYS so they fire in normal gameplay
 * (author in the workshop → press the key in-game → the behavior plays). Bindings
 * persist in localStorage `pf.behavior.triggers` as { KeyCode: behaviorName }. */
export class BehaviorTriggers {
  constructor(player) {
    this.player = player;           // a BehaviorPlayer
    this.load();
    if (typeof window === "undefined") return;
    window.__pfTriggers = this;
    window.addEventListener("keydown", (e) => {
      if (e.repeat || /input|textarea|select/i.test(e.target?.tagName)) return;
      if (window.__pfTest && window.__pfTest.active && !window.__pfTest.livePlay) return;   // workshop owns keys — but in live play, triggers fire
      const name = this.map[e.code];
      if (name && !this.player.active) this.player.play(name);
    });
  }
  load() { try { this.map = JSON.parse(localStorage.getItem("pf.behavior.triggers") || "{}"); } catch { this.map = {}; } }
  _save() { try { localStorage.setItem("pf.behavior.triggers", JSON.stringify(this.map)); } catch {} }
  bind(code, name) { this.map[code] = name; this._save(); }
  unbind(code) { delete this.map[code]; this._save(); }
}

/** BehaviorPlayer — run a SAVED behavior in the LIVE game (author in the workshop,
 * play in gameplay). While active the game's anim-select yields; when the behavior
 * finishes, control returns automatically. `window.__pfPlayBehavior("name")` anywhere. */
export class BehaviorPlayer {
  constructor(animator, playerObj) {
    this.tl = new BehaviorTimeline(animator, playerObj);
    this.active = false;
  }
  play(name) {
    if (!this.tl.load(name)) return false;
    this.tl.scrub(0); this.tl.play({ once: true });   // behaviors run ONCE — looping skipped the end and control never returned
    this.active = true;
    return true;
  }
  stop() { this.active = false; this.tl.close(); }
  update(dt) {
    if (!this.active) return;
    this.tl.evaluate(dt);
    // 🔗 welded hands ride the weapon during in-game playback too
    applyWelds(this.tl.playerObj, this.tl.welds, window.__pfCombat && window.__pfCombat._holder);
    if (!this.tl.playing) this.stop();               // behavior finished → game resumes
  }
}

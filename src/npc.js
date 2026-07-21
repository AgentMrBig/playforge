import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Animator } from "./animation.js";
import { loadCharacter } from "./character.js";
import { CharacterBody } from "./phys.js";

/**
 * Pedestrians — cheap NPC walkers that bring the settlements to life.
 *
 * One base character is loaded, then SkeletonUtils-cloned per NPC so each has
 * its OWN skeleton + its own Animator that shares the same name-based clips
 * (walk/idle/run resolve against the clone's bones). NPCs wander between random
 * points inside their cluster, clamped to the terrain height — no per-NPC Rapier
 * body, so a crowd stays cheap. They face the walk direction and cross-fade
 * walk↔idle. Precise building/car collision for NPCs is a later pass; for now
 * they're ambient life, not obstacles.
 *
 *   await spawnPedestrians(world, {
 *     model: "models/character/humanoid_male.fbx", texture, textureDir,
 *     heightAt, clusters: [{ x, z, radius: 20, count: 8 }],
 *   });
 */
export class Pedestrian {
  constructor({ heightAt, center, radius = 18, speed = 1.2, clips = { walk: "walk", idle: "idle" }, footOffset = 0 }) {
    this.heightAt = heightAt;
    this.center = center;          // { x, z } home point
    this.radius = radius;
    this.speed = speed;
    this.clipWalk = clips.walk;
    this.clipIdle = clips.idle;
    this.clipRun = clips.run || clips.walk;
    this.footOffset = footOffset;
    this.target = null;
    this.pauseT = 0;
    this.state = "stroll";         // stroll | idle | flee
    this.fleeFrom = null; this.fleeT = 0;
    this.yaw = Math.random() * Math.PI * 2;
  }

  /** ambient brain: is there something to run FROM right now? (gunfire nearby, a fast car
   * bearing down). Returns the danger {x,z} to flee away from, or null. */
  _danger(p) {
    const pf = (typeof window !== "undefined") && window.__pf;
    if (!pf) return null;
    const cs = typeof window !== "undefined" && window.__pfCombat;
    if (cs && cs.lastFireAt && performance.now() - cs.lastFireAt < 700 && pf.player) {
      const pp = pf.player.position;
      if (Math.hypot(p.x - pp.x, p.z - pp.z) < 20) return { x: pp.x, z: pp.z };   // shots near → scatter
    }
    for (const car of pf.cars || []) {
      const vb = car.components && car.components.find((c) => c.rb && c.velocity);
      if (!vb) continue;
      const cp = car.position, spd = vb.velocity.length ? vb.velocity.length() : 0;
      if (spd > 8 && Math.hypot(p.x - cp.x, p.z - cp.z) < 11) return { x: cp.x, z: cp.z };  // car incoming → dive away
    }
    return null;
  }

  init(entity) {
    this._entity = entity; this._pick();
    // a Rapier capsule (CharacterBody) if one was added → NPC is SOLID + collides with
    // walls/cars/each other. Else fall back to the lightweight ground-clamped move.
    this.body = entity.components.find((c) => c.velocity && c.onGround !== undefined) || null;
    if (!this.body) this._clamp(entity.position);
  }

  _pick() {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * this.radius;
    this.target = { x: this.center.x + Math.cos(a) * d, z: this.center.z + Math.sin(a) * d };
  }

  _clamp(p) {
    const h = this.heightAt(p.x, p.z);
    if (h > -Infinity) p.y = h + this.footOffset;
  }

  _drive(nx, nz) {                          // set horizontal velocity (capsule) or move directly
    if (this.body) { this.body.velocity.x = nx * this.speed; this.body.velocity.z = nz * this.speed; }
  }

  update(dt, { entity }) {
    const anim = entity.get(Animator);
    const p = entity.position;

    // ── FLEE: bolt away from gunfire / a speeding car ──
    const danger = this._danger(p);
    if (danger) { this.fleeFrom = danger; this.fleeT = 1.6 + Math.random(); this.state = "flee"; this.pauseT = 0; }
    if (this.state === "flee") {
      this.fleeT -= dt;
      let dx = p.x - this.fleeFrom.x, dz = p.z - this.fleeFrom.z; const d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d, run = this.speed * 2.6;
      if (this.body) { this.body.velocity.x = nx * run; this.body.velocity.z = nz * run; }
      else { p.x += nx * run * dt; p.z += nz * run * dt; this._clamp(p); }
      this.yaw = Math.atan2(nx, nz); this._faceTo(entity, this.yaw, dt * 2);
      anim?.play(this.clipRun, { fade: 0.15, speed: 1.15 });
      if (this.fleeT <= 0 && !danger) { this.state = "stroll"; this._pick(); }
      return;
    }

    if (this.pauseT > 0) {
      this.pauseT -= dt;
      this._drive(0, 0);
      anim?.play(this.clipIdle, { fade: 0.3 });
      // REACT: if you're standing close, glance at you instead of staring into space
      const pf = (typeof window !== "undefined") && window.__pf;
      if (pf && pf.player && Math.hypot(p.x - pf.player.position.x, p.z - pf.player.position.z) < 7) {
        this._faceTo(entity, Math.atan2(pf.player.position.x - p.x, pf.player.position.z - p.z), dt * 1.5);
      } else this._faceTo(entity, this.yaw, dt);
      if (!this.body) this._clamp(p);
      return;
    }

    const dx = this.target.x - p.x, dz = this.target.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.6) {                       // arrived — stand a beat, then re-roam
      this.pauseT = 1.5 + Math.random() * 3.5;
      this._drive(0, 0);
      this._pick();
      return;
    }
    const nx = dx / dist, nz = dz / dist;
    if (this.body) {                        // capsule moves + collides (walls/cars/others)
      this._drive(nx, nz);
      // stuck against a wall for a moment? pick a new target so the crowd doesn't jam
      this._stuckT = (dist > (this._lastDist ?? dist) - 0.001) ? (this._stuckT ?? 0) + dt : 0;
      this._lastDist = dist;
      if (this._stuckT > 2.5) { this._stuckT = 0; this._pick(); }
    } else {
      p.x += nx * this.speed * dt;
      p.z += nz * this.speed * dt;
      this._clamp(p);
    }
    this.yaw = Math.atan2(nx, nz);
    this._faceTo(entity, this.yaw, dt);
    anim?.play(this.clipWalk, { fade: 0.2, speed: Math.min(1.3, this.speed / 1.2) });
  }

  // smooth turn toward a yaw (shortest arc)
  _faceTo(entity, want, dt) {
    let d = want - entity.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    entity.rotation.y += d * Math.min(1, dt * 8);
  }
}

/**
 * Load one or more base characters and scatter cloned wanderers across clusters.
 * Pass `models: [{ model, texture, textureDir, flipY, retargetFrom, animations }]`
 * for a VARIED crowd (each NPC clones a random base) — Synty characters use the
 * retarget pipeline (retargetFrom a Mixamo-skeleton FBX). A single `model` still
 * works (wrapped into a one-entry list). Bases that fail to load are skipped.
 */
export async function spawnPedestrians(world, {
  models = null, model = null, texture = null, textureDir = "", flipY = true,
  targetHeight = 1.8, animations = null, retargetFrom = null,
  heightAt, clusters = [], footOffset = 0, scaleJitter = 0.08, usePhysics = true,
} = {}) {
  const specs = models || [{ model, texture, textureDir, flipY, targetHeight, animations, retargetFrom }];
  const bases = [];
  for (const s of specs) {
    try {
      const base = await loadCharacter(s.model, {
        texture: s.texture ?? null, textureDir: s.textureDir ?? "", flipY: s.flipY ?? true,
        targetHeight: s.targetHeight ?? targetHeight, animations: s.animations ?? animations,
        retargetFrom: s.retargetFrom ?? null,
      });
      const clips = base.animator.clips;
      const names = Object.keys(clips);
      base._walk = clips.walk ? "walk" : (names.find((n) => /walk/i.test(n)) || names[0]);
      base._idle = clips.idle ? "idle" : (names.find((n) => /idle/i.test(n)) || base._walk);
      base._run = clips.run ? "run" : (names.find((n) => /run/i.test(n)) || base._walk);
      bases.push(base);
    } catch (e) { console.warn("[npc] base failed:", s.model, e.message); }
  }
  if (!bases.length) return [];

  const made = [];
  for (const c of clusters) {
    for (let i = 0; i < (c.count || 0); i++) {
      const base = bases[Math.floor(Math.random() * bases.length)];
      const visual = skeletonClone(base.visual);
      const s = 1 + (Math.random() * 2 - 1) * scaleJitter;
      visual.scale.multiplyScalar(s);
      visual.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = true; } });
      const anim = new Animator(visual, base.animator.clips);

      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (c.radius || 16);
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      const h = heightAt(x, z);
      const e = world.spawn("npc")
        .at(x, (h > -Infinity ? h : 0) + footOffset, z)
        .mesh(visual)
        .add(anim);
      // SOLID physics body — a Rapier capsule so the NPC collides with walls, cars, the
      // player + each other (no more clipping through). CharacterBody finds Physics itself.
      if (usePhysics) e.add(new CharacterBody({ radius: 0.28, height: 1.7, massKg: 70 }));
      e.add(new Pedestrian({
        heightAt, center: { x: c.x, z: c.z }, radius: c.radius || 16,
        speed: 1.0 + Math.random() * 0.7, clips: { walk: base._walk, idle: base._idle, run: base._run }, footOffset,
      }));
      // desync the crowd — advance each mixer a random beat so they don't lockstep
      anim.play(base._walk); anim.update(Math.random() * 1.8);
      made.push(e);
    }
  }
  return made;
}

import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Animator } from "./animation.js";
import { loadCharacter } from "./character.js";
import { CharacterBody } from "./phys.js";
import { Ragdoll } from "./ragdoll.js";

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
  constructor({ heightAt, center, radius = 18, speed = 1.2, clips = { walk: "walk", idle: "idle" }, footOffset = 0, phys = null, bones = null }) {
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
    this.state = "stroll";         // stroll | idle | flee | ragdoll (car-hit)
    this.fleeFrom = null; this.fleeT = 0;
    this.yaw = Math.random() * Math.PI * 2;
    this.phys = phys; this.bones = bones; this.rag = null; this._downT = 0;   // car-hit ragdoll
  }

  /** a fast car right on top of me? → return its velocity so I get launched by it. */
  _carHit(p) {
    const pf = (typeof window !== "undefined") && window.__pf;
    if (!pf) return null;
    for (const car of pf.cars || []) {
      const vb = car.components && car.components.find((c) => c.rb && c.velocity);
      if (!vb) continue;
      const sp = vb.velocity.length ? vb.velocity.length() : 0;
      if (sp < 5) continue;
      const cp = car.position;
      if (Math.abs(cp.y - p.y) > 2) continue;
      if ((cp.x - p.x) ** 2 + (cp.z - p.z) ** 2 < 3.2 * 3.2) return vb.velocity;
    }
    return null;
  }

  /** get hit by a car → drop the (kinematic) capsule so it stops brick-walling the car, and
   * launch a real physics ragdoll off the hood (reuses the same Ragdoll that throws the player). */
  _enterRagdoll(carVel, entity) {
    if (!this.rag) this.rag = new Ragdoll(this.bones, this.phys, { tone: 1.4 });
    const chest = entity.position.clone(); chest.y += 1.1;
    this.rag.enter(carVel.clone().multiplyScalar(0.85).add(new THREE.Vector3(0, 2.5, 0)),
      carVel.clone().multiplyScalar(11), chest);
    if (this.body) this.body.setEnabled(false);          // capsule off → no more brick wall
    this.state = "ragdoll"; this._downT = 0;
    const pf = (typeof window !== "undefined") && window.__pf;
    pf && pf.audio && pf.audio.playSfx && pf.audio.playSfx("thud_body", { volume: 0.9 });
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
    // PANIC CONTAGION: a neighbor is already fleeing → catch it and run from THEIR danger,
    // so one shot clears the block (the panic ripples outward through the crowd).
    for (const other of (typeof window !== "undefined" && window.__pfNpcs) || []) {
      const op = other.components && other.components.find((c) => c !== this && c.state === "flee" && c.fleeFrom);
      if (op && Math.hypot(p.x - other.position.x, p.z - other.position.z) < 8) return op.fleeFrom;
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
    const pf = (typeof window !== "undefined") && window.__pf;
    // ~40%: head somewhere PURPOSEFUL — a spot beside a nearby road (walk the sidewalk),
    // so they traverse the streets instead of circling one patch (the "living city" feel).
    if (pf && pf.roadGraph && Math.random() < 0.4) {
      const rg = pf.roadGraph;
      const sx = this.center.x + (Math.random() * 2 - 1) * this.radius * 2.2;
      const sz = this.center.z + (Math.random() * 2 - 1) * this.radius * 2.2;
      const n = rg.nearestOnRoad(sx, sz);
      if (n && n.point && n.tangent) {
        const [tx, tz] = n.tangent, w = (rg.roads[n.roadId]?.width ?? 6) * 0.5 + 1.6;
        const side = (Math.random() < 0.5 ? 1 : -1) * w;                 // offset to the sidewalk, not the lane
        this.target = { x: n.point[0] + tz * side, z: n.point[1] - tx * side };
        return;
      }
    }
    // else: local wander, occasionally a longer stroll so they cover ground
    const reach = this.radius * (Math.random() < 0.25 ? 2.2 : 1);
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * reach;
    this.target = { x: this.center.x + Math.cos(a) * d, z: this.center.z + Math.sin(a) * d };
  }

  _clamp(p) {
    const h = this.heightAt(p.x, p.z);
    if (h > -Infinity) p.y = h + this.footOffset;
  }

  _drive(nx, nz) {                          // set horizontal velocity (capsule) or move directly
    if (this.body) { this.body.velocity.x = nx * this.speed; this.body.velocity.z = nz * this.speed; }
  }

  fixedUpdate(dt) {                         // run the car-hit ragdoll's PD muscles at 60Hz
    if (this.state === "ragdoll" && this.rag && this.rag.active) this.rag.fixedUpdate(dt);
  }

  update(dt, { entity }) {
    const anim = entity.get(Animator);
    const p = entity.position;

    // ── CAR-HIT RAGDOLL: launched off the hood, tumble, then pick myself back up ──
    if (this.state === "ragdoll") {
      if (this.rag) {
        this.rag.update();                              // physics bodies → visual bones
        const pv = this.rag.pelvisPos();
        p.set(pv.x, Math.max(this.heightAt(pv.x, pv.z) - 0.2, pv.y - 0.9), pv.z);   // follow the flying body
        this._downT += dt;
        if (this._downT > 1.0 && this.rag.settled(0.8)) {                            // settled → get up
          this.rag.exit();
          const pv2 = this.rag.pelvisPos();
          p.set(pv2.x, this.heightAt(pv2.x, pv2.z) + this.footOffset, pv2.z);
          if (this.body) { this.body.setEnabled(true); this.body.velocity.set(0, 0, 0); }
          this.state = "stroll"; this._pick(); this.pauseT = 0.6;
        }
      }
      return;
    }
    // a fast car on top of me → ragdoll (drops the capsule so it stops brick-walling the car)
    if (this.phys && this.bones) { const carVel = this._carHit(p); if (carVel) { this._enterRagdoll(carVel, entity); return; } }

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
  heightAt, clusters = [], footOffset = 0, scaleJitter = 0.08, usePhysics = true, phys = null,
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
      // this clone's own bones → a car-hit ragdoll can throw it (per-NPC, built on first hit)
      const bones = {}; visual.traverse((o) => { if (o.isBone && !bones[o.name]) bones[o.name] = o; });
      e.add(new Pedestrian({
        heightAt, center: { x: c.x, z: c.z }, radius: c.radius || 16,
        speed: 1.0 + Math.random() * 0.7, clips: { walk: base._walk, idle: base._idle, run: base._run }, footOffset,
        phys: usePhysics ? phys : null, bones,
      }));
      // desync the crowd — advance each mixer a random beat so they don't lockstep
      anim.play(base._walk); anim.update(Math.random() * 1.8);
      made.push(e);
    }
  }
  return made;
}

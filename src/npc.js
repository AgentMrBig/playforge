import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Animator } from "./animation.js";
import { loadCharacter } from "./character.js";

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
    this.footOffset = footOffset;
    this.target = null;
    this.pauseT = 0;
    this.yaw = Math.random() * Math.PI * 2;
  }

  init(entity) { this._entity = entity; this._pick(); this._clamp(entity.position); }

  _pick() {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * this.radius;
    this.target = { x: this.center.x + Math.cos(a) * d, z: this.center.z + Math.sin(a) * d };
  }

  _clamp(p) {
    const h = this.heightAt(p.x, p.z);
    if (h > -Infinity) p.y = h + this.footOffset;
  }

  update(dt, { entity }) {
    const anim = entity.get(Animator);
    const p = entity.position;

    if (this.pauseT > 0) {
      this.pauseT -= dt;
      anim?.play(this.clipIdle, { fade: 0.3 });
      this._faceTo(entity, this.yaw, dt);
      this._clamp(p);
      return;
    }

    const dx = this.target.x - p.x, dz = this.target.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.6) {                       // arrived — stand a beat, then re-roam
      this.pauseT = 1.5 + Math.random() * 3.5;
      this._pick();
      return;
    }
    const nx = dx / dist, nz = dz / dist;
    p.x += nx * this.speed * dt;
    p.z += nz * this.speed * dt;
    this._clamp(p);
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

/** Load one base character and scatter cloned wanderers across the clusters. */
export async function spawnPedestrians(world, {
  model, texture = null, textureDir = "", flipY = true, targetHeight = 1.8,
  animations = null, heightAt, clusters = [], footOffset = 0, scaleJitter = 0.08,
} = {}) {
  const base = await loadCharacter(model, { texture, textureDir, flipY, targetHeight, animations });
  const clips = base.animator.clips;
  const names = Object.keys(clips);
  const walk = clips.walk ? "walk" : (names.find((n) => /walk/i.test(n)) || names[0]);
  const idle = clips.idle ? "idle" : (names.find((n) => /idle/i.test(n)) || walk);

  const made = [];
  for (const c of clusters) {
    for (let i = 0; i < (c.count || 0); i++) {
      const visual = skeletonClone(base.visual);
      const s = 1 + (Math.random() * 2 - 1) * scaleJitter;
      visual.scale.multiplyScalar(s);
      visual.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = true; } });
      const anim = new Animator(visual, clips);

      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (c.radius || 16);
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      const h = heightAt(x, z);
      const e = world.spawn("npc")
        .at(x, (h > -Infinity ? h : 0) + footOffset, z)
        .mesh(visual)
        .add(anim)
        .add(new Pedestrian({
          heightAt, center: { x: c.x, z: c.z }, radius: c.radius || 16,
          speed: 1.0 + Math.random() * 0.7, clips: { walk, idle }, footOffset,
        }));
      // desync the crowd — advance each mixer a random beat so they don't lockstep
      anim.play(walk); anim.update(Math.random() * 1.8);
      made.push(e);
    }
  }
  return made;
}

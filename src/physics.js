import * as THREE from "three";

/**
 * Physics — deliberately game-flavored, not a rigid-body sim:
 * AABB bodies vs static AABB colliders, per-axis resolution (the scheme that
 * shipped Lumencraft), gravity, ground flags, triggers, and raycasts.
 *
 *   world.spawn("floor").add(new Collider({ size: [20, 1, 20] }));
 *   world.spawn("player")
 *     .add(new Body({ size: [0.6, 1.8, 0.6], gravity: 24 }))
 *     .add(new PlayerMove());
 *
 * A Body moves via `body.velocity`; Collider entities are static walls/floors.
 * Trigger colliders don't block — they fire `onEnter(other)` / `onExit(other)`.
 */

export class Collider {
  constructor({ size = [1, 1, 1], offset = [0, 0, 0], trigger = false, onEnter = null, onExit = null } = {}) {
    this.size = new THREE.Vector3(...size);
    this.offset = new THREE.Vector3(...offset);
    this.trigger = trigger;
    this.onEnter = onEnter; this.onExit = onExit;
    this._inside = new Set();
  }
  /** world-space AABB (center ± half size) */
  aabb(out = new THREE.Box3()) {
    const c = this.entity.position.clone().add(this.offset);
    out.min.copy(c).addScaledVector(this.size, -0.5);
    out.max.copy(c).addScaledVector(this.size, 0.5);
    return out;
  }
}

export class Body {
  constructor({ size = [1, 1, 1], offset = [0, 0, 0], gravity = 24, maxFall = 55, bounce = 0 } = {}) {
    this.size = new THREE.Vector3(...size);
    this.offset = new THREE.Vector3(...offset);
    this.gravity = gravity;
    this.maxFall = maxFall;
    this.bounce = bounce;
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this._box = new THREE.Box3();
    this._other = new THREE.Box3();
  }

  fixedUpdate(dt, { world, entity }) {
    this.velocity.y = Math.max(this.velocity.y - this.gravity * dt, -this.maxFall);
    const colliders = collectColliders(world, entity);
    this.onGround = false;
    for (const axis of [0, 2, 1]) {           // x, z, then y (stable stair-steps)
      const d = this.velocity.getComponent(axis) * dt;
      if (d === 0) continue;
      entity.position.setComponent(axis, entity.position.getComponent(axis) + d);
      this._resolve(axis, entity, colliders);
    }
    // heightfield terrain: clamp the body's feet to the ground surface
    for (const e of world.entities) {
      for (const c of e.components) {
        if (typeof c.heightAt !== "function" || typeof c.slopeAt !== "function") continue;
        const bottom = entity.position.y + this.offset.y - this.size.y * 0.5;
        const h = c.heightAt(entity.position.x, entity.position.z);
        if (h !== -Infinity && bottom <= h + 0.02) {
          entity.position.y = h + this.size.y * 0.5 - this.offset.y + 0.001;
          if (this.velocity.y < 0) this.velocity.y = 0;
          this.onGround = true;
        }
      }
    }
    this._fireTriggers(world, entity);
  }

  _bodyBox(entity) {
    const c = entity.position.clone().add(this.offset);
    this._box.min.copy(c).addScaledVector(this.size, -0.5);
    this._box.max.copy(c).addScaledVector(this.size, 0.5);
    return this._box;
  }

  _resolve(axis, entity, colliders) {
    const box = this._bodyBox(entity);
    for (const col of colliders) {
      if (col.trigger) continue;
      const other = col.aabb(this._other);
      if (!box.intersectsBox(other)) continue;
      // low obstacle in the walk path? step up onto it (curbs, low slabs)
      if (axis !== 1) {
        const step = other.max.y - box.min.y;
        if (step > 0 && step <= 0.4) {
          entity.position.y += step + 0.001;
          this._bodyBox(entity);
          continue;
        }
      }
      const v = this.velocity.getComponent(axis);
      const half = this.size.getComponent(axis) * 0.5;
      const off = this.offset.getComponent(axis);
      let p;
      if (v > 0) p = other.min.getComponent(axis) - half - off - 1e-4;
      else       p = other.max.getComponent(axis) + half - off + 1e-4;
      entity.position.setComponent(axis, p);
      if (axis === 1 && v < 0) this.onGround = true;
      this.velocity.setComponent(axis, this.bounce ? -v * this.bounce : 0);
      this._bodyBox(entity); // refresh for the next collider
    }
  }

  _fireTriggers(world, entity) {
    const box = this._bodyBox(entity);
    for (const e of world.entities) {
      for (const col of e.components) {
        if (!(col instanceof Collider) || !col.trigger || e === entity) continue;
        const hit = box.intersectsBox(col.aabb(col._tmp ??= new THREE.Box3()));
        const was = col._inside.has(entity);
        if (hit && !was) { col._inside.add(entity); col.onEnter?.(entity, e); }
        else if (!hit && was) { col._inside.delete(entity); col.onExit?.(entity, e); }
      }
    }
  }
}

function collectColliders(world, self) {
  const out = [];
  for (const e of world.entities) {
    if (e === self) continue;
    for (const c of e.components) if (c instanceof Collider) { c.entity = e; out.push(c); }
  }
  return out;
}

/**
 * Raycast against Colliders (not meshes — game logic, not rendering).
 * Returns { entity, collider, point, distance } or null.
 */
export function raycast(world, origin, dir, maxDist = 100) {
  const ray = new THREE.Ray(origin, dir.clone().normalize());
  const box = new THREE.Box3();
  const hit = new THREE.Vector3();
  let best = null;
  for (const e of world.entities) {
    for (const c of e.components) {
      if (!(c instanceof Collider)) continue;
      c.entity = e;
      if (!ray.intersectBox(c.aabb(box), hit)) continue;
      const d = origin.distanceTo(hit);
      if (d <= maxDist && (!best || d < best.distance))
        best = { entity: e, collider: c, point: hit.clone(), distance: d };
    }
  }
  return best;
}

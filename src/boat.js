import * as THREE from "three";
import { R, Physics } from "./phys.js";

/**
 * BoatModel — a boat that FLOATS on real buoyancy (Ember, Erik 2026-07-21: water →
 * "so we can have boats in it"). A Rapier dynamic hull held up by Archimedes, not
 * a scripted bob:
 *   • buoyancy sampled at hull points — each submerged point pushes UP ∝ its depth
 *     under the wave surface (window.__pfWater.getHeight), applied AT the point so
 *     the boat pitches/rolls with the swell and self-rights
 *   • world gravity pulls down; the two balance at a real waterline
 *   • propulsion: throttle → forward thrust, steer → yaw (only bites in water)
 *   • heavy water drag (linear + angular) so it glides to a stop like a boat
 * Uses engine.time for the wave phase so physics matches what the water renders.
 * Live-tune via window.__pfBoat. Controls set by BoatControls (throttle, steer).
 */
export class BoatModel {
  constructor(o = {}) {
    Object.assign(this, {
      mass: 420,             // kg (weight ≈ 8400 N under the game's 2× gravity)
      half: [1.4, 0.7, 3.2], // hull half-extents [w, h, L]
      buoyK: 13000,          // up-force per metre of submersion, per hull point —
                             // tuned so weight (mass·20) balances at ~waterline
      maxDepth: 1.4,         // clamp so a deep dunk doesn't rocket it out
      vDamp: 1100,           // vertical bounce damping (N per m/s)
      maxThrust: 3600,       // N forward at full throttle (tops out ~16 m/s vs drag)
      steerTorque: 5200,     // N·m yaw at full steer
      linDrag: 14,           // horizontal water drag (∝ speed·velocity)
      seaY: 0,
    }, o);
    this.throttle = 0; this.steer = 0; this.speed = 0;
    this.rb = null; this.phys = null; this.col = null; this._entity = null;
    this._q = new THREE.Quaternion(); this._v = new THREE.Vector3();
    // 4 hull-bottom corners + bow + stern, in body space — the buoyancy probes
    const [w, h, L] = this.half;
    this.probes = [
      [-w * 0.8, -h, L * 0.85], [w * 0.8, -h, L * 0.85],
      [-w * 0.8, -h, -L * 0.85], [w * 0.8, -h, -L * 0.85],
      [0, -h, L * 0.98], [0, -h, -L * 0.98],
    ];
  }

  init(entity, world) {
    this._entity = entity;
    for (const e of world.entities) for (const c of e.components) if (c instanceof Physics) this.phys = c;
    if (this.phys?.world) this._create(entity);
  }
  fixedUpdate(dt, { world }) {
    if (!this.phys) for (const e of world.entities) for (const c of e.components) if (c instanceof Physics) this.phys = c;
    if (!this.rb && this.phys?.world) this._create(this._entity);
  }

  _create(entity) {
    const P = this.phys, p = entity.position, h = this.half;
    this.rb = P.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
        .setLinearDamping(0.35).setAngularDamping(1.4).setCanSleep(false));
    this.rb.setAdditionalMass(this.mass, true);
    this.col = P.world.createCollider(
      R.ColliderDesc.cuboid(h[0], h[1], h[2]).setFriction(0.4).setRestitution(0.0), this.rb);
    P._handleEnt.set(this.col.handle, entity);
    this._preHook = (dt) => this._float(dt);
    this._postHook = () => this._sync(entity);
    P._pre.push(this._preHook); P._post.push(this._postHook);
    if (typeof window !== "undefined") window.__pfBoat = this;
  }

  _waterY(x, z, t) {
    const w = typeof window !== "undefined" ? window.__pfWater : null;
    return this.seaY + (w?.getHeight ? w.getHeight(x, z, t) : 0);
  }

  _float(dt) {
    const rb = this.rb; if (!rb) return;
    const t = (typeof window !== "undefined" && window.__pf?.engine) ? window.__pf.engine.time : 0;
    const q = rb.rotation(); this._q.set(q.x, q.y, q.z, q.w);
    const pos = rb.translation();
    const lv = rb.linvel(); this._v.set(lv.x, lv.y, lv.z);
    const speed = this._v.length(); this.speed = speed;

    // BUOYANCY — each submerged probe pushes up ∝ depth, applied at the point
    let anySub = false;
    const per = 1 / this.probes.length;
    for (const bp of this.probes) {
      const wp = new THREE.Vector3(bp[0], bp[1], bp[2]).applyQuaternion(this._q).add(pos);
      const depth = this._waterY(wp.x, wp.z, t) - wp.y;
      if (depth > 0) {
        anySub = true;
        const f = this.buoyK * Math.min(depth, this.maxDepth) * per;
        rb.applyImpulseAtPoint({ x: 0, y: f * dt, z: 0 }, { x: wp.x, y: wp.y, z: wp.z }, true);
      }
    }
    // vertical bounce damping — kills the spring oscillation of pure buoyancy
    rb.applyImpulse({ x: 0, y: -this._v.y * this.vDamp * dt, z: 0 }, true);

    // PROPULSION — forward thrust along the (horizontal) nose, only in water
    const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(this._q); nose.y = 0;
    if (nose.lengthSq() > 1e-4) nose.normalize();
    if (anySub) {
      const th = this.throttle * this.maxThrust;
      rb.applyImpulse({ x: nose.x * th * dt, y: 0, z: nose.z * th * dt }, true);
      // steer: yaw torque, more bite with speed (rudder needs flow)
      const authority = THREE.MathUtils.clamp(0.35 + speed / 12, 0.35, 1.6);
      rb.applyTorqueImpulse({ x: 0, y: -this.steer * this.steerTorque * authority * dt, z: 0 }, true);
    }

    // WATER DRAG — quadratic horizontal drag so it coasts to a stop
    const dragS = this.linDrag * speed;
    rb.applyImpulse({ x: -this._v.x * dragS * dt, y: 0, z: -this._v.z * dragS * dt }, true);
  }

  _sync(entity) {
    if (!this.rb) return;
    const t = this.rb.translation(), q = this.rb.rotation();
    entity.object3d.position.set(t.x, t.y, t.z);
    entity.object3d.quaternion.set(q.x, q.y, q.z, q.w);
  }

  /** drop the boat at (x,y,z) facing yaw, at rest — for spawn/recover */
  place(x, y, z, yaw = 0) {
    if (!this.rb) return;
    this.rb.setTranslation({ x, y, z }, true);
    this.rb.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), true);
    this.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.throttle = 0; this.steer = 0;
  }

  dispose() {
    if (this.phys) {
      this.phys._pre = this.phys._pre.filter((h) => h !== this._preHook);
      this.phys._post = this.phys._post.filter((h) => h !== this._postHook);
      if (this.rb) this.phys.world.removeRigidBody(this.rb);
    }
  }
}

/**
 * BoatControls — reads input → boat throttle/steer (mirrors PlaneControls). Only
 * drives while active(). W/S throttle (reverse below 0), A/D steer.
 */
export class BoatControls {
  constructor(boat, active = () => true) { this.boat = boat; this.active = active; }
  fixedUpdate(dt, { input }) {
    const b = this.boat; if (!b) return;
    if (!this.active()) { b.throttle *= 0.9; b.steer = 0; return; }
    b.throttle = THREE.MathUtils.clamp(input.axis("KeyS", "KeyW"), -0.6, 1);  // W fwd, S reverse
    b.steer = input.axis("KeyA", "KeyD");                                     // D = turn right
  }
}

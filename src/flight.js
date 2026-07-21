import * as THREE from "three";
import { R, Physics } from "./phys.js";

/**
 * FlightModel — arcade-but-real flight physics (Ember, Erik 2026-07-20: planes +
 * jets + dogfights). A Rapier DYNAMIC body flown by aerodynamic forces, NOT
 * scripted motion:
 *   • THRUST along the nose (throttle → force)
 *   • LIFT up in the body frame, ∝ forward-speed² and fading below stall speed —
 *     so you need airspeed to fly, and rolling banks the lift vector to TURN
 *   • DRAG opposing velocity (quadratic) → bounded top speed, glide when idle
 *   • world gravity (Rapier applies it)
 *   • control surfaces: pitch/roll/yaw torque, more authority with airspeed
 * Model-agnostic: attach to any entity; rig a real plane mesh on later. Control
 * inputs are set by PlaneControls (throttle 0..1, pitch/roll/yaw -1..1). Live-tune
 * knobs via window.__pfPlane / the tuning UI.
 */
export class FlightModel {
  constructor(o = {}) {
    Object.assign(this, {
      // NOTE: world gravity is -20 (2× real), so weight = mass·20 = 18000 N —
      // lift must reach that at cruise. liftCoef≈9 gives lift≈weight near ~45 m/s.
      mass: 900,             // kg  (weight ≈ 18000 N under the game's 2× gravity)
      maxThrust: 22000,      // N at full throttle (→ top speed ~60 m/s vs drag)
      liftCoef: 9,           // lift = liftCoef · fwdSpeed² · stallFade
      maxLift: 46000,        // N clamp (don't rocket off a bump)
      dragCoef: 5.5,         // drag = dragCoef · speed · velocity
      stallSpeed: 26,        // m/s below which lift fades (need speed to fly)
      pitchTorque: 15000, rollTorque: 50000, yawTorque: 15000,   // pitch toned down — Erik could nearly flip at 24000
      stabilize: 1600,       // YAW-only weathervane: vertical tail tracks heading into the airflow (no pitch auto-level)
      halfExtents: [3.4, 0.5, 3.2],   // collider box (placeholder plane)
    }, o);
    this.throttle = 0; this.pitchIn = 0; this.rollIn = 0; this.yawIn = 0;
    this.speed = 0; this.airborne = false;
    this.rb = null; this.phys = null; this.col = null;
    this._q = new THREE.Quaternion();
    this._nose = new THREE.Vector3(); this._up = new THREE.Vector3(); this._v = new THREE.Vector3();
  }

  init(entity, world) {
    this._entity = entity;
    for (const e of world.entities) for (const c of e.components) if (c instanceof Physics) this.phys = c;
    if (this.phys?.world) this._create(entity);
  }
  fixedUpdate(dt, { world }) {                    // retry create until physics WASM is up
    if (!this.phys) for (const e of world.entities) for (const c of e.components) if (c instanceof Physics) this.phys = c;
    if (!this.rb && this.phys?.world) this._create(this._entity);
    if (this._pendingHull && this.rb) { const p = this._pendingHull; this._pendingHull = null; this._applyHull(p); }
  }

  /** swap the placeholder box for an accurate convex hull built from the real
   *  jet mesh (Erik: "match the jet's actual shape"). Queued until the body exists. */
  setHullFromPoints(points) {
    if (this.rb) this._applyHull(points); else this._pendingHull = points;
  }
  _applyHull(points) {
    const P = this.phys; if (!P || !this.rb) return;
    const desc = R.ColliderDesc.convexHull(points);
    if (!desc) return;                       // hull failed → keep the box, no harm
    desc.setFriction(0.05).setRestitution(0.0).setDensity(0);   // shape only, contributes no mass
    if (this.col) { P._handleEnt.delete(this.col.handle); P.world.removeCollider(this.col, false); }
    this.col = P.world.createCollider(desc, this.rb);
    P._handleEnt.set(this.col.handle, this._entity);
    // preserve the tuned FEEL: lock mass + inertia to the original box's values so
    // the accurate collision shape does NOT change how it flies (Erik just tuned it).
    const [hx, hy, hz] = this.halfExtents, m = this.mass;
    const X = hx * 2, Y = hy * 2, Z = hz * 2;
    const Ix = m / 12 * (Y * Y + Z * Z), Iy = m / 12 * (X * X + Z * Z), Iz = m / 12 * (X * X + Y * Y);
    this.rb.setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, { x: Ix, y: Iy, z: Iz }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  _create(entity) {
    const P = this.phys, p = entity.position;
    this.rb = P.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
        .setLinearDamping(0.02).setAngularDamping(2.6).setCanSleep(false));
    this.rb.setAdditionalMass(this.mass, true);
    const h = this.halfExtents;
    // low friction + no bounce → the box "rolls" down the runway like wheels
    // (friction 0.5 grabbed the ground and made it tumble on takeoff roll)
    this.col = P.world.createCollider(
      R.ColliderDesc.cuboid(h[0], h[1], h[2]).setFriction(0.05).setRestitution(0.0), this.rb);
    P._handleEnt.set(this.col.handle, entity);
    this._preHook = (dt) => this._fly(dt);
    this._postHook = () => this._sync(entity);
    P._pre.push(this._preHook); P._post.push(this._postHook);
    if (typeof window !== "undefined") window.__pfPlane = this;
  }

  _fly(dt) {
    const rb = this.rb; if (!rb) return;
    const q = rb.rotation(); this._q.set(q.x, q.y, q.z, q.w);
    this._nose.set(0, 0, -1).applyQuaternion(this._q);        // three.js forward = -Z
    this._up.set(0, 1, 0).applyQuaternion(this._q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this._q);
    const lv = rb.linvel(); this._v.set(lv.x, lv.y, lv.z);
    const speed = this._v.length();
    const fwd = this._v.dot(this._nose);                      // airspeed along the nose
    this.speed = speed; this.airborne = !this._grounded();

    // THRUST
    const th = this.throttle * this.maxThrust;
    // LIFT — up in body frame, ∝ fwd², fades below stall (need speed to stay up)
    const stallFade = THREE.MathUtils.clamp(fwd / this.stallSpeed, 0, 1);
    const liftMag = Math.min(this.liftCoef * Math.max(0, fwd) * fwd * stallFade, this.maxLift);
    // DRAG — quadratic, opposes velocity
    const dragS = this.dragCoef * speed;
    const fx = this._nose.x * th + this._up.x * liftMag - this._v.x * dragS;
    const fy = this._nose.y * th + this._up.y * liftMag - this._v.y * dragS;
    const fz = this._nose.z * th + this._up.z * liftMag - this._v.z * dragS;
    rb.applyImpulse({ x: fx * dt, y: fy * dt, z: fz * dt }, true);

    // PASSIVE STABILITY — weathervane, YAW ONLY. A real vertical tail keeps the
    // nose tracking the airflow HORIZONTALLY (and steadies the takeoff roll), but
    // it must NOT auto-level pitch — a full-axis weathervane makes the plane fly
    // itself and fight the pilot (Erik: "tap W and it takes off + flies forever,
    // you can't actually fly it"). Pitch is now 100% the pilot's: pull back and it
    // STAYS there; manage your airspeed or you'll stall and drop. No autopilot.
    if (speed > 1.5) {
      const vdx = this._v.x / speed, vdy = this._v.y / speed, vdz = this._v.z / speed;
      const sx = this._nose.y * vdz - this._nose.z * vdy;   // nose × velDir (restoring axis)
      const sy = this._nose.z * vdx - this._nose.x * vdz;
      const sz = this._nose.x * vdy - this._nose.y * vdx;
      if (this.airborne) {
        // IN THE AIR: yaw only. Pitch is the pilot's — no auto-level, no autopilot.
        const yaw = sx * this._up.x + sy * this._up.y + sz * this._up.z;
        const k = this.stabilize * speed * dt * yaw;
        rb.applyTorqueImpulse({ x: this._up.x * k, y: this._up.y * k, z: this._up.z * k }, true);
      } else {
        // ON THE GROUND: full weathervane damps the takeoff-roll wobble so it
        // tracks straight and builds speed cleanly (this is what yaw-only alone
        // couldn't hold — the roll pitch/roll-wobbled and scrubbed speed).
        const k = this.stabilize * speed * dt;
        rb.applyTorqueImpulse({ x: sx * k, y: sy * k, z: sz * k }, true);
      }
    }

    // CONTROL torques — more authority with airspeed (control surfaces bite faster)
    const auth = THREE.MathUtils.clamp(0.3 + speed / 45, 0.3, 1.5) * dt;
    const tx = right.x * this.pitchIn * this.pitchTorque - this._nose.x * this.rollIn * this.rollTorque + this._up.x * this.yawIn * this.yawTorque;
    const ty = right.y * this.pitchIn * this.pitchTorque - this._nose.y * this.rollIn * this.rollTorque + this._up.y * this.yawIn * this.yawTorque;
    const tz = right.z * this.pitchIn * this.pitchTorque - this._nose.z * this.rollIn * this.rollTorque + this._up.z * this.yawIn * this.yawTorque;
    rb.applyTorqueImpulse({ x: tx * auth, y: ty * auth, z: tz * auth }, true);
  }

  _grounded() {
    // cheap: near-zero vertical speed + low altitude-above-terrain check via heightAt
    const t = this.rb.translation();
    const gh = (typeof window !== "undefined" && window.__pf?.heightAt) ? window.__pf.heightAt(t.x, t.z) : 0;
    return t.y - gh < this.halfExtents[1] + 0.4;
  }

  _sync(entity) {
    if (!this.rb) return;
    const t = this.rb.translation(), q = this.rb.rotation();
    entity.object3d.position.set(t.x, t.y, t.z);
    entity.object3d.quaternion.set(q.x, q.y, q.z, q.w);
  }

  /** place the plane at (x,y,z) facing yaw, at rest — for spawn/recover */
  place(x, y, z, yaw = 0) {
    if (!this.rb) return;
    this.rb.setTranslation({ x, y, z }, true);
    this.rb.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), true);
    this.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.throttle = 0;
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
 * PlaneControls — reads input → sets the FlightModel's control inputs (mirrors the
 * car's PlayerVehicleControls). Only drives while `active()` (i.e. the player is
 * flying this plane). Controls: W/S throttle, A/D roll, ↑/↓ pitch, Q/E yaw.
 */
export class PlaneControls {
  constructor(flight, active = () => true) { this.flight = flight; this.active = active; }
  fixedUpdate(dt, { input }) {
    const f = this.flight; if (!f) return;
    if (!this.active()) { f.pitchIn = f.rollIn = f.yawIn = 0; return; }
    // throttle lever: W raise, S lower, holds its value
    const dth = (input.down("KeyW") ? 1 : 0) - (input.down("KeyS") ? 1 : 0);
    f.throttle = THREE.MathUtils.clamp(f.throttle + dth * dt * 1.1, 0, 1);   // ~1s to full — responsive but still a lever
    f.pitchIn = input.axis("ArrowUp", "ArrowDown");   // ArrowDown = pull back = nose up
    f.rollIn = input.axis("KeyD", "KeyA");            // A = roll left, D = roll right (Erik: was inverted)
    f.yawIn = input.axis("KeyQ", "KeyE");             // E = yaw right
  }
}

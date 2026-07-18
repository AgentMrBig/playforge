import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { VehicleBody } from "./vehicle.js";

/**
 * Real rigid-body physics under PlayForge — Rapier (WASM).
 *
 * The rule Erik set: the car must collide with EVERYTHING by default, no
 * per-object special cases, no scripted states. So: every solid thing gets a
 * Rapier collider (terrain = trimesh of the actual render mesh, props =
 * boxes/trimeshes), the car is a dynamic rigid body with raycast-suspension
 * wheels, and flips/rolls/launches simply happen from dynamics.
 *
 *   await initRapier();
 *   const phys = new Physics({ gravity: -20 });
 *   world.spawn("physics").add(phys);
 *   phys.addMeshCollider(islandMesh);            // terrain IS the collider
 *   phys.addMeshCollider(rampMesh);              // hit it from any angle
 *   car.add(new RapierVehicle({ suspension: rig.suspension, ... }));
 *
 * RapierVehicle extends VehicleBody so every consumer keeps working:
 * EngineSound (speed/throttle), SkidMarks (sliding/slipRear/onGround),
 * VehicleRig (steer/speed), Ember's damage lane (instanceof + applyImpulse).
 */
export let R = null;
export async function initRapier() {
  if (!R) { await RAPIER.init(); R = RAPIER; }
  return R;
}

export class Physics {
  constructor({ gravity = -20 } = {}) {
    this.gravity = gravity;
    this.world = null;
    this._pre = [];               // hooks run before each step (vehicles)
    this._post = [];              // hooks run after each step (pose sync)
    this._contactCbs = [];
    this._handleEnt = new Map();  // collider handle → entity (for events)
  }

  init() {
    if (!R) throw new Error("call await initRapier() before spawning Physics");
    this.world = new R.World({ x: 0, y: this.gravity, z: 0 });
    this.events = new R.EventQueue(true);
  }

  fixedUpdate(dt) {
    if (!this.world) return;
    this.world.timestep = dt;
    for (const h of this._pre) h(dt);
    this.world.step(this.events);
    for (const h of this._post) h(dt);
    if (this._contactCbs.length) {
      this.events.drainContactForceEvents((ev) => {
        const a = this._handleEnt.get(ev.collider1()) ?? null;
        const b = this._handleEnt.get(ev.collider2()) ?? null;
        const force = ev.totalForceMagnitude();
        for (const cb of this._contactCbs) cb({ entityA: a, entityB: b, force, ev });
      });
    }
  }

  /** Damage/audio seam: cb({entityA, entityB, force}) on every hard contact */
  onContact(cb) { this._contactCbs.push(cb); }

  /**
   * Everything-solid-by-default: bake an Object3D's meshes (world transforms
   * applied) into static trimesh colliders. Terrain, ramps, walls, props —
   * one call, collides forever, from every angle.
   */
  addMeshCollider(obj3d, { friction = 1.0, restitution = 0.05, entity = null } = {}) {
    obj3d.updateWorldMatrix(true, true);
    const made = [];
    obj3d.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position;
      const verts = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
      }
      let idx = o.geometry.index ? new Uint32Array(o.geometry.index.array)
        : new Uint32Array([...Array(pos.count).keys()]);
      const col = this.world.createCollider(
        R.ColliderDesc.trimesh(verts, idx).setFriction(friction).setRestitution(restitution));
      if (entity) this._handleEnt.set(col.handle, entity);
      made.push(col);
    });
    return made;
  }

  /** static box collider (props, walls) — half extents, world center */
  addBox(half, center, { yaw = 0, friction = 1.0, restitution = 0.05, entity = null } = {}) {
    const rb = this.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(center.x ?? center[0], center.y ?? center[1], center.z ?? center[2])
        .setRotation(quatY(yaw)));
    const col = this.world.createCollider(
      R.ColliderDesc.cuboid(half.x ?? half[0], half.y ?? half[1], half.z ?? half[2])
        .setFriction(friction).setRestitution(restitution), rb);
    if (entity) this._handleEnt.set(col.handle, entity);
    return col;
  }

  /** catch-all floor so nothing falls forever (put it under the sea) */
  addGroundPlane(y, size = 6000) {
    return this.addBox([size / 2, 1, size / 2], [0, y - 1, 0], { friction: 0.8 });
  }

  /**
   * Dynamic prop: the entity's visual becomes a real rigid body the cars can
   * plow through (cones, crates, obstacles). CONVENTION: entity.position is
   * the body CENTER, and the visual must be authored centered on the entity
   * origin. (The old auto-shift-children hack put center-origin meshes a
   * half-height below their body — Erik watched the big ball visually ORBIT
   * its physics center and rightly called it fake-looking.)
   */
  addDynamicProp(entity, { half = [0.3, 0.45, 0.3], mass = 4, friction = 0.7, restitution = 0.3, shape = "box" } = {}) {
    const p = entity.position;
    const rb = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
        .setRotation(quatY(entity.rotation?.y ?? 0)).setCanSleep(true));
    const desc = shape === "ball"
      ? R.ColliderDesc.ball(half.r ?? half[0])
      : R.ColliderDesc.cuboid(half[0], half[1], half[2]);
    const col = this.world.createCollider(
      desc.setMass(mass).setFriction(friction).setRestitution(restitution), rb);
    this._handleEnt.set(col.handle, entity);
    this._post.push(() => {
      if (rb.isSleeping()) return;
      const t = rb.translation(), q = rb.rotation();
      entity.object3d.position.set(t.x, t.y, t.z);
      entity.object3d.quaternion.set(q.x, q.y, q.z, q.w);
    });
    return rb;
  }

  removeCollider(col) {
    this._handleEnt.delete(col.handle);
    this.world.removeCollider(col, true);
  }

  dispose() { this.world?.free(); this.world = null; }
}

const quatY = (yaw) => {
  const h = yaw / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
};

/**
 * RapierVehicle — the car as a REAL rigid body + raycast-suspension wheels.
 * Replaces the hand-rolled integrator: collision response, body roll, jumps,
 * flips, rollovers, pile-ups all emerge from the dynamics. No states.
 *
 * Same control surface as VehicleBody: throttle / steerInput / handbrake in,
 * speed / kmh / steer / sliding / slipRear / onGround / velocity out.
 */
export class RapierVehicle extends VehicleBody {
  constructor(opts = {}) {
    super(opts);
    const {
      suspRest = 0.34,        // suspension rest length (m)
      suspStiff = 42,         // spring stiffness (raycast controller units)
      suspComp = 2.6,         // compression damping
      suspRelax = 3.4,        // rebound damping
      frictionSlip = 11.5,    // tire longitudinal traction
      sideFriction = 0.8,     // tire lateral grip multiplier (1.0 = glued)
      steerGrip = 13,         // m/s² lateral-G that full steering may demand
      driftSideFriction = 0.4,// rear lateral grip while handbraking (drift!)
      restitution = 0.25,     // chassis bounciness (that NFS2 elasticity)
      // low damping: a flipping car must KEEP its momentum and tumble
      // (0.7 angular was strangling flips mid-rotation — Erik felt it)
      linDamp = 0.03, angDamp = 0.22,
    } = opts;
    Object.assign(this, {
      suspRest, suspStiff, suspComp, suspRelax, frictionSlip,
      sideFriction, driftSideFriction, restitution, linDamp, angDamp, steerGrip,
    });
    this.rb = null; this.ctrl = null; this.phys = null;
    this._wheelKeys = ["fl", "fr", "rl", "rr"];
    // reverse tops out ~30 mph unless the car spec says otherwise
    this.reverseSpeed = opts.reverseSpeed ?? 13.4;
    this.justLanded = 0;
  }

  init(entity, world) {
    // find the Physics component
    for (const e of world.entities)
      for (const c of e.components)
        if (c instanceof Physics) this.phys = c;
    if (!this.phys?.world) { console.warn("RapierVehicle: no Physics in world"); return; }
    const S = this.suspension;
    const P = this.phys;

    // ---- chassis: dynamic body + cuboid collider -------------------------
    // entity origin = chassis center. The visual (built with origin at
    // ground level) hangs from the entity shifted down by the rest ride
    // height so wheels/body line up with the physics.
    const track = S?.track ?? 1.6, wb = S?.wheelbase ?? this.wheelbase;
    const rad = S?.wheelRadius ?? this.wheelRadius;
    const halfH = 0.52;                                  // chassis half height
    this._restRide = rad + this.suspRest * 0.72 + halfH * 0.35; // ground → chassis center at rest
    const p = entity.position;
    this.rb = P.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + this._restRide + 0.3, p.z)
        .setRotation(quatY(entity.rotation.y))
        .setLinearDamping(this.linDamp).setAngularDamping(this.angDamp)
        .setCcdEnabled(true));
    const col = P.world.createCollider(
      R.ColliderDesc.cuboid(track / 2 + 0.12, halfH, wb / 2 + 0.55)
        .setMass(this.mass)
        .setFriction(0.5).setRestitution(this.restitution)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(this.mass * 2.5), this.rb);
    P._handleEnt.set(col.handle, entity);
    // lower the CoM so it corners flat-ish and doesn't roll over from grip alone
    this.rb.setAdditionalMassProperties(this.mass, { x: 0, y: -halfH * 0.55, z: 0 },
      principalInertia(this.mass, track, halfH * 2, wb), { x: 0, y: 0, z: 0, w: 1 }, true);

    // ---- wheels: raycast suspension at the rig's real corners ------------
    this.ctrl = new R.DynamicRayCastVehicleController(
      this.rb, P.world.broadPhase, P.world.narrowPhase, P.world.bodies, P.world.colliders);
    this.ctrl.indexUpAxis = 1; this.ctrl.setIndexForwardAxis = 2;
    const hardY = -halfH * 0.35;                          // hardpoints low on the chassis
    const corners = S?.corners ?? {
      fl: { ox: track / 2, oz: wb / 2 }, fr: { ox: -track / 2, oz: wb / 2 },
      rl: { ox: track / 2, oz: -wb / 2 }, rr: { ox: -track / 2, oz: -wb / 2 },
    };
    for (const key of this._wheelKeys) {
      const c = corners[key];
      // single-axle rigs (the pack's rear "wheels_b" mesh) report BOTH rear
      // corners at ox=0 — that put both raycast wheels on the centerline
      // (one merged skid mark, rear grip acting at the middle). Spread them
      // to the real half-track.
      let ox = c.ox;
      if (Math.abs(ox) < 0.05) ox = (key.endsWith("l") ? 1 : -1) * track / 2;
      this.ctrl.addWheel(
        { x: ox, y: hardY, z: c.oz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 },
        this.suspRest, rad);
    }
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, this.suspStiff);
      this.ctrl.setWheelSuspensionCompression(i, this.suspComp);
      this.ctrl.setWheelSuspensionRelaxation(i, this.suspRelax);
      this.ctrl.setWheelMaxSuspensionTravel(i, 0.3);
      this.ctrl.setWheelMaxSuspensionForce(i, this.mass * 40);
      this.ctrl.setWheelFrictionSlip(i, this.frictionSlip);
      this.ctrl.setWheelSideFrictionStiffness(i, this.sideFriction);
    }

    // shift the visual so its ground-origin hangs below the chassis center
    if (entity.object3d) {
      for (const child of entity.object3d.children) child.position.y -= this._restRide;
    }

    this._preHook = (dt) => this._drive(dt);
    this._postHook = () => this._sync(entity);
    P._pre.push(this._preHook); P._post.push(this._postHook);
    this._entity = entity;
  }

  // controls → wheel forces, then let the controller integrate suspension
  _drive(dt) {
    if (!this.ctrl) return;
    const t = THREE.MathUtils.clamp(this.throttle, -1, 1);
    const fwdSpeed = this.speed;

    // speed-sensitive steering — full lock only when parking; at speed the
    // wheel angle is capped so full input demands ~steerGrip m/s² lateral,
    // δ_cap = atan(L·a/v²) (how real steering feels: you don't crank 15°
    // at 90 km/h). Input shaping only — the tires still do the physics.
    const v2 = Math.max(fwdSpeed * fwdSpeed, 1);
    const cap = Math.min(this.steerMax, Math.atan(this.wheelbase * this.steerGrip / v2));
    const target = this.steerInput * cap;
    const rate = this.steerSpeed * (this.steerInput === 0 ? 1.6 : 0.65); // ease in, snap back
    const dS = THREE.MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);
    this.steer += dS;
    // + = left, matching PlayForge's convention (verified by real heading
    // delta, NOT rotation.y — euler Y wraps at ±π/2 and lies about yaw)
    this.ctrl.setWheelSteering(0, this.steer);
    this.ctrl.setWheelSteering(1, this.steer);

    // engine on rear wheels; brake vs reverse by current motion
    const F = this.mass * this.enginePower;               // N at standstill
    let engine = 0, brake = 0;
    if (t > 0.01) {
      if (fwdSpeed >= -0.5) engine = t * F * Math.max(0.18, 1 - fwdSpeed / this.topSpeed);
      else brake = this.mass * this.brakePower * 0.9;
    } else if (t < -0.01) {
      if (fwdSpeed > 0.5) brake = -t * this.mass * this.brakePower * 0.9;
      // reverse gear: FULL torque, but the ratio tops out around 30 mph
      // (Erik's spec — punchy backing up, low terminal speed)
      else engine = t * F * Math.max(0, 1 - Math.abs(fwdSpeed) / this.reverseSpeed);
    }
    this.ctrl.setWheelEngineForce(2, engine / 2);
    this.ctrl.setWheelEngineForce(3, engine / 2);
    for (let i = 0; i < 4; i++) this.ctrl.setWheelBrake(i, brake / 4 * 0.016);
    // handbrake: lock rears + collapse their side grip → the tail comes out
    const hb = this.handbrake;
    this.ctrl.setWheelSideFrictionStiffness(2, hb ? this.driftSideFriction : this.sideFriction);
    this.ctrl.setWheelSideFrictionStiffness(3, hb ? this.driftSideFriction : this.sideFriction);
    if (hb) { this.ctrl.setWheelBrake(2, this.mass * 0.011); this.ctrl.setWheelBrake(3, this.mass * 0.011); }

    this.ctrl.updateVehicle(dt);
  }

  // rigid body pose → entity + live state fields for every consumer
  _sync(entity) {
    if (!this.rb) return;
    const t = this.rb.translation(), q = this.rb.rotation();
    entity.object3d.position.set(t.x, t.y, t.z);
    entity.object3d.quaternion.set(q.x, q.y, q.z, q.w);

    const lv = this.rb.linvel();
    const prevVy = this._prevVy ?? 0;
    this._prevVy = lv.y;
    const wasGrounded = this.onGround;
    this.velocity.set(lv.x, lv.y, lv.z);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(entity.object3d.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(entity.object3d.quaternion);
    this.speed = this.velocity.dot(fwd);
    const latV = this.velocity.dot(right);

    let grounded = 0;
    this.wheelContacts = this.wheelContacts ?? {};
    this._wheelKeys.forEach((key, i) => {
      const hit = this.ctrl.wheelIsInContact(i);
      if (hit) grounded++;
      const cp = hit ? this.ctrl.wheelContactPoint(i) : null;
      this.wheelContacts[key] = cp ? { x: cp.x, y: cp.y, z: cp.z } : null;
    });
    this.onGround = grounded >= 2;
    // hard-landing signal (m/s of fall absorbed) — crash audio reads this
    this.justLanded = !wasGrounded && this.onGround && prevVy < -4 ? -prevVy : 0;

    // slip state — from the real velocities, for SkidMarks/audio
    const sa = Math.abs(this.speed);
    this.slipFront = this.slipRear = sa > 1.5 ? Math.atan2(latV, sa) : 0;
    this.sliding = this.onGround &&
      (Math.abs(latV) > 3.2 || (this.handbrake && sa > 3));
    this.wheelspin = this.throttle > 0.85 && sa < this.topSpeed * 0.18 && this.onGround;
    this.upset = false;                                   // no states. ever.

    // wheel visuals: spin/steer/suspension straight from the controller
    const S = this.suspension;
    if (S?.wheels) {
      this._wheelKeys.forEach((key, i) => {
        const w = S.wheels[key];
        if (!w) return;
        const susp = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
        const hard = this.ctrl.wheelChassisConnectionPointCs(i);
        // wheel CENTER in chassis space = hardpoint + suspension travel down;
        // lift into the ground-origin frame the visual rig lives in
        w.position.y = (hard.y - susp + this._restRide) / (S.scale ?? 1);
        w.rotation.x = this.ctrl.wheelRotation(i) ?? 0;
        if (i < 2) w.rotation.y = this.steer * 0.9;
      });
    } else if (this.wheels) {
      this._wheelKeys.forEach((key, i) => {
        const w = this.wheels[key];
        if (!w) return;
        w.rotation.x = this.ctrl.wheelRotation(i) ?? 0;
        if (i < 2) w.rotation.y = this.steer * 0.9;
      });
    }
  }

  fixedUpdate() { /* everything runs through the Physics step hooks */ }

  /** Ember's seam — now a REAL impulse on a real rigid body */
  applyImpulse(impulse, point) {
    this.rb?.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      { x: point.x, y: point.y, z: point.z }, true);
  }

  /** F key — set upright where it lies, at rest (explicit player tool) */
  recover(entity) {
    if (!this.rb) return;
    const t = this.rb.translation();
    const q = this.rb.rotation();
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    this.rb.setTranslation({ x: t.x, y: t.y + 1.2, z: t.z }, true);
    this.rb.setRotation(quatY(yaw), true);
    this.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  dispose() {
    if (this.phys) {
      this.phys._pre = this.phys._pre.filter((h) => h !== this._preHook);
      this.phys._post = this.phys._post.filter((h) => h !== this._postHook);
      if (this.ctrl) this.ctrl.free();
      if (this.rb) this.phys.world.removeRigidBody(this.rb);
    }
  }
}

// rough box inertia for a car-shaped body
function principalInertia(m, w, h, l) {
  return {
    x: m / 12 * (h * h + l * l),
    y: m / 12 * (w * w + l * l),
    z: m / 12 * (w * w + h * h),
  };
}

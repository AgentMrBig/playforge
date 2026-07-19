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
        // IMPACTS only, not sustained contact: a car resting on its side
        // presses the ground hard every step — that's not a crash, and it
        // was looping crash audio + sparks nonstop (Erik). Gate on the
        // bodies' relative speed at the moment of the event.
        const c1 = this.world.getCollider(ev.collider1());
        const c2 = this.world.getCollider(ev.collider2());
        const v1 = c1?.parent()?.linvel() ?? { x: 0, y: 0, z: 0 };
        const v2 = c2?.parent()?.linvel() ?? { x: 0, y: 0, z: 0 };
        const rel = Math.hypot(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
        if (rel < 2.2) return;
        const a = this._handleEnt.get(ev.collider1()) ?? null;
        const b = this._handleEnt.get(ev.collider2()) ?? null;
        const force = ev.totalForceMagnitude();
        // WHERE and from WHAT DIRECTION the hit landed — the damage system
        // deforms only geometry near the real contact, along the real normal
        // (Erik: a frontal hit must not crush the roof or the rear)
        let point = null, normal = null;
        if (c1 && c2) {
          this.world.contactPair(c1, c2, (manifold) => {
            if (manifold.numSolverContacts() > 0) {
              const p = manifold.solverContactPoint(0);
              const n = manifold.normal();
              if (p) point = { x: p.x, y: p.y, z: p.z };
              if (n) normal = { x: n.x, y: n.y, z: n.z };
            }
          });
        }
        for (const cb of this._contactCbs) cb({ entityA: a, entityB: b, force, relSpeed: rel, point, normal, ev });
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
      driftSideFriction = 0.11,// rear grip on handbrake — measured sweep:
                              // 0.12→17° slip, 0.09→32°, 0.07→50°(spin).
                              // 0.11 + halved front steer cap = progressive
                              // tail-out entry instead of a nose-whip
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
    // chassis shape: CONVEX HULL of the actual body mesh — standing on the
    // hood puts your feet ON the hood, not floating on a box (Erik). Falls
    // back to a cuboid only if the rig has no body geometry.
    let shape = null;
    if (S?.hullPoints?.length >= 30) {
      // rig supplied exact visual-space hull points (de-skinned vehicles) —
      // shift into chassis frame, no scene-graph matrices involved
      const pts = new Float32Array(S.hullPoints.length);
      for (let i = 0; i < S.hullPoints.length; i += 3) {
        pts[i] = S.hullPoints[i];
        pts[i + 1] = S.hullPoints[i + 1] - this._restRide;
        pts[i + 2] = S.hullPoints[i + 2];
      }
      shape = R.ColliderDesc.convexHull(pts);
    }
    if (!shape && S?.bodyRoot) {
      const pts = [];
      entity.object3d.updateWorldMatrix(true, true);
      const inv = new THREE.Matrix4().copy(entity.object3d.matrixWorld).invert();
      const v = new THREE.Vector3();
      S.bodyRoot.updateWorldMatrix(true, true);
      S.bodyRoot.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        const pos = o.geometry.attributes.position;
        const stride = Math.max(1, Math.floor(pos.count / 300));
        for (let i = 0; i < pos.count; i += stride) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
          // into chassis frame: the visual still has its ground-origin here,
          // the chassis center sits _restRide above it
          pts.push(v.x, v.y - this._restRide, v.z);
        }
      });
      if (pts.length >= 30) shape = R.ColliderDesc.convexHull(new Float32Array(pts));
    }
    if (!shape) shape = R.ColliderDesc.cuboid(track / 2 + 0.12, halfH, wb / 2 + 0.55);
    const col = P.world.createCollider(
      shape.setMass(this.mass)
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
    let cap = Math.min(this.steerMax, Math.atan(this.wheelbase * this.steerGrip / v2));
    // handbrake pulled: the FRONT must not crank the nose around — Erik saw
    // the front "gaining turn speed" instead of the tail stepping out. Less
    // front steering authority = the rotation has to come from the rear
    // sliding wide, which is what a handbrake actually does.
    if (this.handbrake) cap *= 0.5;
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
    // handbrake: LOCK the rears. Erik's spec (and physics): the handbrake
    // does NOT tighten the turn — it drops rear traction until the slide
    // STARTS, and the car carries on along its momentum while rotating.
    // So: rear side grip falls (not to zero — 0.14 made the front axle
    // pivot the car like a crane), fronts soften slightly (the sliding rear
    // drags them), and CRUCIALLY the momentum keeps ruling because the
    // fronts alone can't bend the path much. Friction params only.
    const hb = this.handbrake;
    // SLIP-BASED rear grip — no recovery timers (Erik: releasing the ebrake
    // must not re-hook mid-slide; the slide is held by throttle/brake).
    // 1) kinetic < static: an axle sliding sideways holds less rubber, and
    //    grip only returns as the slip angle itself decays. Low grip keeps
    //    the slide alive keeps grip low — the hysteresis Erik wants IS this
    //    feedback loop, no clock needed.
    const slipA = Math.abs(this.slipRear ?? 0);
    const kin = 1 - 0.8 * THREE.MathUtils.smoothstep(slipA, 0.06, 0.3);
    // 2) friction circle: longitudinal demand (throttle spin or brake drag)
    //    spends the same contact patch — flooring it mid-slide keeps the
    //    rear loose, lifting off lets it hook back up. Normalized against
    //    the powertrain's own launch force so it bites on genuine saturation
    //    (burnout, panic brake), not on ordinary full-throttle cruising.
    const longDemand = Math.min(1,
      Math.abs(engine) / (this.mass * this.enginePower) * 1.15 +
      brake / (this.mass * this.brakePower) * 0.8);
    const circle = Math.sqrt(Math.max(0.06, 1 - longDemand * longDemand));
    const rearTarget = hb ? this.driftSideFriction : this.sideFriction * kin * circle;
    this._rearGrip = this._rearGrip ?? this.sideFriction;
    if (rearTarget < this._rearGrip) this._rearGrip = rearTarget;             // loss: instant
    // the one time constant left is physical: locked rubber spinning back
    // up to road speed (~0.25s), not a hand-tuned "recovery" clock
    else this._rearGrip = Math.min(rearTarget, this._rearGrip + this.sideFriction * 4 * dt);
    const rearSide = this._rearGrip;
    // FRONT TIRES LET GO IN A SLIDE (Erik x3: "the front miraculously gets
    // its turn speed multiplied"). Measured why: in a slide the front axle
    // becomes the PIVOT — its own lateral velocity is near zero, so rapier's
    // stiffness-based side friction acts as a pivot CONSTRAINT with whatever
    // force it takes (telemetry: yaw wound 0.5 -> 7 rad/s while the front
    // slip stayed under 0.12 rad, so a front-slip fade never engages). The
    // real physics: once the BODY slides across its path, all four contact
    // patches are scrubbing — the front cannot anchor a pivot. Fade front
    // grip on the body slide state, same kinetic curve as the rear.
    const fkin = 1 - 0.8 * THREE.MathUtils.smoothstep(slipA, 0.06, 0.35);
    const frontSide = this.sideFriction * fkin * (hb ? 0.55 : 1);
    this.ctrl.setWheelSideFrictionStiffness(0, frontSide);
    this.ctrl.setWheelSideFrictionStiffness(1, frontSide);
    this.ctrl.setWheelSideFrictionStiffness(2, rearSide);
    this.ctrl.setWheelSideFrictionStiffness(3, rearSide);
    this.ctrl.setWheelFrictionSlip(2, hb ? this.frictionSlip * 0.25 : this.frictionSlip);
    this.ctrl.setWheelFrictionSlip(3, hb ? this.frictionSlip * 0.25 : this.frictionSlip);
    // locked rears DRAG — kinetic friction opposing the velocity is what
    // bleeds speed in a real ebrake slide (broken traction, not a turn boost)
    if (hb) { this.ctrl.setWheelBrake(2, this.mass * 0.013); this.ctrl.setWheelBrake(3, this.mass * 0.013); }

    // Ember's damage lane: wrecked non-round wheels lock solid and drag —
    // no spin, engine force gone, carcass scrubs sideways
    if (this._locked) for (let i = 0; i < 4; i++) if (this._locked[i]) {
      this.ctrl.setWheelEngineForce(i, 0);
      this.ctrl.setWheelBrake(i, this.mass * 0.03);
      this.ctrl.setWheelSideFrictionStiffness(i, (i < 2 ? frontSide : rearSide) * 0.45);
    }

    this.ctrl.updateVehicle(dt);
  }

  /** Ember: lock a wrecked wheel solid (no spin, drags). setWheelLocked(i, false) frees it. */
  setWheelLocked(i, locked = true) {
    (this._locked = this._locked ?? [false, false, false, false])[i] = locked;
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
    // body-frame lateral velocity + yaw rate for the tire-slip model in _drive
    this._latV = latV;
    this._yawRate = this.rb.angvel().y;

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
    // launch is traction-limited (engine force >> rear grip at low speed) —
    // that's a burnout, and burnouts lay rubber
    this.wheelspin = this.throttle > 0.75 && sa < this.topSpeed * 0.2 && this.onGround;
    this.sliding = this.onGround &&
      (Math.abs(latV) > 3.2 || (this.handbrake && sa > 3) || this.wheelspin);
    this.upset = false;                                   // no states. ever.

    // wheel visuals: spin/steer/suspension straight from the controller
    // burnout overspin: the raycast controller spins wheels at ground speed,
    // but a traction-limited launch should VISIBLY overspin the rubber
    this._spinExtra = (this._spinExtra ?? 0) + (this.wheelspin ? 38 * (1 / 60) : 0);
    const S = this.suspension;
    if (S?.boneMode) {
      // skeletal rig (UE/Fab): wheels are BONES — vertical travel is
      // bind-relative in the bone's parent frame; spin/steer compose ON the
      // bind orientation (bone axes aren't identity)
      this._q1 = this._q1 ?? new THREE.Quaternion();
      this._q2 = this._q2 ?? new THREE.Quaternion();
      this._wheelKeys.forEach((key, i) => {
        const w = S.wheels[key], c = S.corners[key];
        if (!w || !c) return;
        const susp = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
        const hard = this.ctrl.wheelChassisConnectionPointCs(i);
        const wantVisY = hard.y - susp + this._restRide;
        w.position[c.upAxis] = c.bindL + (wantVisY - c.bindVisY) / c.gain;
        const spin = (this.ctrl.wheelRotation(i) ?? 0) + (i >= 2 ? this._spinExtra : 0);
        w.quaternion.copy(c.bindQ);
        if (i < 2) w.quaternion.multiply(this._q1.setFromAxisAngle(c.steerAxis, this.steer * 0.9));
        w.quaternion.multiply(this._q2.setFromAxisAngle(c.spinAxis, spin));
      });
    } else if (S?.wheels) {
      this._wheelKeys.forEach((key, i) => {
        const w = S.wheels[key];
        if (!w) return;
        const susp = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
        const hard = this.ctrl.wheelChassisConnectionPointCs(i);
        // wheel CENTER in chassis space = hardpoint + suspension travel down;
        // lift into the ground-origin frame the visual rig lives in
        w.position.y = (hard.y - susp + this._restRide) / (S.scale ?? 1);
        w.rotation.x = (this.ctrl.wheelRotation(i) ?? 0) + (i >= 2 ? this._spinExtra : 0);
        if (i < 2) w.rotation.y = this.steer * 0.9;
      });
    } else if (this.wheels) {
      this._wheelKeys.forEach((key, i) => {
        const w = this.wheels[key];
        if (!w) return;
        w.rotation.x = (this.ctrl.wheelRotation(i) ?? 0) + (i >= 2 ? this._spinExtra : 0);
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
  recover(entity, world) {
    if (!this.rb) return;
    const t = this.rb.translation();
    const q = this.rb.rotation();
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    // place at exact rest ride height — the old +1.2m hop dropped the car
    // two feet and slammed the suspension (Erik: "totally destroying the wheels")
    let groundY = -Infinity;
    if (world) {
      for (const e of world.entities)
        for (const c of e.components)
          if (typeof c.heightAt === "function" && typeof c.slopeAt === "function") {
            const h = c.heightAt(t.x, t.z);
            if (h !== -Infinity && h > groundY) groundY = h;
          }
    }
    if (groundY === -Infinity) groundY = t.y - this._restRide;
    this.rb.setTranslation({ x: t.x, y: groundY + this._restRide + 0.05, z: t.z }, true);
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

/**
 * CharacterBody — the walking player as a REAL physics capsule (Rapier
 * kinematic character controller). Collides with everything: terrain tiles,
 * buildings, cars, props — and shoves dynamic bodies out of the way.
 * Standing policy per Erik: every new character/object gets physics.
 *
 * Drop-in for the old AABB Body in controllers: exposes `velocity` (set x/z
 * to walk, set y to jump) and `onGround`. Entity origin stays at the FEET.
 */
export class CharacterBody {
  constructor({ radius = 0.32, height = 1.7, gravity = -20, massKg = 80 } = {}) {
    Object.assign(this, { radius, height, gravity, massKg });
    this.velocity = new THREE.Vector3();
    this.onGround = true;
    this.phys = null; this.rb = null; this.col = null; this.ctrl = null;
    this._lastSynced = new THREE.Vector3(NaN, NaN, NaN);
  }

  init(entity, world) {
    this._entity = entity;
    for (const e of world.entities)
      for (const c of e.components)
        if (c instanceof Physics) this.phys = c;
    // Physics may still be booting (WASM init) — retry from the update hook
    if (this.phys?.world) this._create(entity);
  }

  _create(entity) {
    const P = this.phys, p = entity.position, half = this.height / 2;
    this.rb = P.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y + half, p.z));
    this.col = P.world.createCollider(
      R.ColliderDesc.capsule(Math.max(0.05, half - this.radius), this.radius), this.rb);
    this.ctrl = P.world.createCharacterController(0.06);
    this.ctrl.enableAutostep(0.5, 0.3, true);           // curbs, stairs
    this.ctrl.enableSnapToGround(0.45);                 // stick on downslopes
    this.ctrl.setApplyImpulsesToDynamicBodies(true);    // shove cones/crates/cars
    P._handleEnt.set(this.col.handle, entity);
    this._lastSynced.copy(p);
    this._preHook = (dt) => this._move(dt);
    P._pre.push(this._preHook);
  }

  fixedUpdate(dt, { world }) {
    // Physics spawns async (WASM boot) — keep looking until it exists
    if (!this.phys) {
      for (const e of world.entities)
        for (const c of e.components)
          if (c instanceof Physics) this.phys = c;
    }
    if (!this.rb && this.phys?.world) this._create(this._entity);
  }

  /** hand control elsewhere (ragdoll owns the body) and back */
  setEnabled(on) {
    this.enabled = on;
    this.col?.setEnabled(on);
    if (on && this.rb) {
      const p = this._entity.position, half = this.height / 2;
      // HARD teleport, not just setNextKinematic: the next _move runs as a
      // _pre hook BEFORE the world step applies the pending translation, so
      // the controller was still colliding from the OLD spot and wrote that
      // back into the entity — the ragdoll get-up "teleport respawn" (Erik)
      this.rb.setTranslation({ x: p.x, y: p.y + half, z: p.z }, true);
      this.rb.setNextKinematicTranslation({ x: p.x, y: p.y + half, z: p.z });
      this._lastSynced.copy(p);
      this.velocity.set(0, 0, 0);
    }
  }

  _move(dt) {
    if (this.enabled === false) return;
    const entity = this._entity, half = this.height / 2;
    // external teleport (exiting a car sets entity.position directly)
    if (entity.position.distanceToSquared(this._lastSynced) > 1) {
      const p = entity.position;
      this.rb.setNextKinematicTranslation({ x: p.x, y: p.y + half, z: p.z });
      this._lastSynced.copy(p);
      this.velocity.y = 0;
      return;
    }
    this.velocity.y += this.gravity * dt;
    // CAR RIDING (Erik): standing on a dynamic body means moving WITH it —
    // the ground under your feet is a moving frame. Carry the platform's
    // velocity at the foot contact (linear + ω×r, so a turning car swings
    // you around too). Without this the capsule stood still in world space
    // while the car rolled out from under it.
    let carX = 0, carY = 0, carZ = 0;
    const g = this._groundRb;
    if (g && this.onGround && g.isEnabled?.() !== false) {
      const gv = g.linvel(), gw = g.angvel(), gt = g.translation();
      const t0 = this.rb.translation();
      const rx = t0.x - gt.x, ry = (t0.y - half) - gt.y, rz = t0.z - gt.z;
      carX = gv.x + gw.y * rz - gw.z * ry;
      carY = gv.y + gw.z * rx - gw.x * rz;
      carZ = gv.z + gw.x * ry - gw.y * rx;
    }
    this._groundRb = null;                          // re-detected below each step
    const desired = {
      x: (this.velocity.x + carX) * dt,
      y: this.velocity.y * dt + Math.max(0, carY) * dt,
      z: (this.velocity.z + carZ) * dt,
    };
    this.ctrl.computeColliderMovement(this.col, desired);
    const mv = this.ctrl.computedMovement();
    const t = this.rb.translation();
    const nx = t.x + mv.x, ny = t.y + mv.y, nz = t.z + mv.z;
    this.rb.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    const wasGrounded = this.onGround;
    const fallVy = this.velocity.y;
    this.onGround = this.ctrl.computedGrounded();
    const justLanded = !wasGrounded && this.onGround && fallVy < -2;
    if (this.onGround && this.velocity.y < 0) this.velocity.y = 0;
    // standing WEIGHT: a kinematic capsule is infinitely heavy to the solver,
    // so a person on a car hood pressed nothing (Erik: "it needs to feel my
    // weight"). Apply his real weight (m·g) to whatever dynamic body he
    // stands on, at his feet — the suspension answers honestly.
    if (this.onGround && this.ctrl.numComputedCollisions) {
      const n = this.ctrl.numComputedCollisions();
      for (let i = 0; i < n; i++) {
        const cc = this.ctrl.computedCollision(i);
        const body = cc?.collider?.parent?.();
        if (!body || body.bodyType() !== 0) continue;      // dynamic bodies only
        const nyr = cc.normal1?.y ?? 0;
        if (Math.abs(nyr) < 0.5) continue;                 // standing contact, not a wall graze
        const foot = cc.witness1 ?? { x: nx, y: ny - half, z: nz };
        // continuous standing weight, plus the full landing momentum m·Δv
        // when he JUMPS onto it — that's the thump you actually feel
        let jy = this.gravity * this.massKg * dt;              // gravity is negative
        if (justLanded) jy += fallVy * this.massKg;
        body.applyImpulseAtPoint({ x: 0, y: jy, z: 0 }, { x: foot.x, y: foot.y, z: foot.z }, true);
        this._groundRb = body;                       // the moving frame we ride next step
      }
    }
    entity.position.set(nx, ny - half, nz);
    this._lastSynced.copy(entity.position);
  }

  dispose() {
    if (this.phys) {
      this.phys._pre = this.phys._pre.filter((h) => h !== this._preHook);
      if (this.ctrl) this.phys.world.removeCharacterController(this.ctrl);
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

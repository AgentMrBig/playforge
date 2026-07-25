import * as THREE from "three";
import { VehicleBody } from "./vehicle.js";
import { Car } from "./carphysics.js";
import { R, Physics } from "./phys.js";

/**
 * CarVehicle — ECS adapter that puts the Garage / proving-ground `Car`
 * (carphysics.js) into the game world.
 *
 * Same control surface as VehicleBody / RapierVehicle so PlayerVehicleControls,
 * EngineSound, SkidMarks, HUD, enter/exit, and recover keep working:
 *   throttle / steerInput / handbrake in
 *   rb / speed / kmh / sliding / onGround / velocity out
 *
 * Physics ownership: Car's body lives in the shared Physics Rapier world;
 * suspension runs in Physics._pre (before step), snapshots in _post.
 */
function quatY(yaw) {
  const h = yaw * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

export class CarVehicle extends VehicleBody {
  constructor(opts = {}) {
    // VehicleBody keeps enginePower/topSpeed for HUD + audio; Car gets real N forces.
    super({
      mass: opts.mass ?? 1200,
      enginePower: opts.enginePower ?? 12,
      topSpeed: opts.topSpeed ?? 50,
      wheelRadius: opts.wheelRadius ?? 0.35,
      suspension: opts.suspension ?? null,
      ...opts,
    });
    this.carOpts = opts.car || {};
    this.car = null;
    this.rb = null;                 // alias → car.body (CarCollisions / HUD / recover)
    this.phys = null;
    this.velocity = new THREE.Vector3();
    this.justLanded = 0;
    this._prevVy = 0;
    this.onGround = true;
    this.sliding = false;
    this.slipRear = 0;
    this.slipFront = 0;
    this.wheelspin = false;
    this.steer = 0;
    this.speed = 0;
    this.kmh = 0;
    this._preHook = null;
    this._postHook = null;
    this._contactHook = null;
    this._entity = null;
  }

  init(entity, world) {
    this._entity = entity;
    for (const e of world.entities)
      for (const c of e.components)
        if (c instanceof Physics) this.phys = c;
    if (!this.phys?.world || !R) {
      console.warn("CarVehicle: Physics / Rapier not ready");
      return;
    }
    const p = entity.position;
    const yaw = entity.rotation.y || 0;
    // Spawn a bit above the marker so suspension can settle (same idea as garage).
    const mass = this.mass;
    const ep = this.enginePower;
    const car = new Car(this.phys.world, R, {
      pos: [p.x, p.y + 1.2, p.z],
      mass,
      // map old fleet "ep" (accel-ish) → proving-ground Newtons; ~12 → 12000
      engineForce: this.carOpts.engineForce ?? Math.round(1000 * ep),
      brakeForce: this.carOpts.brakeForce ?? 10000,
      dragLin: this.carOpts.dragLin ?? Math.max(220, 9000 / Math.max(30, this.topSpeed)),
      wheelRadius: this.wheelRadius,
      ...this.carOpts,
    });
    car.body.setRotation(quatY(yaw), true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car._read(car.currPos, car.currQuat);
    car.prevPos.copy(car.currPos);
    car.prevQuat.copy(car.currQuat);

    this.car = car;
    this.rb = car.body;

    // Visual: Car owns the mesh (placeholders → attachModel). Keep entity Group
    // as the ECS position handle; car.mesh lives in the scene and we mirror it.
    world.scene.add(car.mesh);
    car.mesh.position.copy(car.currPos);
    car.mesh.quaternion.copy(car.currQuat);
    entity.object3d.position.copy(car.currPos);
    entity.object3d.quaternion.copy(car.currQuat);

    // So phys.onContact / CarCollisions can resolve this entity from colliders.
    for (const h of car.colliderHandles) this.phys._handleEnt.set(h, entity);

    this._preHook = (dt) => this._drive(dt);
    this._postHook = () => this._sync(entity);
    this.phys._pre.push(this._preHook);
    this.phys._post.push(this._postHook);

    // Deform through Car.impact (proving-ground path), not legacy vert-push.
    this._contactHook = (ev) => this._onContact(ev, entity);
    this.phys.onContact(this._contactHook);
  }

  /** Swap placeholders for a loadVehicle() rig — same call as garage. */
  attachModel(rig) {
    if (!this.car || !rig) return;
    if (rig.name == null && this._entity?.specName) rig.name = this._entity.specName;
    this.car.attachModel(rig);
    // Prefer the model's measured wheel radius for HUD / skid sizing.
    if (rig.wheelRadius) this.wheelRadius = rig.wheelRadius;
    this.suspension = rig.suspension || this.suspension;
  }

  _drive(dt) {
    const car = this.car; if (!car) return;
    // PlayerVehicleControls writes VehicleBody fields; map into Car.setInput.
    // throttle -1..1: negative = reverse (Car) / brake-ish (old). Separate brake
    // when Space handbrake or S while moving forward.
    let throttle = THREE.MathUtils.clamp(this.throttle, -1, 1);
    let brake = 0;
    if (this.handbrake) brake = 1;
    if (throttle < 0 && this.speed > 1.5) {
      brake = Math.max(brake, -throttle);
      throttle = 0;
    }
    car.setInput({
      throttle,
      steer: THREE.MathUtils.clamp(this.steerInput, -1, 1),
      brake,
      handbrake: !!this.handbrake,
    });
    car.snapshotPrev();
    car.fixedUpdate(dt);
  }

  _sync(entity) {
    const car = this.car; if (!car) return;
    car.snapshotCurr();
    const lv = car.body.linvel();
    this.velocity.set(lv.x, lv.y, lv.z);
    // signed forward speed in chassis space
    const q = car.body.rotation();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
      new THREE.Quaternion(q.x, q.y, q.z, q.w));
    this.speed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.kmh = Math.hypot(lv.x, lv.y, lv.z) * 3.6;
    this.steer = car.steer;
    this.onGround = car.wheels.some((w) => w.grounded);
    const rearSlip = Math.max(
      Math.abs(car.wheels[2]?.slip || 0),
      Math.abs(car.wheels[3]?.slip || 0));
    this.slipRear = rearSlip;
    this.slipFront = Math.max(
      Math.abs(car.wheels[0]?.slip || 0),
      Math.abs(car.wheels[1]?.slip || 0));
    this.sliding = this.onGround && (car.screech > 0.25 || rearSlip > 0.18);
    this.wheelspin = car.wheels.some((w) => w.driven && Math.abs(w.spinRate || 0) > 12);

    // landing thud pulse (bigisland audio reads justLanded)
    const vy = lv.y;
    if (this._prevVy < -4 && vy > this._prevVy && this.onGround)
      this.justLanded = Math.min(20, -this._prevVy);
    this._prevVy = vy;

    // keep entity transform in sync for camera / enter-exit / traffic (pre-interp)
    entity.object3d.position.copy(car.currPos);
    entity.object3d.quaternion.copy(car.currQuat);
  }

  _onContact(ev, entity) {
    const car = this.car; if (!car) return;
    if (ev.entityA !== entity && ev.entityB !== entity) return;
    const dir = ev.normal || { x: 0, y: 0, z: 1 };
    car.impact(ev.point, ev.force, dir);
  }

  update(dt, ctx) {
    const car = this.car; if (!car) return;
    const FIXED = ctx?.engine?.constructor?.FIXED_DT ?? (1 / 60);
    const accum = ctx?.engine?._accum ?? 0;
    const alpha = accum <= 0 ? 0 : accum >= FIXED ? 1 : accum / FIXED;
    if (typeof window !== "undefined" && window.__pfInterp === false) {
      car.mesh.position.copy(car.currPos);
      car.mesh.quaternion.copy(car.currQuat);
    } else {
      car.interpolate(alpha);
    }
    // Mirror onto the entity Group so gameplay code reading entity.position works.
    ctx.entity.object3d.position.copy(car.mesh.position);
    ctx.entity.object3d.quaternion.copy(car.mesh.quaternion);
  }

  applyImpulse(impulse, point) {
    this.car?.body.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      { x: point.x, y: point.y, z: point.z }, true);
  }

  /** F key — upright where it lies (same contract as RapierVehicle.recover). */
  recover(entity, world) {
    const car = this.car; if (!car) return;
    const t = car.body.translation();
    const q = car.body.rotation();
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    let groundY = -Infinity;
    if (world) {
      for (const e of world.entities)
        for (const c of e.components)
          if (typeof c.heightAt === "function") {
            const h = c.heightAt(t.x, t.z);
            if (h !== -Infinity && h > groundY) groundY = h;
          }
    }
    if (groundY === -Infinity) groundY = t.y - 0.9;
    const ride = (car.wheelRadius || 0.35) + (car.suspRest || 0.5) * 0.6 + car.size[1] * 0.35;
    car.body.setTranslation({ x: t.x, y: groundY + ride + 0.05, z: t.z }, true);
    car.body.setRotation(quatY(yaw), true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car._read(car.currPos, car.currQuat);
    car.prevPos.copy(car.currPos);
    car.prevQuat.copy(car.currQuat);
  }

  dispose() {
    if (this.phys) {
      this.phys._pre = this.phys._pre.filter((h) => h !== this._preHook);
      this.phys._post = this.phys._post.filter((h) => h !== this._postHook);
      if (this.car) {
        for (const h of this.car.colliderHandles) this.phys._handleEnt.delete(h);
        try { this.phys.world.removeRigidBody(this.car.body); } catch (_) { /* */ }
      }
    }
    this.car?.mesh?.parent?.remove(this.car.mesh);
    this.car = null; this.rb = null;
  }
}

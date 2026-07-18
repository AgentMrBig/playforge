import * as THREE from "three";
import { Collider } from "./physics.js";

/**
 * VehicleBody — reusable arcade-with-weight car physics (bicycle model).
 *
 *   const car = world.spawn("car")
 *     .mesh(carVisual)
 *     .add(new VehicleBody({ chassis: carVisual, wheels: {...} }))
 *     .add(new PlayerVehicleControls());   // or your own AI controller
 *
 * Controllers just set three fields each tick:
 *   body.throttle  -1..1   (negative = brake / reverse)
 *   body.steerInput -1..1
 *   body.handbrake  bool
 *
 * The feel, and where it comes from:
 *  - HEAVY: engine force fades toward topSpeed (long pull), drag is quadratic,
 *    brakes are strong but not instant, and the chassis visually squats on
 *    throttle, dives on brakes, rolls into corners (weight transfer).
 *  - SMOOTH TURNING: steering is rate-limited toward its target and the max
 *    angle shrinks with speed (no twitch at 120), yaw comes from the bicycle
 *    model so the turn radius is physical: yawRate = v/wheelbase · tan(steer).
 *  - GRIP: sideways velocity decays separately from forward speed. Under
 *    normal grip the car tracks its nose; handbrake drops grip → slides.
 *
 * Works on flat ground, AABB Colliders (buildings), and Heightfield terrain.
 */
export class VehicleBody {
  constructor({
    mass = 1200,                 // only affects collision shove, but read by games
    enginePower = 10,            // m/s² at standstill
    brakePower = 15,
    topSpeed = 38,               // m/s (drag equilibrium lands near ~100 km/h)
    reverseSpeed = 9,
    wheelbase = 2.9,
    steerMax = 0.62,             // rad at standstill
    steerSpeed = 1.9,            // rad/s toward target
    grip = 7.5,                  // lateral decay rate (1/s)
    driftGrip = 1.1,             // ...with handbrake
    maxLatAccel = 8,             // m/s² tire grip: caps yaw rate at speed
    drag = 0.0045,               // quadratic
    rolling = 0.35,              // linear rolling resistance
    gravity = 24,
    chassis = null,              // visual node to lean (weight transfer)
    wheels = null,               // { fl, fr, rl, rr } meshes: spin + steer
    wheelRadius = 0.32,
  } = {}) {
    Object.assign(this, {
      mass, enginePower, brakePower, topSpeed, reverseSpeed, wheelbase,
      steerMax, steerSpeed, grip, driftGrip, maxLatAccel, drag, rolling, gravity,
      chassis, wheels, wheelRadius,
    });
    this.throttle = 0;
    this.steerInput = 0;
    this.handbrake = false;

    this.velocity = new THREE.Vector3(); // world-space (Body-compatible field)
    this.steer = 0;                      // actual smoothed steer angle
    this.speed = 0;                      // signed forward speed (m/s)
    this.onGround = true;
    this._lean = { roll: 0, pitch: 0 };
    this._wheelSpin = 0;
    this._box = new THREE.Box3();
    this._other = new THREE.Box3();
  }

  get kmh() { return Math.abs(this.speed * 3.6); }

  fixedUpdate(dt, { world, entity }) {
    const yaw = entity.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    // decompose velocity into the car's frame
    let speed = this.velocity.dot(fwd);
    let lat = this.velocity.dot(right);

    // ---- steering: rate-limited, speed-sensitive ------------------------
    const speedFactor = 1 / (1 + Math.abs(speed) * 0.045);
    const target = this.steerInput * this.steerMax * speedFactor;
    const dSteer = THREE.MathUtils.clamp(target - this.steer, -this.steerSpeed * dt, this.steerSpeed * dt);
    this.steer += dSteer;

    // ---- longitudinal forces --------------------------------------------
    const t = THREE.MathUtils.clamp(this.throttle, -1, 1);
    let accel = 0;
    if (t > 0.01) {
      if (speed >= 0) accel = t * this.enginePower * Math.max(0, 1 - speed / this.topSpeed);
      else accel = this.brakePower;                       // braking out of reverse
    } else if (t < -0.01) {
      if (speed > 0.5) accel = t * this.brakePower;       // braking
      else accel = t * this.enginePower * 0.55 * Math.max(0, 1 - Math.abs(speed) / this.reverseSpeed);
    }
    accel -= Math.sign(speed) * (this.drag * speed * speed + this.rolling);
    if (this.handbrake && Math.abs(speed) > 0.2)
      accel -= Math.sign(speed) * this.brakePower * 0.55;
    speed += accel * dt;
    if (Math.abs(speed) < 0.08 && Math.abs(t) < 0.01) speed = 0; // settle

    // ---- lateral grip (this is the drift model) --------------------------
    const g = this.handbrake ? this.driftGrip : this.grip;
    lat *= Math.exp(-g * dt);

    // ---- bicycle-model yaw, capped by tire grip ---------------------------
    if (Math.abs(speed) > 0.15) {
      let yawRate = (speed / this.wheelbase) * Math.tan(this.steer);
      // lateral acceleration = yawRate · speed; real tires cap it. This is
      // what makes high-speed turns sweep wide instead of pivoting.
      const latCap = (this.handbrake ? this.maxLatAccel * 1.6 : this.maxLatAccel) / Math.max(Math.abs(speed), 1);
      yawRate = THREE.MathUtils.clamp(yawRate, -latCap, latCap);
      // + sign: the body yaws WITH its front wheels (the sign bug that made
      // the car steer mirror-image of its own wheels lived here)
      entity.rotation.y = yaw + yawRate * dt;
      // rotating the frame leaves momentum behind: lat gains -Δθ·speed
      lat += -yawRate * dt * speed * 0.35;
    }

    // rebuild world velocity (keep vertical component for gravity)
    const vy = this.velocity.y - this.gravity * dt;
    const nyaw = entity.rotation.y;
    const nfwd = new THREE.Vector3(Math.sin(nyaw), 0, Math.cos(nyaw));
    const nright = new THREE.Vector3(nfwd.z, 0, -nfwd.x);
    this.velocity.copy(nfwd.multiplyScalar(speed)).addScaledVector(nright, lat);
    this.velocity.y = vy;
    this.speed = speed;

    // ---- integrate + ground ----------------------------------------------
    entity.position.addScaledVector(this.velocity, dt);
    this.onGround = false;
    let groundY = -Infinity;
    for (const e of world.entities)
      for (const c of e.components)
        if (typeof c.heightAt === "function" && typeof c.slopeAt === "function") {
          const h = c.heightAt(entity.position.x, entity.position.z);
          if (h > groundY) groundY = h;
        }
    if (groundY === -Infinity) groundY = 0; // flat-world default floor
    if (entity.position.y <= groundY + 0.02) {
      entity.position.y = groundY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    }

    // ---- collide with AABB Colliders (buildings, props) -------------------
    this._collide(world, entity);

    // ---- visual weight transfer ------------------------------------------
    if (this.chassis) {
      const wantRoll = THREE.MathUtils.clamp(-lat * 0.045 - this.steer * Math.abs(speed) * 0.006, -0.14, 0.14);
      const wantPitch = THREE.MathUtils.clamp(-accel * 0.011, -0.09, 0.12);
      const k = 1 - Math.exp(-dt * 7);
      this._lean.roll += (wantRoll - this._lean.roll) * k;
      this._lean.pitch += (wantPitch - this._lean.pitch) * k;
      this.chassis.rotation.z = this._lean.roll;
      this.chassis.rotation.x = this._lean.pitch;
    }
    if (this.wheels) {
      this._wheelSpin += (speed / this.wheelRadius) * dt;
      for (const key of ["fl", "fr", "rl", "rr"]) {
        const w = this.wheels[key];
        if (!w) continue;
        w.rotation.x = this._wheelSpin;
        if (key[0] === "f") w.rotation.y = this.steer * 0.9;
      }
    }
  }

  _collide(world, entity) {
    // car as a world AABB (approx — fine for arcade play)
    const c = entity.position;
    this._box.min.set(c.x - 1.1, c.y, c.z - 1.6);
    this._box.max.set(c.x + 1.1, c.y + 1.4, c.z + 1.6);
    for (const e of world.entities) {
      for (const col of e.components) {
        if (!(col instanceof Collider) || col.trigger || e === entity) continue;
        col.entity = e;
        const o = col.aabb(this._other);
        if (!this._box.intersectsBox(o)) continue;
        // minimal-push resolution across ALL THREE axes. Shallow vertical
        // overlaps resolve UP (curbs, sidewalks, ground slabs) — horizontal-
        // only resolution was silently bulldozing cars sideways off the map.
        const dxa = o.max.x - this._box.min.x, dxb = this._box.max.x - o.min.x;
        const dza = o.max.z - this._box.min.z, dzb = this._box.max.z - o.min.z;
        const dya = o.max.y - this._box.min.y;             // push up only
        const px = Math.min(dxa, dxb), pz = Math.min(dza, dzb);
        const py = dya;
        // wheels are round: anything lower than ~knee height is a curb we
        // mount, regardless of which overlap axis is shallower. py === 0
        // means we're exactly ON the surface (the giant ground slab!) — that
        // must never fall through to a horizontal shove.
        if (py < 0.5) {
          if (py > 0.001) entity.position.y += py;
          if (this.velocity.y < 0) this.velocity.y = 0;
          this.onGround = true;
        } else if (px < pz) {
          entity.position.x += dxa < dxb ? px : -px;
          this.velocity.x *= -0.25;
          this.velocity.multiplyScalar(0.82);              // crunch scrubs speed
        } else {
          entity.position.z += dza < dzb ? pz : -pz;
          this.velocity.z *= -0.25;
          this.velocity.multiplyScalar(0.82);
        }
      }
    }
  }
}

/** WASD / arrows / touch driving — attach alongside VehicleBody */
export class PlayerVehicleControls {
  constructor({ enabled = () => true } = {}) { this.enabled = enabled; }
  fixedUpdate(dt, { input, entity }) {
    const body = entity.get(VehicleBody);
    if (!body) return;
    if (!this.enabled()) { body.throttle = 0; body.steerInput = 0; body.handbrake = false; return; }
    const stick = input.stick("left");
    body.throttle = (input.down("KeyW") || input.down("ArrowUp") ? 1 : 0)
                  - (input.down("KeyS") || input.down("ArrowDown") ? 1 : 0)
                  - stick.y;
    body.steerInput = (input.down("KeyA") || input.down("ArrowLeft") ? 1 : 0)
                    - (input.down("KeyD") || input.down("ArrowRight") ? 1 : 0)
                    - stick.x;
    body.handbrake = input.down("Space");
  }
}

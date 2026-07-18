import * as THREE from "three";
import { Collider } from "./physics.js";

/**
 * VehicleBody — force-based car physics (dynamic bicycle model + tire curve).
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
 * NOTHING here is scripted — behavior emerges from the force balance:
 *  - the car is a rigid body with yaw INERTIA (a slide carries momentum;
 *    a spin is rotation the front tires failed to catch)
 *  - each axle's tires make lateral force from their SLIP ANGLE through a
 *    Pacejka-style curve that peaks near `slipPeak` and lets go past it —
 *    breakaway is the tire curve's falling tail, not a flag
 *  - engine torque spends the rear tires' friction budget (friction
 *    ellipse), so power-on oversteer and launch fishtails just happen
 *  - handbrake locks the rears: their lateral grip collapses → rotation
 * Below ~2.5 m/s it blends to a kinematic model (slip angles are undefined
 * at rest — this is how every sim handles parking speeds).
 *
 * Exposed live state: speed/kmh, slipFront/slipRear (rad), wheelspin,
 * sliding (rear past peak — use it for skid marks / smoke / audio).
 */
export class VehicleBody {
  constructor({
    mass = 1200,                 // kg — now a REAL mass: forces divide by it
    enginePower = 10,            // peak accel m/s² at standstill (F = m·this)
    brakePower = 15,
    topSpeed = 38,               // m/s engine-force fade reference
    reverseSpeed = 9,
    wheelbase = 2.9,
    steerMax = 0.62,             // rad at standstill
    steerSpeed = 1.9,            // rad/s toward target
    maxLatAccel = 8,             // m/s² peak tire grip (μ·g); tire grade
    slipPeak = 0.14,             // rad (~8°): tire curve peak — breakaway point
    slideFriction = 0.72,        // fraction of peak force left past breakaway
    drag = 0.0045,               // quadratic
    rolling = 0.35,              // linear rolling resistance
    gravity = 24,
    chassis = null,              // visual node to lean (weight transfer)
    wheels = null,               // { fl, fr, rl, rr } meshes: spin + steer
    wheelRadius = 0.32,
    suspension = null,           // rig.suspension from loadVehicle → real shocks
    suspFreq = 2.3,              // Hz — body bounce frequency (stiff street setup)
    suspDamp = 0.55,             // damping ratio (settles fast, slight bob)
    rollGain = 0.0065,           // rad per m/s² of lateral accel
    pitchGain = 0.0075,          // rad per m/s² of longitudinal accel
    swayBar = 0.5,               // anti-roll stiffness 0..1: cuts roll target + speeds roll settle
    maxTravel = 0.055,           // m of body heave — wheels never eat the fenders
    maxRoll = 0.055, maxPitch = 0.07, // rad hard limits (suspension bottoms out)
  } = {}) {
    Object.assign(this, {
      mass, enginePower, brakePower, topSpeed, reverseSpeed, wheelbase,
      steerMax, steerSpeed, maxLatAccel, slipPeak, slideFriction,
      drag, rolling, gravity, chassis, wheels, wheelRadius,
      suspension, suspFreq, suspDamp, rollGain, pitchGain,
      swayBar, maxTravel, maxRoll, maxPitch,
    });
    this.inertia = mass * 1.9;   // yaw inertia (Izz) — spins carry momentum
    this.throttle = 0;
    this.steerInput = 0;
    this.handbrake = false;

    this.velocity = new THREE.Vector3(); // world-space (Body-compatible field)
    this.steer = 0;                      // actual smoothed steer angle
    this.speed = 0;                      // signed forward speed (m/s)
    this.yawRate = 0;                    // rad/s angular velocity (state!)
    this.slipFront = 0;                  // live slip angles (rad)
    this.slipRear = 0;
    this.wheelspin = false;
    this.sliding = false;                // rear axle past the tire-curve peak
    this.onGround = true;
    this._lean = { roll: 0, pitch: 0 };
    this._wheelSpin = 0;
    this._prevSpeed = 0;
    // sprung-mass state: heave (m), roll & pitch (rad), each with a velocity
    this._susp = { heave: 0, heaveV: 0, roll: 0, rollV: 0, pitch: 0, pitchV: 0 };
    this._box = new THREE.Box3();
    this._other = new THREE.Box3();
  }

  get kmh() { return Math.abs(this.speed * 3.6); }

  // Pacejka-lite: rises to 1.0 at slipPeak, falls to slideFriction beyond.
  // The falling tail IS the unpredictability — past the peak, steering
  // harder gives you LESS force.
  _tire(slip) {
    const s = slip / this.slipPeak;
    const a = Math.abs(s);
    if (a <= 1) return Math.sign(s) * Math.sin((Math.PI / 2) * a);
    const fade = 1 - Math.min((a - 1) * 0.35, 1 - this.slideFriction);
    return Math.sign(s) * fade;
  }

  fixedUpdate(dt, { world, entity }) {
    const yaw = entity.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    // decompose velocity into the car's frame
    // car-frame velocity: vx forward, vy lateral (right +)
    let vx = this.velocity.dot(fwd);
    let vy = this.velocity.dot(right);

    // ---- steering: rate-limited, speed-sensitive ------------------------
    const speedFactor = 1 / (1 + Math.abs(vx) * 0.038);
    const target = this.steerInput * this.steerMax * speedFactor;
    const dSteer = THREE.MathUtils.clamp(target - this.steer, -this.steerSpeed * dt, this.steerSpeed * dt);
    this.steer += dSteer;

    // ---- longitudinal drive/brake (rear axle drives) ----------------------
    const t = THREE.MathUtils.clamp(this.throttle, -1, 1);
    let driveAccel = 0;
    if (t > 0.01) {
      if (vx >= -0.5) driveAccel = t * this.enginePower * Math.max(0, 1 - vx / this.topSpeed);
      else driveAccel = this.brakePower;                  // braking out of reverse
    } else if (t < -0.01) {
      if (vx > 0.5) driveAccel = t * this.brakePower;     // braking
      else driveAccel = t * this.enginePower * 0.55 * Math.max(0, 1 - Math.abs(vx) / this.reverseSpeed);
    }

    const speedAbs = Math.abs(vx);
    const a = this.wheelbase / 2, b = this.wheelbase / 2; // CG centered
    const muG = this.maxLatAccel;                          // peak grip accel

    if (speedAbs > 2.5) {
      // ================ DYNAMIC MODEL: forces, not formulas ===============
      // slip angles: where each axle's rubber TRAVELS vs where it POINTS
      const sgn = Math.sign(vx || 1);
      this.slipFront = Math.atan2(vy + a * this.yawRate, speedAbs) - this.steer * sgn;
      this.slipRear = Math.atan2(vy - b * this.yawRate, speedAbs);

      // rear tires split one friction budget between drive and cornering
      // (friction ellipse): full throttle leaves little lateral grip
      const driveFrac = THREE.MathUtils.clamp(Math.abs(driveAccel) / muG, 0, 1);
      let rearLatBudget = Math.sqrt(Math.max(0.06, 1 - driveFrac * driveFrac));
      this.wheelspin = t > 0.5 && Math.abs(driveAccel) > muG * 0.95;
      if (this.wheelspin) { driveAccel *= 0.55; rearLatBudget = 0.35; }
      if (this.handbrake) {                     // locked rears: grip collapses
        rearLatBudget = 0.3;
        driveAccel -= Math.sign(vx) * this.brakePower * 0.55;
      }

      // per-axle lateral accel through the tire curve (each axle carries
      // half the car, so each contributes half the total grip)
      const half = muG * 0.5;
      const ayF = -this._tire(this.slipFront) * half;
      const ayR = -this._tire(this.slipRear) * half * rearLatBudget;
      this.sliding = Math.abs(this.slipRear) > this.slipPeak * 1.05 || this.wheelspin;

      const resist = Math.sign(vx) * (this.drag * vx * vx + this.rolling);

      // ---- integrate the rigid body (this IS the simulation) -------------
      vx += (driveAccel - resist + vy * this.yawRate) * dt;
      vy += (ayF + ayR - vx * this.yawRate) * dt;
      // yaw torque: front vs rear force imbalance about the CG. Whether the
      // car understeers, oversteers, or spins is DECIDED HERE by physics.
      const yawAccel = (a * ayF - b * ayR) * this.mass / this.inertia;
      this.yawRate = THREE.MathUtils.clamp(this.yawRate + yawAccel * dt, -3.5, 3.5);
      entity.rotation.y = yaw + this.yawRate * dt;
    } else {
      // ================ PARKING-SPEED KINEMATIC BLEND =====================
      this.slipFront = this.slipRear = 0;
      this.wheelspin = t > 0.9 && this.enginePower * 0.55 > muG * 0.6;
      this.sliding = this.wheelspin;
      if (this.wheelspin) driveAccel *= 0.55;
      const resist = Math.sign(vx) * (this.drag * vx * vx + this.rolling * Math.min(1, speedAbs));
      if (this.handbrake) driveAccel -= Math.sign(vx) * this.brakePower * 0.55;
      vx += (driveAccel - resist) * dt;
      if (Math.abs(vx) < 0.08 && Math.abs(t) < 0.01) vx = 0;
      vy *= Math.exp(-8 * dt);
      const kinYaw = (vx / this.wheelbase) * Math.tan(this.steer);
      this.yawRate += (kinYaw - this.yawRate) * (1 - Math.exp(-dt * 10));
      entity.rotation.y = yaw + this.yawRate * dt;
    }

    // rebuild world velocity (keep vertical component for gravity)
    const wy = this.velocity.y - this.gravity * dt;
    const nyaw = entity.rotation.y;
    const nfwd = new THREE.Vector3(Math.sin(nyaw), 0, Math.cos(nyaw));
    const nright = new THREE.Vector3(nfwd.z, 0, -nfwd.x);
    this.velocity.copy(nfwd.multiplyScalar(vx)).addScaledVector(nright, vy);
    this.velocity.y = wy;
    this.speed = vx;

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
      // ramp launch: rising ground under us becomes upward velocity, so at a
      // ramp lip the car keeps that momentum and actually flies (then lands
      // and the suspension soaks it up)
      const climb = THREE.MathUtils.clamp(
        (groundY - (this._prevGroundY ?? groundY)) / Math.max(dt, 1e-4), 0, 16);
      this.velocity.y = Math.max(this.velocity.y, climb);
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    }
    this._prevGroundY = groundY;

    // ---- collide with AABB Colliders (buildings, props) -------------------
    this._collide(world, entity);

    // ---- suspension (real) or simple lean (fallback) ---------------------
    const longAccel = (vx - this._prevSpeed) / Math.max(dt, 1e-4);
    this._prevSpeed = vx;
    if (this.suspension) {
      this._suspend(dt, world, entity, vx, driveAccel, longAccel);
    } else if (this.chassis) {
      const latG = this.yawRate * vx;
      const wantRoll = THREE.MathUtils.clamp(-latG * 0.011 - vy * 0.02, -0.15, 0.15);
      const wantPitch = THREE.MathUtils.clamp(-driveAccel * 0.011, -0.09, 0.12);
      const k = 1 - Math.exp(-dt * 7);
      this._lean.roll += (wantRoll - this._lean.roll) * k;
      this._lean.pitch += (wantPitch - this._lean.pitch) * k;
      this.chassis.rotation.z = this._lean.roll;
      this.chassis.rotation.x = this._lean.pitch;
    }
    // wheels spin + steer (both models)
    if (this.wheels) {
      const spinRate = this.wheelspin ? this.topSpeed * 1.4 : vx;
      this._wheelSpin += (spinRate / this.wheelRadius) * dt;
      for (const key of ["fl", "fr", "rl", "rr"]) {
        const w = this.wheels[key];
        if (!w) continue;
        w.rotation.x = this._wheelSpin;
        if (key[0] === "f") w.rotation.y = this.steer * 0.9;
      }
    }
  }

  // Real 4-corner suspension: plant each wheel on its own ground contact
  // (never clipping), then ride the body on underdamped spring-dampers so it
  // rolls/pitches from load transfer and bobs over bumps — actual shocks.
  _suspend(dt, world, entity, vx, driveAccel, longAccel) {
    const S = this.suspension;
    const carY = entity.position.y, yaw = entity.rotation.y;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const gy = {};
    for (const key of ["fl", "fr", "rl", "rr"]) {
      const c = S.corners[key];
      if (!c) continue;
      const wx = entity.position.x + rx * c.ox + fx * c.oz;
      const wz = entity.position.z + rz * c.ox + fz * c.oz;
      const g = groundYAt(world, wx, wz);
      gy[key] = g;
      // plant the wheel: pivot world-Y = ground + radius → local y in scaled node
      S.wheels[key].position.y = (g + S.wheelRadius - carY) / S.scale;
    }
    // ---- targets from load transfer + road contour -----------------------
    const latAcc = this.yawRate * vx;                 // centripetal (m/s²)
    const leftY = (gy.fl + gy.rl) * 0.5, rightY = (gy.fr + gy.rr) * 0.5;
    const frontY = (gy.fl + gy.fr) * 0.5, rearY = (gy.rl + gy.rr) * 0.5;
    const terrRoll = Math.atan2(leftY - rightY, S.track);
    const terrPitch = Math.atan2(frontY - rearY, S.wheelbase);
    // sway bar: cuts how far load transfer can roll the body AND stiffens
    // the roll axis specifically (higher freq + damping on roll)
    const rollTarget = THREE.MathUtils.clamp(-latAcc * this.rollGain * (1 - this.swayBar * 0.6), -this.maxRoll, this.maxRoll) + terrRoll;
    const pitchTarget = THREE.MathUtils.clamp(-longAccel * this.pitchGain, -this.maxPitch, this.maxPitch) + terrPitch;
    const heaveTarget = (leftY + rightY) * 0.5 - carY;  // body follows terrain avg
    // ---- integrate spring-dampers (mass on spring → oscillate + settle) --
    const w = 2 * Math.PI * this.suspFreq, z = this.suspDamp;
    const wRoll = w * (1 + this.swayBar * 0.6), zRoll = Math.min(1, z * (1 + this.swayBar * 0.5));
    const sp = this._susp;
    const step = (x, v, target, ww = w, zz = z) => {
      const a = -ww * ww * (x - target) - 2 * zz * ww * v;
      v += a * dt; x += v * dt;
      return [x, v];
    };
    [sp.heave, sp.heaveV] = step(sp.heave, sp.heaveV, heaveTarget);
    [sp.roll, sp.rollV] = step(sp.roll, sp.rollV, rollTarget, wRoll, zRoll);
    [sp.pitch, sp.pitchV] = step(sp.pitch, sp.pitchV, pitchTarget);
    // ---- hard travel limits: suspension bottoms out, fenders never eat
    // the wheels (dip is clamped relative to the terrain-following pose) ----
    sp.heave = THREE.MathUtils.clamp(sp.heave, heaveTarget - this.maxTravel, heaveTarget + this.maxTravel);
    sp.roll = THREE.MathUtils.clamp(sp.roll, terrRoll - this.maxRoll, terrRoll + this.maxRoll);
    sp.pitch = THREE.MathUtils.clamp(sp.pitch, terrPitch - this.maxPitch, terrPitch + this.maxPitch);
    // ---- apply to the body (wheels are on the separate level node) --------
    const b = S.bodyRoot;
    b.position.y = S.baseBodyY + sp.heave;
    b.rotation.z = sp.roll;
    b.rotation.x = sp.pitch;
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

/** sample terrain height at a world point (any Heightfield/StreamedTerrain) */
function groundYAt(world, x, z) {
  let best = -Infinity;
  for (const e of world.entities)
    for (const c of e.components)
      if (typeof c.heightAt === "function" && typeof c.slopeAt === "function") {
        const h = c.heightAt(x, z);
        if (h !== -Infinity && h > best) best = h;
      }
  return best === -Infinity ? 0 : best;
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

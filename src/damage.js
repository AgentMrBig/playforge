import * as THREE from "three";
import { VehicleBody } from "./vehicle.js";
import { Emitter } from "./particles.js";

/**
 * CarCollisions — car-vs-car contact for every VehicleBody in the world.
 *
 *   world.spawn("carCollisions").add(new CarCollisions({ audio }));
 *
 * Each car is approximated by TWO circles on the ground plane (front + rear,
 * spaced along its heading) — circle pairs stay smooth and stable at any yaw,
 * where box SAT jitters on corner-to-corner hits. On contact:
 *   - positional split so cars never interpenetrate,
 *   - a restitution impulse along the contact normal, mass-weighted, so a
 *     shunt actually shoves the other car,
 *   - a yaw kick from the contact offset (rear-quarter tap = PIT spin —
 *     the torque falls out of r × J, nothing scripted),
 *   - juice: sparks at the contact point, crash SFX scaled by closing speed,
 *     and `entity.damage` accumulates for the (coming) crunch visuals.
 *
 * Impact hooks: `car.onCarHit = (strength, point, normal) => {}` fires on any
 * contact above the spark threshold (strength = closing speed, m/s).
 */
export class CarCollisions {
  constructor({ audio = null, restitution = 0.3, radius = 1.05, spacing = 1.05 } = {}) {
    this.audio = audio;
    this.restitution = restitution;
    this.radius = radius;      // per-circle radius (m)
    this.spacing = spacing;    // circle centers at ±spacing along the heading
    if (audio && !audio.recipes.has("crash"))
      audio.define("crash", { type: "sawtooth", from: 140, to: 30, dur: 0.28, vol: 0.5, noise: 0.9 });
    this._sparks = null;       // lazily attached Emitter (world-space at origin)
    this._n = new THREE.Vector3();
    this._pA = new THREE.Vector3();
    this._pB = new THREE.Vector3();
  }

  init(entity) {
    this._sparks = new Emitter({
      count: 320, color: 0xffd27a, color2: 0xff5522, size: 0.12,
      speed: [2, 9], life: [0.15, 0.5], gravity: 14, spread: Math.PI * 0.65,
    });
    entity.add(this._sparks);
  }

  /** the two collision-circle centers for a car, in world space */
  _circles(e) {
    const yaw = e.rotation.y;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    return [
      { x: e.position.x + fx * this.spacing, z: e.position.z + fz * this.spacing },
      { x: e.position.x - fx * this.spacing, z: e.position.z - fz * this.spacing },
    ];
  }

  fixedUpdate(dt, { world }) {
    const cars = [];
    for (const e of world.entities) {
      const vb = e.get?.(VehicleBody) ?? e.components?.find((c) => c instanceof VehicleBody);
      if (vb) cars.push({ e, vb });
    }
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        // cheap reject: centers further than any circle pair could reach
        const A = cars[i], B = cars[j];
        const dx = B.e.position.x - A.e.position.x, dz = B.e.position.z - A.e.position.z;
        const reach = (this.spacing + this.radius) * 2;
        if (dx * dx + dz * dz > reach * reach) continue;
        this._collidePair(A, B);
      }
    }
  }

  _collidePair(A, B) {
    // deepest-overlap circle pair defines the contact
    const ca = this._circles(A.e), cb = this._circles(B.e);
    let best = null;
    for (const a of ca) for (const b of cb) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const d2 = dx * dx + dz * dz, min = this.radius * 2;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const depth = min - d;
      if (!best || depth > best.depth)
        best = { depth, nx: dx / d, nz: dz / d, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2 };
    }
    if (!best) return;

    const { nx, nz, depth, cx, cz } = best;              // normal points A → B
    const mA = A.vb.mass, mB = B.vb.mass;
    const invA = 1 / mA, invB = 1 / mB, invSum = invA + invB;

    // ---- positional split (no sinking) ------------------------------------
    const push = depth / invSum;
    A.e.position.x -= nx * push * invA; A.e.position.z -= nz * push * invA;
    B.e.position.x += nx * push * invB; B.e.position.z += nz * push * invB;

    // ---- restitution impulse along the normal -----------------------------
    const rvx = B.vb.velocity.x - A.vb.velocity.x;
    const rvz = B.vb.velocity.z - A.vb.velocity.z;
    const closing = -(rvx * nx + rvz * nz);              // >0 = approaching
    if (closing > 0) {
      const jImp = ((1 + this.restitution) * closing) / invSum;  // scalar impulse (N·s)
      A.vb.velocity.x -= nx * jImp * invA; A.vb.velocity.z -= nz * jImp * invA;
      B.vb.velocity.x += nx * jImp * invB; B.vb.velocity.z += nz * jImp * invB;

      // ---- yaw kick: impulse applied off-center spins the car -------------
      for (const [car, sign] of [[A, -1], [B, 1]]) {
        const rx = cx - car.e.position.x, rz = cz - car.e.position.z;
        const torque = rx * (nz * jImp * sign) - rz * (nx * jImp * sign);   // r × J (y)
        car.vb.yawRate = THREE.MathUtils.clamp(
          car.vb.yawRate + torque / car.vb.inertia, -3.5, 3.5);
      }

      // ---- juice ----------------------------------------------------------
      if (closing > 1.5) {
        const strength = closing;
        const point = this._pA.set(cx, A.e.position.y + 0.55, cz);
        this._sparks?.burst(Math.min(10 + strength * 8, 90), point);
        this.audio?.play("crash", {
          volume: Math.min(0.25 + strength * 0.09, 1),
          pitch: 1 + Math.random() * 0.25 - (Math.min(strength, 14) / 14) * 0.45,
        });
        for (const car of [A, B]) {
          car.e.damage = (car.e.damage ?? 0) + strength;
          car.e.onCarHit?.(strength, point, this._n.set(nx, 0, nz));
        }
      }
    }
  }
}

import * as THREE from "three";
import { VehicleBody } from "./vehicle.js";

/**
 * SkidMarks — rubber on the road. Attach next to a VehicleBody:
 *
 *   car.add(new SkidMarks());
 *
 * Lays ribbon quads behind the rear wheels whenever the tires slip:
 *  - hard cornering (lateral speed over `slipLat`)
 *  - handbrake slides
 *  - burnouts (big throttle at low speed)
 *  - hard braking from speed
 * Segments live in a ring buffer (zero garbage) and fade out over `life`
 * seconds via vertex alpha.
 */
export class SkidMarks {
  constructor({
    maxSegments = 600, life = 9, width = 0.24,
    slipLat = 3.2, burnoutThrottle = 0.75, burnoutSpeed = 5,
    rearOffset = 1.05, track = 0.7, yLift = 0.03,
  } = {}) {
    Object.assign(this, { maxSegments, life, width, slipLat, burnoutThrottle, burnoutSpeed, rearOffset, track, yLift });
    this._head = 0;
    this._count = 0;
    this._ages = new Float32Array(maxSegments);
    this._prev = null; // previous L/R ground points
    // 2 wheels × maxSegments quads × 4 verts
    const vtx = maxSegments * 2 * 4;
    this._pos = new Float32Array(vtx * 3);
    this._col = new Float32Array(vtx * 4); // rgba, alpha fades
    const idx = new Uint32Array(maxSegments * 2 * 6);
    for (let q = 0; q < maxSegments * 2; q++) {
      const v = q * 4, i = q * 6;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this._col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  init(entity, world) {
    world.scene.add(this.mesh);
    // auto-size marks from the vehicle's real tire geometry when available
    const body = entity.get(VehicleBody) ??
      entity.components.find((c) => c.suspension || c.steerMax !== undefined);
    const s = body?.suspension;
    if (s) {
      if (s.wheelWidth) this.width = s.wheelWidth * 0.5;   // ribbon = one tire wide
      if (s.track) this.track = s.track * 0.5;             // ribbons at the rear tires
      if (s.rearOffset) this.rearOffset = s.rearOffset;
    }
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }

  _groundY(world, x, z) {
    for (const e of world.entities)
      for (const c of e.components)
        if (typeof c.heightAt === "function" && typeof c.slopeAt === "function") {
          const h = c.heightAt(x, z);
          if (h !== -Infinity) return h;
        }
    return 0;
  }

  update(dt, { world, entity }) {
    const body = entity.get(VehicleBody) ??
      entity.components.find((c) => c.throttle !== undefined && c.steerMax !== undefined);
    if (!body) return;

    // ---- age + fade all live segments (cheap: only alpha channel) ---------
    for (let s = 0; s < this.maxSegments; s++) {
      if (this._ages[s] <= 0) continue;
      this._ages[s] -= dt;
      const a = Math.max(this._ages[s] / this.life, 0) * 0.85;
      for (let w = 0; w < 2; w++) {
        const v = (s * 2 + w) * 4;
        for (let k = 0; k < 4; k++) this._col[(v + k) * 4 + 3] = a;
      }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;

    // ---- are we slipping? Physically: rear slip angle past the tire peak,
    // wheelspin, or locked wheels — NOT "turning at all" -------------------
    // heading from the QUATERNION — entity.rotation.y is a wrapped euler on a
    // fully-3D body and lies during sharp turns (marks veered off; Erik saw)
    const f3 = new THREE.Vector3(0, 0, 1).applyQuaternion(entity.object3d.quaternion);
    const yaw = Math.atan2(f3.x, f3.z);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const spd = Math.abs(body.speed);
    let slipping;
    if (body.slipRear !== undefined) {         // force-based body: use real slip
      slipping = body.onGround &&
        (body.sliding || (body.handbrake && spd > 3) ||
         (body.throttle < -0.6 && spd > 12));  // near-lockup braking
    } else {                                    // legacy fallback
      const lat = Math.abs(body.velocity.dot(right));
      slipping = body.onGround &&
        (lat > this.slipLat || (body.handbrake && spd > 2) ||
         (Math.abs(body.throttle) > this.burnoutThrottle && spd < this.burnoutSpeed));
    }

    if (!slipping) { this._prev = null; return; }

    // rear ground points — the REAL wheel contact points when the body has
    // them (Rapier raycast wheels), else derived from the rear-axle offsets
    const pts = [];
    const wc = body.wheelContacts;
    if (wc?.rl && wc?.rr) {
      pts.push(new THREE.Vector3(wc.rl.x, wc.rl.y + this.yLift, wc.rl.z));
      pts.push(new THREE.Vector3(wc.rr.x, wc.rr.y + this.yLift, wc.rr.z));
    } else {
      const cx = entity.position.x - fwd.x * this.rearOffset;
      const cz = entity.position.z - fwd.z * this.rearOffset;
      for (const side of [-1, 1]) {
        const x = cx + right.x * this.track * side;
        const z = cz + right.z * this.track * side;
        pts.push(new THREE.Vector3(x, this._groundY(world, x, z) + this.yLift, z));
      }
    }
    if (this._prev) {
      const moved = pts[0].distanceTo(this._prev[0]);
      if (moved < 0.22) return;                 // wait for enough travel
      this._lay(this._prev, pts, right);
    }
    this._prev = pts;
  }

  _lay(prev, cur, right) {
    const s = this._head;
    this._head = (this._head + 1) % this.maxSegments;
    this._ages[s] = this.life;
    const hw = this.width;
    for (let w = 0; w < 2; w++) {
      const v = (s * 2 + w) * 4;
      const a = prev[w], b = cur[w];
      const corners = [
        a.x - right.x * hw, a.y, a.z - right.z * hw,
        a.x + right.x * hw, a.y, a.z + right.z * hw,
        b.x - right.x * hw, b.y, b.z - right.z * hw,
        b.x + right.x * hw, b.y, b.z + right.z * hw,
      ];
      this._pos.set(corners, v * 3);
      for (let k = 0; k < 4; k++) {
        const o = (v + k) * 4;
        // near-black in LINEAR space so it displays black after sRGB encode
        this._col[o] = 0.008; this._col[o + 1] = 0.008; this._col[o + 2] = 0.009;
        this._col[o + 3] = 0.85;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

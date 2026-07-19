import * as THREE from "three";
import { VehicleBody } from "./vehicle.js";

/**
 * AITrafficDriver — drives a car along the road network like the player would:
 * it only ever sets throttle / steerInput / handbrake on the VehicleBody, so the
 * SAME Rapier physics moves it (physics-first — no rails, no scripted position).
 * As the car handling improves, traffic improves for free.
 *
 *   e.add(new RapierVehicle({...}))
 *    .add(new AITrafficDriver({ roadGraph, targetSpeed: 12 }));
 *
 * Steering: aim at a lane-center point `lookahead` metres ahead on the road
 * (roadGraph.laneTarget) and turn toward it. Speed: hold targetSpeed, but lift
 * off / brake when the road bends hard or something (player, another AI car) is
 * close ahead in our lane — so they queue instead of ramming.
 */
export class AITrafficDriver {
  constructor({
    roadGraph = null,          // defaults to window.__pf.roadGraph at runtime
    targetSpeed = 12,          // m/s cruise (~43 km/h)
    lookahead = 14,            // m ahead to aim the steer
    avoidDist = 11,            // m — brake if an obstacle is closer than this ahead
    obstacles = null,          // () => [{position}] to avoid; default scans world
  } = {}) {
    this.roadGraph = roadGraph;
    this.targetSpeed = targetSpeed;
    this.lookahead = lookahead;
    this.avoidDist = avoidDist;
    this.obstacles = obstacles;
    this._fwd = new THREE.Vector3();
    this._to = new THREE.Vector3();
  }

  _vehicle(entity) { return entity.components?.find((c) => c instanceof VehicleBody); }

  fixedUpdate(dt, { entity, world }) {
    const vb = this._vehicle(entity);
    const rg = this.roadGraph ?? (typeof window !== "undefined" && window.__pf?.roadGraph);
    if (!vb || !rg?.laneTarget) return;

    const p = entity.position;
    const target = rg.laneTarget(p.x, p.z, this.lookahead);
    if (!target) { vb.throttle = 0; vb.steerInput = 0; vb.handbrake = false; return; }

    // ---- steer toward the lane target -----------------------------------
    // car forward is (sin yaw, 0, cos yaw); desired yaw aims at the target
    const dx = target[0] - p.x, dz = target[1] - p.z;
    const desiredYaw = Math.atan2(dx, dz);
    let err = desiredYaw - entity.rotation.y;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    vb.steerInput = THREE.MathUtils.clamp(err * 1.6, -1, 1);

    // ---- speed: cruise, but ease off in hard turns -----------------------
    const speed = Math.abs(vb.speed ?? 0);
    const turnEase = 1 - Math.min(0.75, Math.abs(err) * 0.9);   // sharp turn → slower
    let wantSpeed = this.targetSpeed * turnEase;

    // ---- brake for obstacles ahead in our lane ---------------------------
    this._fwd.set(Math.sin(entity.rotation.y), 0, Math.cos(entity.rotation.y));
    let nearest = Infinity;
    for (const o of this._obstacleList(world, entity)) {
      this._to.set(o.x - p.x, 0, o.z - p.z);
      const ahead = this._to.dot(this._fwd);              // + = in front
      if (ahead <= 0.5) continue;
      const lateral = Math.abs(this._to.x * this._fwd.z - this._to.z * this._fwd.x);
      if (lateral > 2.2) continue;                        // not in our lane
      nearest = Math.min(nearest, ahead);
    }
    if (nearest < this.avoidDist) wantSpeed *= Math.max(0, (nearest - 3) / (this.avoidDist - 3));

    // ---- convert desired speed into throttle/brake -----------------------
    if (wantSpeed < 0.4 && speed < 0.6) { vb.throttle = 0; vb.handbrake = nearest < 4; }
    else if (speed > wantSpeed + 1.5) { vb.throttle = -0.7; vb.handbrake = false; }  // brake
    else { vb.throttle = THREE.MathUtils.clamp((wantSpeed - speed) * 0.5 + 0.25, 0, 1); vb.handbrake = false; }
  }

  /** obstacles to avoid: injected list, or every OTHER car + the player. */
  _obstacleList(world, self) {
    if (this.obstacles) return this.obstacles().map((o) => o.position ?? o);
    const out = [];
    for (const e of world.entities) {
      if (e === self) continue;
      const isCarOrPerson = e.components?.some((c) => c.rb);
      if (isCarOrPerson) out.push(e.position);
    }
    return out;
  }
}

/** a lane-center world position + heading to spawn a traffic car onto a road. */
export function roadSpawn(roadGraph, roadId = 0, arc = 0) {
  const road = roadGraph?.roads?.[roadId];
  if (!road) return null;
  const at = roadGraph.advance(roadId, arc, 0);
  if (!at) return null;
  const [tx, tz] = at.tangent, w = road.width;
  return {
    x: at.point[0] + tz * w * 0.25, z: at.point[1] - tx * w * 0.25,   // right lane
    yaw: Math.atan2(tx, tz),
  };
}

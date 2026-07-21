import * as THREE from "three";

/**
 * WakeEffect — a foam wake + spray behind a moving boat (Ember, Erik 2026-07-21:
 * boat polish). A GPU point cloud: as the boat drives, foam puffs are emitted at
 * the two stern corners (a V-wake) at the live water surface, then drift outward,
 * rise a touch, and fade. Particles live in WORLD space so the trail stays behind
 * the boat instead of dragging with it. Pure code — no assets. Emits ∝ boat speed,
 * so an idle boat leaves no wake.
 */
export class WakeEffect {
  constructor(scene, { count = 260, life = 1.6, size = 2.4 } = {}) {
    this.scene = scene; this.max = count; this.life = life; this.head = 0;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life0 = new Float32Array(count);     // remaining life
    this.seed = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(this.life0, 1).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.BufferAttribute(this.seed, 1);
    geo.setAttribute("position", this.aPos);
    geo.setAttribute("aLife", this.aLife);
    geo.setAttribute("aSeed", this.aSeed);
    geo.setDrawRange(0, count);
    for (let i = 0; i < count; i++) this.seed[i] = Math.sin(i * 12.9898) * 43758.5453 % 1;

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uSize: { value: size }, uLife: { value: life } },
      vertexShader: /* glsl */ `
        attribute float aLife; attribute float aSeed;
        uniform float uSize, uLife;
        varying float vA;
        void main() {
          float t = clamp(aLife / uLife, 0.0, 1.0);       // 1 fresh → 0 dead
          vA = t;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float grow = mix(0.5, 1.6, 1.0 - t);            // puffs expand as they age
          gl_PointSize = uSize * grow * (300.0 / -mv.z) * step(0.001, aLife);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          if (r > 0.5) discard;
          float soft = smoothstep(0.5, 0.12, r);          // soft round foam fleck
          float alpha = soft * vA * 0.85;
          gl_FragColor = vec4(vec4(0.92, 0.96, 1.0, alpha));
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);

    this._nose = new THREE.Vector3(); this._right = new THREE.Vector3(); this._q = new THREE.Quaternion();
  }

  _emit(x, y, z, vx, vy, vz) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life0[i] = this.life;
  }

  /** call each frame with the boat entity + its model (for speed) */
  update(dt, { boatEntity, boatModel, water, time }) {
    // emit at the stern corners when moving
    if (boatEntity && boatModel) {
      const o = boatEntity.object3d; this._q.copy(o.quaternion);
      const speed = boatModel.speed || 0;
      this._nose.set(0, 0, 1).applyQuaternion(this._q);       // boat forward = +Z
      this._right.set(1, 0, 0).applyQuaternion(this._q);
      if (speed > 1.5) {
        const rate = Math.min(6, Math.floor(speed * 0.6));    // more foam when faster
        const sternL = boatModel.half ? boatModel.half[2] * 0.9 : 3;
        for (let e = 0; e < rate; e++) {
          const side = e % 2 === 0 ? 1 : -1;
          const jx = (Math.sin((this.head + e) * 7.1) * 0.5);
          const px = o.position.x - this._nose.x * sternL + this._right.x * side * 1.2;
          const pz = o.position.z - this._nose.z * sternL + this._right.z * side * 1.2;
          const py = (water?.getHeight ? water.seaY ?? 0 : 0) + (water?.getHeight ? water.getHeight(px, pz, time) : 0) + 0.15;
          // drift outward + slight puff up, plus the boat's backwash
          const vx = this._right.x * side * 1.6 - this._nose.x * 1.2 + jx * 0.3;
          const vz = this._right.z * side * 1.6 - this._nose.z * 1.2;
          this._emit(px, py, pz, vx, 0.5, vz);
        }
      }
    }
    // age + drift all live particles
    for (let i = 0; i < this.max; i++) {
      if (this.life0[i] <= 0) continue;
      this.life0[i] -= dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 1.2 * dt;                        // settle back down
    }
    this.aPos.needsUpdate = true; this.aLife.needsUpdate = true;
  }
}

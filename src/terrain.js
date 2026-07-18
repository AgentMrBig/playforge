import * as THREE from "three";

/**
 * Heightfield — terrain as an engine citizen.
 *
 *   const hf = new Heightfield({ size: 420, res: 192, heightAt: (x, z) => ... });
 *   world.spawn("terrain").mesh(hf.buildMesh(colorAt)).add(hf);
 *
 * - `heightAt(x, z)` world-space ground height (bilinear-sampled grid cache)
 * - Bodies automatically stand on it: physics Body checks any Heightfield
 *   in the world during its Y resolve (see physics.js)
 * - `buildMesh(colorAt)` displaced plane with per-vertex colors:
 *   colorAt(x, z, h, slope) → THREE.Color
 */
export class Heightfield {
  constructor({ size = 400, res = 192, heightAt }) {
    this.size = size;
    this.res = res;
    this._fn = heightAt;
    // cache the grid: res+1 × res+1 samples over [-size/2, size/2]
    this._h = new Float32Array((res + 1) * (res + 1));
    const half = size / 2, step = size / res;
    for (let j = 0; j <= res; j++)
      for (let i = 0; i <= res; i++)
        this._h[j * (res + 1) + i] = heightAt(-half + i * step, -half + j * step);
  }

  /** bilinear world-space height; -Infinity outside the field */
  heightAt(x, z) {
    const half = this.size / 2, step = this.size / this.res;
    let fx = (x + half) / step, fz = (z + half) / step;
    if (fx < -0.01 || fz < -0.01 || fx > this.res + 0.01 || fz > this.res + 0.01) return -Infinity;
    fx = Math.min(Math.max(fx, 0), this.res - 1e-6);
    fz = Math.min(Math.max(fz, 0), this.res - 1e-6);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const W = this.res + 1;
    const a = this._h[j * W + i], b = this._h[j * W + i + 1];
    const c = this._h[(j + 1) * W + i], d = this._h[(j + 1) * W + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** approximate slope (rise per unit run) at a point */
  slopeAt(x, z, e = 1.5) {
    const h = this.heightAt(x, z);
    const dx = Math.abs(this.heightAt(x + e, z) - h) / e;
    const dz = Math.abs(this.heightAt(x, z + e) - h) / e;
    return Math.max(dx, dz);
  }

  /** displaced, vertex-colored terrain mesh */
  buildMesh(colorAt) {
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.res, this.res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);
      colorAt(x, z, h, this.slopeAt(x, z), col);
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
    }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }
}

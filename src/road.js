import * as THREE from "three";

/**
 * RoadNetwork — place and edit roads as waypoint splines that conform to the
 * terrain, with lane markings. Reusable component:
 *
 *   const roads = new RoadNetwork({ ground: (x, z) => hf.heightAt(x, z) });
 *   world.spawn("roads").add(roads);
 *   roads.addRoad([[0,0],[40,0],[60,30]], { width: 8 });
 *
 * Each road is a Catmull-Rom spline through its nodes; the ribbon mesh is
 * regenerated whenever nodes change (that's what makes editing live). Layouts
 * round-trip through toJSON()/fromJSON() so you can save and reload them.
 *
 * Pair with RoadEditor for click-to-place authoring.
 */
export class RoadNetwork {
  constructor({ ground = () => 0, lift = 0.05, segPerNode = 12,
                texUrl = "textures/T_Road_Clean_01.png", tileLen = 20 } = {}) {
    this.ground = ground;
    this.lift = lift;
    this.segPerNode = segPerNode;
    this.tileLen = tileLen;             // metres of road per texture repeat (dash spacing)
    this.roads = [];                    // { nodes:[Vec3], width, group }
    this.group = new THREE.Group();
    // Real Synty road texture (Erik: make the roads look better): 2-lane asphalt
    // with a double-yellow center line + dashed lane markings baked in. UVs map
    // width→across (0..1) and length→along (tiled every tileLen m). polygonOffset
    // keeps the flush ribbon from z-fighting the baked-asphalt terrain under it —
    // so the markings come from the texture, no procedural lines needed.
    const tex = new THREE.TextureLoader().load(texUrl);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
    this._roadTex = tex;
    this._surfMat = new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this._surfMat._shared = true;
    // pale concrete curb/gutter strip that runs the road edges (real streets have one)
    this._curbMat = new THREE.MeshStandardMaterial({ color: 0x8c8a83, roughness: 1 });
    this._curbMat._shared = true;
  }

  /** generated weathered-asphalt texture: dark base, grit speckle, a lighter
   *  wheel-polished center band, and a couple of hairline cracks. */
  _makeAsphalt() {
    const S = 256, cv = (typeof document !== "undefined") ? document.createElement("canvas") : null;
    if (!cv) return null;
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    g.fillStyle = "#3a3e45"; g.fillRect(0, 0, S, S);
    // wheel-polished center band (vertical = along travel after UV rotate)
    const grad = g.createLinearGradient(0, 0, S, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(150,150,160,0.10)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    // grit speckle — light + dark flecks break the flat fill (the biggest win)
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = Math.random() * 1.3;
      const v = Math.random();
      g.fillStyle = v < 0.5 ? `rgba(20,22,26,${0.25 + Math.random() * 0.4})`
                            : `rgba(150,152,158,${0.08 + Math.random() * 0.22})`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    // a few hairline cracks
    g.strokeStyle = "rgba(15,16,19,0.55)"; g.lineWidth = 1;
    for (let c = 0; c < 5; c++) {
      let x = Math.random() * S, y = Math.random() * S;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 12; k++) { x += (Math.random() - 0.5) * 24; y += (Math.random() - 0.3) * 22; g.lineTo(x, y); }
      g.stroke();
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  init(entity, world) { world.scene.add(this.group); this.world = world; }
  dispose() { this.group.parent?.remove(this.group); }

  addRoad(points, { width = 8, closed = false } = {}) {
    const nodes = points.map((p) => Array.isArray(p) ? new THREE.Vector3(p[0], 0, p[1]) : p.clone());
    const road = { nodes, width, closed, group: new THREE.Group() };
    this.roads.push(road);
    this.group.add(road.group);
    this._rebuild(road);
    return road;
  }

  /** rebuild one road's geometry from its nodes (call after editing) */
  _rebuild(road) {
    road.group.clear();
    if (road.nodes.length < 2) {         // single node: show a marker dot
      if (road.nodes.length === 1) {
        const d = new THREE.Mesh(new THREE.CircleGeometry(road.width * 0.5, 20).rotateX(-Math.PI / 2), this._surfMat);
        d.position.copy(this._onGround(road.nodes[0]));
        road.group.add(d);
      }
      return;
    }
    const curve = new THREE.CatmullRomCurve3(road.nodes, !!road.closed, "catmullrom", 0.5);
    const n = Math.max(8, (road.nodes.length - (road.closed ? 0 : 1)) * this.segPerNode);
    const pts = curve.getPoints(n).map((p) => this._onGround(p));

    const hw = road.width * 0.5;
    const surfPos = [], surfIdx = [], surfUV = [];
    const dash = [], edgeL = [], edgeR = [], curbL = [], curbR = [];
    const up = new THREE.Vector3(0, 1, 0);
    const tan = new THREE.Vector3(), nrm = new THREE.Vector3();
    let arc = 0;                                         // accumulated length → texture V
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      tan.subVectors(b, a); tan.y = 0; tan.normalize();
      nrm.crossVectors(up, tan).normalize();           // road-plane left normal
      const L = new THREE.Vector3().copy(pts[i]).addScaledVector(nrm, hw);
      const R = new THREE.Vector3().copy(pts[i]).addScaledVector(nrm, -hw);
      surfPos.push(L.x, L.y, L.z, R.x, R.y, R.z);
      if (i > 0) arc += pts[i].distanceTo(pts[i - 1]);
      const vtex = arc / this.tileLen;                  // texture repeats every tileLen m (dash spacing)
      surfUV.push(0, vtex, 1, vtex);
      if (i > 0) {
        const v = (i - 1) * 2;
        surfIdx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
      // center dashes (every other span) + solid edge lines + concrete curbs
      if (i > 0 && i % 2 === 0) dash.push([pts[i - 1], pts[i], nrm, 0.22]);
      if (i > 0) {
        edgeL.push([pts[i - 1], pts[i], nrm, hw - 0.35, 0.12]);
        edgeR.push([pts[i - 1], pts[i], nrm, -(hw - 0.35), 0.12]);
        curbL.push([pts[i - 1], pts[i], nrm, hw + 0.22, 0.28]);
        curbR.push([pts[i - 1], pts[i], nrm, -(hw + 0.22), 0.28]);
      }
    }
    const surf = new THREE.BufferGeometry();
    surf.setAttribute("position", new THREE.Float32BufferAttribute(surfPos, 3));
    surf.setAttribute("uv", new THREE.Float32BufferAttribute(surfUV, 2));
    surf.setIndex(surfIdx);
    surf.computeVertexNormals();
    const surfMesh = new THREE.Mesh(surf, this._surfMat);
    surfMesh.receiveShadow = true;
    road.group.add(surfMesh);
    // lane lines + center stripe now come from the texture; keep the concrete
    // curbs that run the road edges (they sit a touch proud of the asphalt).
    road.group.add(this._ribbon(curbL, this._curbMat, 0.055));
    road.group.add(this._ribbon(curbR, this._curbMat, 0.055));
  }

  // build a thin ribbon from [a,b,normal,offset,halfWidth?] spans
  _ribbon(spans, mat, yBias) {
    const pos = [], idx = [];
    let v = 0;
    for (const [a, b, nrm, off, hw = 0.11] of spans) {
      const ca = new THREE.Vector3().copy(a).addScaledVector(nrm, off);
      const cb = new THREE.Vector3().copy(b).addScaledVector(nrm, off);
      pos.push(
        ca.x - nrm.x * hw, ca.y + yBias, ca.z - nrm.z * hw,
        ca.x + nrm.x * hw, ca.y + yBias, ca.z + nrm.z * hw,
        cb.x - nrm.x * hw, cb.y + yBias, cb.z - nrm.z * hw,
        cb.x + nrm.x * hw, cb.y + yBias, cb.z + nrm.z * hw,
      );
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      v += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }

  _onGround(p) { return new THREE.Vector3(p.x, this.ground(p.x, p.z) + this.lift, p.z); }

  // ---- editing API ---------------------------------------------------------
  appendNode(road, x, z) { road.nodes.push(new THREE.Vector3(x, 0, z)); this._rebuild(road); }
  moveNode(road, i, x, z) { road.nodes[i].set(x, 0, z); this._rebuild(road); }
  removeLastNode(road) { road.nodes.pop(); this._rebuild(road); }
  clear() { for (const r of this.roads) r.group.clear(); this.roads.length = 0; }

  toJSON() {
    return { roads: this.roads.map((r) => ({ width: r.width, closed: !!r.closed, nodes: r.nodes.map((n) => [+n.x.toFixed(2), +n.z.toFixed(2)]) })) };
  }
  fromJSON(data) {
    this.clear();
    for (const r of data.roads || []) this.addRoad(r.nodes, { width: r.width, closed: r.closed });
  }
}

/**
 * RoadEditor — click on the ground to drop road nodes; the road rebuilds live.
 * Attach alongside a RoadNetwork (needs an UNLOCKED cursor / orbit camera).
 *
 *   world.spawn("roadedit").add(new RoadEditor(roads, { width: 8 }));
 *
 * Left-click: add a node to the active road (each click extends it).
 * newRoad(): finish the current road, start a fresh one.
 * undo(): remove the last node.  save(): download the layout JSON.
 * A yellow ghost marker follows the cursor so you can see where a node lands.
 */
export class RoadEditor {
  constructor(net, { width = 8 } = {}) {
    this.net = net;
    this.width = width;
    this.active = null;
    this._ray = new THREE.Raycaster();
    this._ghost = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xffd11a, emissive: 0x554400 }));
    this._ghost.visible = false;
  }
  init(entity, world) { world.scene.add(this._ghost); }

  newRoad() { this.active = null; }
  undo() { if (this.active) this.net.removeLastNode(this.active); }
  save() {
    const data = JSON.stringify(this.net.toJSON(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "roads.json"; a.click();
    return data;
  }

  // march the camera ray down until it passes below the terrain surface
  _hitGround(cam, input, engine) {
    const el = engine.canvas;
    const nx = (input.pointer.x / el.clientWidth) * 2 - 1;
    const ny = -(input.pointer.y / el.clientHeight) * 2 + 1;
    this._ray.setFromCamera({ x: nx, y: ny }, cam);
    const o = this._ray.ray.origin, d = this._ray.ray.direction;
    let t = 0, prev = o.y - this.net.ground(o.x, o.z);
    for (let i = 0; i < 400; i++) {
      t += 1.5;
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const diff = y - this.net.ground(x, z);
      if (diff <= 0 && prev > 0) {                     // crossed the surface
        const f = prev / (prev - diff);                // refine
        const tt = t - 1.5 + 1.5 * f;
        return new THREE.Vector3(o.x + d.x * tt, 0, o.z + d.z * tt);
      }
      prev = diff;
      if (t > 4000) break;
    }
    return null;
  }

  update(dt, { engine, world }) {
    const hit = this._hitGround(world.camera, engine.input, engine);
    if (hit) { this._ghost.position.set(hit.x, this.net.ground(hit.x, hit.z) + 0.6, hit.z); this._ghost.visible = true; }
    else this._ghost.visible = false;
    if (engine.input.pressed("Mouse0") && hit) {
      if (!this.active) this.active = this.net.addRoad([[hit.x, hit.z]], { width: this.width });
      else this.net.appendNode(this.active, hit.x, hit.z);
    }
  }
}

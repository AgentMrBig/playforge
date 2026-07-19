// PlayForge combat — weapons, firing, hit detection. Owned by General.
// Framework shared by ranged + melee. Decoupled: it OWNS weapon defs, equip,
// input→fire, cooldown/ammo, and hit detection (ray/arc vs targets). It does NOT
// own damage visuals — hits go out through the injected `onHitCar(entity, amount,
// point, dir, knockback)` seam so car crumple stays in Ember's damage lane, and
// `effect`/`sound` seams keep FX/audio out of here too. Targets today = cars;
// NPCs slot into `targets()` later with no change to this file.

import * as THREE from "three";

// footprints/feel are first-pass; tune with Erik. url = loadProp path (pack has 21 weapons).
export const WEAPONS = {
  pistol:     { name: "Pistol",      url: "models/fabpack/weapons/SM_Pistol_01.FBX",     kind: "ranged", damage: 8,  range: 120, cooldown: 0.28, auto: false, spread: 0.010, pellets: 1, ammo: 12,  muzzle: 0.35 },
  shotgun:    { name: "Shotgun",     url: "models/fabpack/weapons/SM_Shotgun_01.FBX",    kind: "ranged", damage: 5,  range: 45,  cooldown: 0.75, auto: false, spread: 0.070, pellets: 8, ammo: 6,   muzzle: 0.60, snd: "shotgun" },
  smg:        { name: "SMG",         url: "models/fabpack/weapons/SM_Smg_01.FBX",        kind: "ranged", damage: 5,  range: 90,  cooldown: 0.08, auto: true,  spread: 0.028, pellets: 1, ammo: 30,  muzzle: 0.40 },
  rifle:      { name: "Rifle",       url: "models/fabpack/weapons/SM_Rifle_01.FBX",      kind: "ranged", damage: 14, range: 220, cooldown: 0.5,  auto: false, spread: 0.004, pellets: 1, ammo: 20,  muzzle: 0.55 },
  machinegun: { name: "Machine Gun", url: "models/fabpack/weapons/SM_MachineGun_01.FBX", kind: "ranged", damage: 9,  range: 160, cooldown: 0.06, auto: true,  spread: 0.045, pellets: 1, ammo: 100, muzzle: 0.65 },
  bat:        { name: "Baseball Bat",url: "models/fabpack/weapons/SM_BaseballBat_01.FBX",kind: "melee",  damage: 18, range: 3.4, cooldown: 0.5,  knockback: 15, arc: 1.1 },
  katana:     { name: "Katana",      url: "models/fabpack/weapons/SM_Katana_01.FBX",     kind: "melee",  damage: 32, range: 3.2, cooldown: 0.45, knockback: 11, arc: 1.3 },
  chainsaw:   { name: "Chainsaw",    url: "models/fabpack/weapons/SM_Chainsaw_01.FBX",   kind: "melee",  damage: 45, range: 3.0, cooldown: 0.3,  knockback: 8,  arc: 1.0, snd: "chainsaw" },
};
export const WEAPON_ORDER = ["pistol", "shotgun", "smg", "rifle", "machinegun", "bat", "katana", "chainsaw"];

/**
 * Pure hit test: nearest target whose world-AABB the ray crosses within maxDist.
 * @param {THREE.Ray} ray  origin+dir (dir normalized)
 * @param {Array} targets  entities with .object3d (or {min,max} boxes)
 * @param {number} maxDist
 * @returns {{entity, point:THREE.Vector3, distance:number}|null}
 */
export function rayHit(ray, targets, maxDist) {
  const box = new THREE.Box3(), hit = new THREE.Vector3();
  let best = null;
  for (const e of targets) {
    const obj = e.object3d || e;
    if (obj.isObject3D) box.setFromObject(obj); else if (e.min && e.max) box.set(e.min, e.max); else continue;
    if (!ray.intersectBox(box, hit)) continue;
    const d = ray.origin.distanceTo(hit);
    if (d <= maxDist && (!best || d < best.distance)) best = { entity: e, point: hit.clone(), distance: d };
  }
  return best;
}

/** Pure melee test: targets within `range` and inside a `arc` (radians) cone ahead of `from` along `fwd` (xz). */
export function meleeHits(from, fwd, range, arc, targets) {
  const out = [];
  const fx = fwd.x, fz = fwd.z, fl = Math.hypot(fx, fz) || 1;
  for (const e of targets) {
    const p = (e.object3d || e).position || e.position; if (!p) continue;
    const dx = p.x - from.x, dz = p.z - from.z, dist = Math.hypot(dx, dz);
    if (dist > range || dist < 0.01) continue;
    const dot = (dx * fx + dz * fz) / (dist * fl);
    if (Math.acos(Math.max(-1, Math.min(1, dot))) <= arc * 0.5) out.push({ entity: e, dist, dir: new THREE.Vector3(dx / dist, 0, dz / dist) });
  }
  return out;
}

export class CombatSystem {
  /**
   * @param {object} o
   * @param {object} o.camera  THREE camera (ranged aims down its forward)
   * @param {object} o.input   Input (down/pressed/bound "attack")
   * @param {()=>Array} o.targets  returns current target entities (cars now)
   * @param {(url)=>Promise<{group,size}>} o.loadProp
   * @param {object} o.player  entity to hang the weapon model on (optional)
   * @param {(entity,amount,point,dir,knockback)=>void} o.onHitCar  Ember's damage seam
   * @param {(kind,point,dir)=>void} [o.effect]  spawn muzzle/impact FX
   * @param {(name)=>void} [o.sound]
   */
  constructor({ camera, input, targets, loadProp, player = null, scene = null, onHitCar, effect, sound }) {
    this.camera = camera; this.input = input; this.targets = targets; this.loadProp = loadProp;
    this.player = player; this.scene = scene; this._fx = [];
    this.onHitCar = onHitCar || (() => {}); this.effect = effect || (() => {}); this.sound = sound || (() => {});
    this.idx = 0; this.weaponId = WEAPON_ORDER[0]; this.weapon = WEAPONS[this.weaponId];
    this.ammo = this.weapon.ammo ?? Infinity; this._cool = 0; this._model = null; this.enabled = true;
    this.hold = { pos: [0, 0, 0.06], rot: [0, Math.PI / 2, 0] };   // in-hand grip (live-tunable via setHold)
    this.muzzleEnd = 1;   // which end of the barrel axis is the muzzle (+1/-1); flipMuzzle() toggles
    this._swing = null;                                            // active melee swing animation
    input.bind?.("attack", ["Mouse0", "KeyJ"]);
    input.bind?.("nextWeapon", ["KeyQ"]);
  }

  async equip(id) {
    if (!WEAPONS[id]) return;
    this.weaponId = id; this.weapon = WEAPONS[id]; this.ammo = this.weapon.ammo ?? Infinity; this._cool = 0;
    if (this.loadProp && this.player?.object3d) {
      try {
        const { group } = await this.loadProp(this.weapon.url);
        this._holder?.parent?.remove(this._holder);
        // MUZZLE MARKER — a point CHILD of the gun locked to the barrel tip (Erik: the flash
        // must be fixed to the gun, not recomputed from the camera each shot). Barrel = the
        // model's longest local axis; muzzleEnd (+1/-1) picks the muzzle end vs the stock.
        {
          const lb = new THREE.Box3().setFromObject(group);
          const lc = lb.getCenter(new THREE.Vector3()), lsz = lb.getSize(new THREE.Vector3());
          const ax = (lsz.x >= lsz.y && lsz.x >= lsz.z) ? "x" : (lsz.z >= lsz.y) ? "z" : "y";
          const marker = new THREE.Object3D();
          marker.position.copy(lc); marker.position[ax] += this.muzzleEnd * 0.5 * lsz[ax];
          group.add(marker); this._muzzleMarker = marker; this._muzzleAxis = ax; this._muzzleHalf = 0.5 * lsz[ax];
        }
        // attach to the REAL skinned hand bone (the animated one, from the skeleton). A plain
        // traverse for isBone grabs this FBX's DEAD DUPLICATE bones, so the gun floated off the
        // root instead of riding the hand (Erik). Skeleton bones are the deform bones the anim moves.
        let hand = null;
        this.player.object3d.traverse((o) => {
          if (!hand && o.isSkinnedMesh && o.skeleton) hand = o.skeleton.bones.find((b) => /righthand|hand_r/i.test(b.name)) || null;
        });
        this.player.object3d.updateWorldMatrix(true, true);
        const holder = new THREE.Group();
        holder.add(group);
        if (hand) {
          // the skeleton is cm-scaled; cancel the bone's world scale so the metre-prop reads real size
          const s = hand.getWorldScale(new THREE.Vector3()).x || 1;
          holder.scale.setScalar(1 / s);
          holder.position.fromArray(this.hold.pos);
          holder.rotation.fromArray(this.hold.rot);
          hand.add(holder);
        } else {
          holder.position.set(0.28, 0.95, 0.35);   // fallback: body-frame hand height
          this.player.object3d.add(holder);
        }
        this._holder = holder; this._model = group; this._onHand = !!hand;
      } catch { /* model optional; combat still works without a visible weapon */ }
    }
  }
  /** live-tune the in-hand weapon placement from the console: __pfCombat.setHold([x,y,z],[rx,ry,rz]) */
  setHold(pos, rot) {
    if (pos) this.hold.pos = pos; if (rot) this.hold.rot = rot;
    if (this._holder && this._onHand) { this._holder.position.fromArray(this.hold.pos); this._holder.rotation.fromArray(this.hold.rot); }
  }
  cycle(dir = 1) { this.idx = (this.idx + dir + WEAPON_ORDER.length) % WEAPON_ORDER.length; return this.equip(WEAPON_ORDER[this.idx]); }

  update(dt) {
    this._updateFX(dt);                 // FX fade runs even while driving/disabled
    this._updateSwing(dt);              // melee swing animation
    if (!this.enabled) return;
    this._cool = Math.max(0, this._cool - dt);
    if (this.input.pressed?.("nextWeapon")) this.cycle(1);
    const wantFire = this.weapon.auto ? this.input.held?.("attack") : this.input.pressed?.("attack");
    if (wantFire && this._cool <= 0 && this.ammo > 0) this.fire();
  }

  fire() {
    const w = this.weapon;
    this._cool = w.cooldown; if (Number.isFinite(this.ammo)) this.ammo--;
    if (w.kind === "melee") return this._melee(w);
    // ranged: raycast from the camera, one ray per pellet with spread
    const origin = new THREE.Vector3(); this.camera.getWorldPosition(origin);
    const base = new THREE.Vector3(); this.camera.getWorldDirection(base);
    // muzzle = the BARREL TIP, not the hand/pivot (Erik: a gun always fires from the barrel).
    // Project the weapon model's world bbox onto the firing direction and take the front face —
    // robust for any gun orientation. Falls back to a point ahead of the camera with no model.
    const muzzleWorld = this._muzzle(base, w);
    for (let p = 0; p < (w.pellets || 1); p++) {
      const dir = base.clone();
      dir.x += (Math.random() - 0.5) * 2 * w.spread; dir.y += (Math.random() - 0.5) * 2 * w.spread; dir.z += (Math.random() - 0.5) * 2 * w.spread;
      dir.normalize();
      const hit = rayHit(new THREE.Ray(origin, dir), this.targets(), w.range);
      const end = hit ? hit.point : origin.clone().addScaledVector(dir, w.range);
      this._tracer(muzzleWorld, end);
      if (hit) { this.onHitCar(hit.entity, w.damage, hit.point, dir, w.damage * 0.15); this._impact(hit.point); this.effect("impact", hit.point, dir); }
    }
    this._muzzleFlash(muzzleWorld); this.effect("muzzle", muzzleWorld, base); this.sound(w.snd || "shot");
  }

  /** barrel tip in world space — the marker CHILD locked to the gun, so it's always the barrel */
  _muzzle(dir, w) {
    if (this._muzzleMarker) return this._muzzleMarker.getWorldPosition(new THREE.Vector3());
    const o = new THREE.Vector3(); this.camera.getWorldPosition(o); return o.addScaledVector(dir, w.muzzle || 0.4);
  }
  /** if the flash comes off the STOCK, flip the marker to the other end: __pfCombat.flipMuzzle() */
  flipMuzzle() {
    if (this._muzzleMarker) this._muzzleMarker.position[this._muzzleAxis] -= 2 * this.muzzleEnd * this._muzzleHalf;
    this.muzzleEnd *= -1;
  }

  _melee(w) {
    this._swing = { t: 0, dur: Math.min(0.28, w.cooldown) };   // trigger the swing animation
    const from = new THREE.Vector3(); (this.player?.object3d || this.camera).getWorldPosition(from);
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const hits = meleeHits(from, fwd, w.range, w.arc, this.targets());
    for (const h of hits) { this.onHitCar(h.entity, w.damage, (h.entity.object3d || h.entity).position, h.dir, w.knockback); this._impact((h.entity.object3d || h.entity).position); }
    this.effect("swing", from, fwd); this.sound(w.snd || "swing");
  }
  _updateSwing(dt) {
    if (!this._swing || !this._holder || !this._onHand) return;
    this._swing.t += dt;
    const p = this._swing.t / this._swing.dur;
    if (p >= 1) { this._swing = null; this._holder.rotation.fromArray(this.hold.rot); return; }
    const arc = Math.sin(p * Math.PI) * 1.5;                   // wind up → follow through
    this._holder.rotation.set(this.hold.rot[0] - arc, this.hold.rot[1], this.hold.rot[2]);
  }

  // ---- FX: self-managed additive bursts, faded + auto-removed in _updateFX ----
  _push(obj, ttl) { if (!this.scene) return; this.scene.add(obj); this._fx.push({ obj, ttl, max: ttl }); }
  _flash(pos, color, r, ttl) {
    if (!this.scene) return;
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(pos); this._push(m, ttl);
  }
  _muzzleFlash(pos) { this._flash(pos, 0xfff2a0, 0.12, 0.06); }
  _impact(pos) { this._flash(pos, 0xffa040, 0.16, 0.14); }
  _tracer(a, b) {
    if (!this.scene) return;
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xffd060, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this._push(l, 0.05);
  }
  _updateFX(dt) {
    for (let i = this._fx.length - 1; i >= 0; i--) {
      const f = this._fx[i]; f.ttl -= dt;
      const k = Math.max(0, f.ttl / f.max);
      if (f.obj.material) f.obj.material.opacity = k;
      if (f.obj.geometry?.type === "SphereGeometry") f.obj.scale.setScalar(0.6 + (1 - k) * 1.6);  // burst outward as it fades
      if (f.ttl <= 0) {
        this.scene?.remove(f.obj);
        f.obj.geometry?.dispose?.(); f.obj.material?.dispose?.();
        this._fx.splice(i, 1);
      }
    }
  }
}

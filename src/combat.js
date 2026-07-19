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
  shotgun:    { name: "Shotgun",     url: "models/fabpack/weapons/SM_Shotgun_01.FBX",    kind: "ranged", damage: 5,  range: 45,  cooldown: 0.75, auto: false, spread: 0.070, pellets: 8, ammo: 6,   muzzle: 0.60 },
  smg:        { name: "SMG",         url: "models/fabpack/weapons/SM_Smg_01.FBX",        kind: "ranged", damage: 5,  range: 90,  cooldown: 0.08, auto: true,  spread: 0.028, pellets: 1, ammo: 30,  muzzle: 0.40 },
  rifle:      { name: "Rifle",       url: "models/fabpack/weapons/SM_Rifle_01.FBX",      kind: "ranged", damage: 14, range: 220, cooldown: 0.5,  auto: false, spread: 0.004, pellets: 1, ammo: 20,  muzzle: 0.55 },
  machinegun: { name: "Machine Gun", url: "models/fabpack/weapons/SM_MachineGun_01.FBX", kind: "ranged", damage: 9,  range: 160, cooldown: 0.06, auto: true,  spread: 0.045, pellets: 1, ammo: 100, muzzle: 0.65 },
  bat:        { name: "Baseball Bat",url: "models/fabpack/weapons/SM_BaseballBat_01.FBX",kind: "melee",  damage: 18, range: 3.4, cooldown: 0.5,  knockback: 15, arc: 1.1 },
  katana:     { name: "Katana",      url: "models/fabpack/weapons/SM_Katana_01.FBX",     kind: "melee",  damage: 32, range: 3.2, cooldown: 0.45, knockback: 11, arc: 1.3 },
};
export const WEAPON_ORDER = ["pistol", "shotgun", "smg", "rifle", "machinegun", "bat", "katana"];

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
  constructor({ camera, input, targets, loadProp, player = null, onHitCar, effect, sound }) {
    this.camera = camera; this.input = input; this.targets = targets; this.loadProp = loadProp;
    this.player = player; this.onHitCar = onHitCar || (() => {}); this.effect = effect || (() => {}); this.sound = sound || (() => {});
    this.idx = 0; this.weaponId = WEAPON_ORDER[0]; this.weapon = WEAPONS[this.weaponId];
    this.ammo = this.weapon.ammo ?? Infinity; this._cool = 0; this._model = null; this.enabled = true;
    this.hold = { pos: [0, 0, 0.06], rot: [0, Math.PI / 2, 0] };   // in-hand grip (live-tunable via setHold)
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
        // find the right-hand bone (character.js normalises to Mixamo names: "RightHand")
        let hand = null;
        this.player.object3d.updateWorldMatrix(true, true);
        this.player.object3d.traverse((o) => { if (!hand && o.isBone && /righthand|hand_r|mixamorig.*righthand/i.test(o.name)) hand = o; });
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
    for (let p = 0; p < (w.pellets || 1); p++) {
      const dir = base.clone();
      dir.x += (Math.random() - 0.5) * 2 * w.spread; dir.y += (Math.random() - 0.5) * 2 * w.spread; dir.z += (Math.random() - 0.5) * 2 * w.spread;
      dir.normalize();
      const hit = rayHit(new THREE.Ray(origin, dir), this.targets(), w.range);
      if (hit) { this.onHitCar(hit.entity, w.damage, hit.point, dir, w.damage * 0.15); this.effect("impact", hit.point, dir); }
    }
    this.effect("muzzle", origin.addScaledVector(base, w.muzzle), base); this.sound("shot");
  }

  _melee(w) {
    const from = new THREE.Vector3(); (this.player?.object3d || this.camera).getWorldPosition(from);
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const hits = meleeHits(from, fwd, w.range, w.arc, this.targets());
    for (const h of hits) this.onHitCar(h.entity, w.damage, (h.entity.object3d || h.entity).position, h.dir, w.knockback);
    this.effect("swing", from, fwd); this.sound(hits.length ? "melee_hit" : "swing");
  }
}

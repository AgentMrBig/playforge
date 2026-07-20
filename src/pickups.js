// PlayForge pickup system — Ember's lane (Erik 2026-07-20: "bring in pickups —
// props, ALL ammo, and the guns — built as a SPAWNER, not scattered on the
// ground"). A data-driven spawner: pickups live at defined spawn points, bob +
// spin so they read as collectible, grant on walk-over (or E), then respawn on a
// timer. Grants route through General's combat seam (window.__pfCombat) so guns
// and ammo actually unlock/arm; props/health route to their own stat.
//
// Adding a pickup type = one row in PICKUP_DEFS. Placing one = one row in the
// spawns[] list handed to mountPickups(). Fully defensive: a bad model or a
// missing seam never breaks the boot — that pickup just no-ops.

import * as THREE from "three";

// ---- pickup type catalog -----------------------------------------------------
// kind: how the grant is applied. model/atlas/textureDir: the Synty asset (curated
// into public/models/<pack>/). weaponId/ammoType/amount: what it gives. trigger:
// "walkover" (auto on proximity) or "use" (press E while near). respawn: seconds
// until it comes back (0 = one-shot). scale/spin/bob tune the floating visual.
export const PICKUP_DEFS = {
  // GUNS (GangWarfare rigged weapon meshes → combat weapon ids). trigger "use"
  // so you choose to swap. Grants the weapon + a starter magazine.
  pistol:     { kind: "weapon", weaponId: "pistol",     ammoType: "small", amount: 24, trigger: "walkover", respawn: 20,
                model: "models/gangwarfare/SK_Wep_Pistol_Revolver_01.FBX", glow: 0x66ccff },
  smg:        { kind: "weapon", weaponId: "smg",        ammoType: "small", amount: 40, trigger: "walkover", respawn: 25,
                model: "models/gangwarfare/SK_Wep_SubMachineGun_01.FBX",   glow: 0x66ccff },
  machinegun: { kind: "weapon", weaponId: "machinegun", ammoType: "small", amount: 60, trigger: "walkover", respawn: 30,
                model: "models/gangwarfare/SK_Wep_Machine_Pistol_01.FBX",  glow: 0x66ccff },
  shotgun:    { kind: "weapon", weaponId: "shotgun",    ammoType: "shells", amount: 12, trigger: "walkover", respawn: 25,
                model: "models/gangwarfare/SK_Wep_Shotgun_01.FBX",         glow: 0x66ccff },
  rifle:      { kind: "weapon", weaponId: "rifle",      ammoType: "large", amount: 30, trigger: "walkover", respawn: 30,
                model: "models/gangwarfare/SK_Wep_Rifle_Gold_01.FBX",      glow: 0xffcc44 },

  // AMMO (Heist ammo meshes → typed reserve). walk-over, fast respawn.
  ammo_small:  { kind: "ammo", ammoType: "small",  amount: 30, trigger: "walkover", respawn: 15,
                 model: "models/heist/SM_Wep_Ammo_BulletSmall_01.FBX", atlas: "T_PolygonHeist_01_A.PNG", textureDir: "models/heist", glow: 0xffee88 },
  ammo_large:  { kind: "ammo", ammoType: "large",  amount: 20, trigger: "walkover", respawn: 15,
                 model: "models/heist/SM_Wep_Ammo_BulletLarge_01.FBX", atlas: "T_PolygonHeist_01_A.PNG", textureDir: "models/heist", glow: 0xffaa44 },
  ammo_shells: { kind: "ammo", ammoType: "shells", amount: 8,  trigger: "walkover", respawn: 15,
                 model: "models/heist/SM_Wep_Ammo_Shotgun.FBX",       atlas: "T_PolygonHeist_01_A.PNG", textureDir: "models/heist", glow: 0xff8844 },

  // HEALTH (a supply prop → player stat). Slow respawn so it's a real find.
  health:      { kind: "health", amount: 25, trigger: "walkover", respawn: 40,
                 model: "models/heist/SM_Item_AmmoPack_01.FBX", atlas: "T_PolygonHeist_01_A.PNG", textureDir: "models/heist", glow: 0x66ff88 },
};

const GW_ATLAS = { atlas: "T_PolygonGangWarfare_01_A.PNG", textureDir: "models/gangwarfare" };

// ---- grant seam (routes into combat / player stats) --------------------------
// General's combat grant API (may not be live yet — every call is optional-chained
// so a missing seam is a silent no-op, not a crash). Ember proposed:
//   combat.give(weaponId, ammo)   unlock weapon + starter ammo
//   combat.addAmmo(type, n)       add to a typed reserve (small/large/shells)
function applyGrant(def, ctx) {
  const combat = (typeof window !== "undefined" && window.__pfCombat) || null;
  switch (def.kind) {
    case "weapon":
      if (combat?.give) { combat.give(def.weaponId, def.amount); return true; }
      // fallback: at least equip it if the seam isn't in yet
      if (combat?.equip) { combat.equip(def.weaponId); return true; }
      return false;
    case "ammo":
      if (combat?.addAmmo) { combat.addAmmo(def.ammoType, def.amount); return true; }
      return false;
    case "health": {
      const pl = ctx.player;
      if (pl && typeof pl.health === "number") { pl.health = Math.min(pl.maxHealth ?? 100, pl.health + def.amount); return true; }
      return false;
    }
    default: return false;
  }
}

// ---- a single spawned pickup (Component: bob/spin, proximity, grant, respawn) -
export class Pickup {
  /** @param {string} type key into PICKUP_DEFS  @param {THREE.Object3D} model */
  constructor(type, model, def, deps) {
    this.type = type; this.def = def; this.model = model; this.deps = deps;
    this.baseY = 0;            // ground height at the spawn, set on init
    this.t = 0;                // bob phase
    this.active = true;        // collectible right now?
    this.cooldown = 0;         // respawn countdown
    this._halo = null;
  }

  init(entity) {
    this.entity = entity;
    const p = entity.object3d.position;
    this.baseY = this.deps.heightAt ? this.deps.heightAt(p.x, p.z) : p.y;
    entity.object3d.add(this.model);
    // lift so it floats readably above the ground
    this.model.position.set(0, 0.6, 0);
    // a soft glow halo so pickups pop in the world (cheap sprite-free ring light)
    const halo = new THREE.PointLight(this.def.glow ?? 0xffffff, 0.6, 3.5, 2);
    halo.position.set(0, 0.7, 0);
    entity.object3d.add(halo);
    this._halo = halo;
  }

  update(dt, ctx) {
    const o = this.entity.object3d;
    if (!this.active) {
      // respawning: count down, then pop back in
      this.cooldown -= dt;
      if (this.cooldown <= 0) this._setActive(true);
      return;
    }
    this.t += dt;
    // float + spin
    this.model.position.y = 0.6 + Math.sin(this.t * 2.2) * 0.12;
    this.model.rotation.y += dt * 1.4;
    // proximity to the player
    const pl = this.deps.player;
    if (!pl) return;
    const px = pl.position.x - o.position.x, pz = pl.position.z - o.position.z;
    const near = (px * px + pz * pz) < (this.def.pickupR ?? 1.6) ** 2;
    if (!near) return;
    if (this.def.trigger === "use") {
      const input = ctx.input;
      const pressed = input?.pressed?.("KeyF") || input?.pressed?.("KeyE");
      if (!pressed) { this._prompt(true); return; }
    }
    this._collect(ctx);
  }

  _collect(ctx) {
    const ok = applyGrant(this.def, { player: this.deps.player });
    this.deps.onPickup?.(this.type, this.def, ok);
    if (this.def.respawn > 0) { this.cooldown = this.def.respawn; this._setActive(false); }
    else this.entity.world?.destroy(this.entity);
  }

  _setActive(on) {
    this.active = on;
    this.model.visible = on;
    if (this._halo) this._halo.visible = on;
  }

  _prompt() { /* HUD "press F" prompt hook — wired when the pickup HUD lands */ }

  dispose() { this._halo = null; }
}

// ---- mount a set of pickups into the world -----------------------------------
// deps: { world, loadProp, player, heightAt, phys, physReady }
// spawns: [{ type, x, z, rot? }] — WHERE each pickup sits (spawn points, not scatter).
export async function mountPickups(deps, spawns = []) {
  const { world, loadProp } = deps;
  if (!world || !loadProp) { console.warn("[pickups] missing world/loadProp — skipped"); return []; }
  // load each distinct model once, clone per spawn
  const need = [...new Set(spawns.map((s) => s.type))].filter((t) => PICKUP_DEFS[t]);
  const models = {};
  await Promise.all(need.map(async (type) => {
    const def = PICKUP_DEFS[type];
    const opts = def.atlas
      ? { texture: def.atlas, textureDir: def.textureDir, textureFlipY: true }
      : GW_ATLAS.atlas ? { texture: GW_ATLAS.atlas, textureDir: GW_ATLAS.textureDir, textureFlipY: true } : {};
    const r = await loadProp(def.model, opts).catch((e) => { console.warn(`[pickups] ${type} load failed:`, e.message); return null; });
    if (r?.group) models[type] = r.group;
  }));

  const made = [];
  for (const s of spawns) {
    const def = PICKUP_DEFS[s.type], src = models[s.type];
    if (!def || !src) continue;
    const model = src.clone(true);
    const e = world.spawn(`pickup:${s.type}`);
    const y = deps.heightAt ? deps.heightAt(s.x, s.z) : 0;
    e.object3d.position.set(s.x, y, s.z);
    if (s.rot != null) model.rotation.y = s.rot;
    e.add(new Pickup(s.type, model, def, deps));
    made.push(e);
  }
  console.log(`[pickups] mounted ${made.length} pickups (${need.length} models)`);
  return made;
}

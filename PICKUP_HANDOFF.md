# Pickup System — handoff to Ember (from General)

Erik's ask: **bring in pickups — props-folder items, ALL ammo pickups, and the guns from the packs. Build a pickup SYSTEM that spawns them — do NOT scatter them all on the ground.**

This doc = (1) how I've been adding Synty content so you can pull assets the same way, (2) the exact asset paths, (3) the combat seam your gun/ammo pickups grant into (my lane — call the seam, don't reach into combat internals).

---

## 1. The Synty content pipeline (how props/guns/ammo come in)

**One shared atlas per pack textures everything.** You don't texture meshes individually — you bind the pack's `T_<Pack>_01_A.PNG` atlas and every mesh's baked UVs sample it.

**Steps:**
1. Raw packs live flattened + **gitignored** in `Assets/<Pack>/` (multi-GB — never commit these). Find the FBX you want there.
2. Copy the specific FBX **+ the pack atlas PNG** into `public/models/<pack>/`.
   - ⚠️ Assets MUST go in `public/models/`, NOT `docs/` — Vite's `emptyOutDir` wipes `docs/` on every build and re-copies from `public/`. The build then puts them in `docs/models/<pack>/`.
3. Load + texture in one call:
   ```js
   const r = await loadProp("models/heist/SM_Item_AmmoPack_01.FBX",
     { texture: "T_PolygonHeist_01_A.PNG", textureDir: "models/heist", textureFlipY: true });
   // r.group = the textured THREE.Object3D, r.size = bbox dims
   ```
   - ★ **`textureFlipY: true`** for these packs (props/env/characters). `false` samples the DARK half of the palette atlas — that was my "gangsters too black" bug. Vehicles are the exception (separate `T_<Pack>_Vehicle_01` atlas + `textureMap`).
   - Atlas naming: main = `T_<Pack>_01_A.PNG`. If a mesh looks wrong, the mapping is by material name `Mat_<Pack>_NN_X` → `T_<Pack>_NN_X.PNG`.
4. `window.__pfLoadProp` is exposed — you can test-load a prop from the console live before wiring it.
5. GangWarfare atlas is ALREADY in `public/models/gangwarfare/T_PolygonGangWarfare_01_A.PNG`. **Heist needs its atlas copied**: `Assets/PolygonHeist/Textures/…/T_PolygonHeist_01_A.PNG` → `public/models/heist/`.

**Deploy discipline (bit me hard — please follow):**
- `npm run build` → `git add <your specific files> public/models/... docs` → commit → push.
- **VERIFY**: `curl` the actual `docs/assets/main-*.js` hash for HTTP **200** AND boot-test (`window.__pf` defined, 0 console errors). Grepping index.html for the hash is NOT enough — it hides a 404'd bundle.
- **NEVER `git add -A`** (shared tree — you'll sweep my uncommitted work, I'll sweep yours). Add specific files only.
- `.gitignore`: keep raw `Assets/` out; commit only the curated FBX+atlas under `public/models/`.

---

## 2. Asset paths for the pickups

**Guns** (rigged meshes, GangWarfare): `Assets/PolygonGangWarfare/Meshes/Weapons_Rigged/`
`SK_Wep_Pistol_Revolver_01`, `SK_Wep_Pistol_Gold_01`, `SK_Wep_Machine_Pistol_01`, `SK_Wep_SubMachineGun_01`, `SK_Wep_Shotgun_01`, `SK_Wep_Rifle_Gold_01`
Heist has more: `Assets/PolygonHeist/Meshes/Weapons/` (`SM_Wep_PistolBandit_01`, rifles, attachments, `SM_Wep_Grenade_01`, `SM_Wep_Flashbang_01`).

**Ammo** (Heist): `Assets/PolygonHeist/Meshes/Items/SM_Item_AmmoPack_01/02.FBX` + `Assets/PolygonHeist/Meshes/Weapons/SM_Wep_Ammo_BulletLarge_01`, `_BulletSmall_01`, `_Shotgun`.

**Props / misc pickups**: the `Prop_` meshes in `Assets/PolygonGangWarfare/Meshes/Props/` and `Assets/PolygonHeist/Meshes/…` (health/cash/supplies — your pick).

---

## 3. The combat seam (my lane — grant items through this)

Guns/ammo need to mean something in combat. The combat model is in `src/combat.js`:
- `WEAPONS` = defs keyed by id (`pistol`, `shotgun`, `smg`, `rifle`, `machinegun`, `bat`, `katana`, `chainsaw`) — each has `url`, `damage`, `ammo`, etc.
- Live instance is `window.__pfCombat`: `equip(id)`, `cycle(dir)`, `this.weaponId`, `this.ammo` (per-weapon rounds).
- Today **all weapons are always cycle-available** and ammo is per-weapon (no reserve pool).

**Your pickup should NOT poke combat internals.** So that pickups actually *unlock* things, I'll add a clean grant seam on my side:
```js
combat.give(weaponId, ammoAmount)   // unlock a weapon into inventory + add ammo
combat.addAmmo(amount)              // ammo-only pickup → current/typed reserve
combat.owned                        // Set of unlocked weapon ids (cycle only iterates these)
```
Plus an inventory model so you only have what you've picked up (right now everything's free).

**→ Tell me which weapon ids you're mapping the Synty guns to** (e.g. `SK_Wep_Shotgun_01` → `shotgun`) and whether you want ammo typed (pistol/rifle/shotgun) or a single pool, and I'll ship `give`/`addAmmo`/`owned` + inventory to match — so your spawn system just calls `combat.give(...)` on pickup.

---

## 4. The system Erik wants (your build)

Not ground-scatter — a **spawner**: pickups placed by logic (spawn points, in buildings / on the map, respawn timers), each a small floating/rotating world object with a pickup trigger (walk-over or `E`), that grants via the combat seam (guns/ammo) or a stat (health/cash). Suggest a data-driven table `{ kind, model, atlas, grant, spawnRule }` so adding a pickup type is one row.

Ping me for the combat seam and I'll turn it around fast. — General

import * as THREE from "three";
import { CharacterBody, R } from "./phys.js";
import { ThirdPersonRig } from "./thirdperson.js";
import { Ragdoll } from "./ragdoll.js";
import { loadCharacter } from "./character.js";
import { TrajectoryLean } from "./charlean.js";
import { FootPlant } from "./footplant.js";
import { solveTwoBone, limbChain, currentBendPole } from "./ik.js";

/**
 * createCharacterController — THE reusable main character controller (the character
 * analog of createCarRig). One drop-in that bundles what was proven in the Big
 * Island demo + the Ragdoll Lab into a single component:
 *
 *   • a Rapier CAPSULE (CharacterBody) for horizontal collision vs the world
 *   • RAYCAST GROUND SUPPORT (roll-our-own, like the car's raycast suspension):
 *     a ray finds the ground and holds the feet on it, so he NEVER sinks and it
 *     works on uneven ground — the foundation for weight-bearing IK feet. This
 *     replaces Rapier's flaky KinematicCharacterController grounding (which let a
 *     standing capsule fall straight through a flat plane).
 *   • camera-relative walk / run (Shift) / jump / optional fly (G)
 *   • a third-person camera (ThirdPersonRig): orbit, zoom, occlusion; `dragOrbit`
 *     makes it set-and-stay (left-drag) so the cursor is free for menus
 *   • idle / walk / run / jump animation state machine
 *   • PROCEDURAL JUICE: TrajectoryLean (lean into turns/accel) + FootPlant (foot IK)
 *   • RAGDOLL integration: go down on a hard hit, a braced STAGGER on a light hit
 *     (he TRIES TO STAY UP), muscle/authoring mode, natural get-up on settle.
 *
 *   const ch = createCharacterController(world, { scene, phys, camera: true });
 *   await ch.ready;
 *   ch.triggers.drop();  ch.hit(point, impulseVec, power);
 *
 * The gradient anim↔physics blend rig layers on top of this foundation next.
 *
 * @param world  the ECS World (spawns the player entity into it)
 */
const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_ANIMS = [
  { name: "idle", url: "models/character/anims/idle.fbx" },
  { name: "walk", url: "models/character/anims/walking.fbx" },
  { name: "run", url: "models/character/anims/running.fbx" },
  { name: "jump", url: "models/character/anims/jumping up.fbx" },
  { name: "getupFront", url: "models/character/anims/getup_front.fbx" },
  { name: "getupBack", url: "models/character/anims/getup_back.fbx" },
];

export function createCharacterController(world, {
  scene, phys,
  model = "models/character/humanoid_male.fbx",
  characterOpts = { textureDir: "models/character", texture: "base_texture.png", targetHeight: 1.8 },
  anims = DEFAULT_ANIMS,
  spawn = [0, 0, 0],
  camera = true, dragOrbit = false,
  heightAt = () => 0,
  walkSpeed = 5.0, runSpeed = 9.3, jumpSpeed = 9,
  fly = false, groundRay = true, lean = true, footPlant = true,
  tone = 1.9,
  radius = 0.32, height = 1.7,
  onReady = null,
} = {}) {
  // ── the player entity: a kinematic capsule the world can't pass through ──
  const entity = world.spawn("player").at(spawn[0], spawn[1], spawn[2])
    .add(new CharacterBody({ radius, height }));
  const body = entity.components.find((c) => c instanceof CharacterBody);
  // WE own the vertical (gravity + ground + jump) via a downward ray — Rapier's
  // KinematicCharacterController only does HORIZONTAL collision now. Its own
  // grounding let a standing capsule fall through a flat plane, and fighting it
  // with position corrections made him oscillate after a jump. `flying` tells
  // CharacterBody to skip its gravity/snap/ground-zeroing so there's nothing to
  // fight — the roll-our-own move, same lesson as the car's raycast suspension.
  body.flying = true;
  const GRAVITY = 20;
  let grounded = true, freeFly = false, airT = 0, smoothVisY = null, bobPhase = 0, lastBob = 0;
  // live-tunable gait bob (console/sliders): div = metres per bob cycle (lower = faster),
  // amp = bob height (m), phase = phase offset in cycles. Dial vs the footstep graph.
  if (typeof window !== "undefined" && !window.__bobTune) window.__bobTune = { amp: 0.07, floor: 0.13, swing: 0.35 };
  const _bobDEF = { amp: 0.07, floor: 0.13, swing: 0.35 };   // auto-sync: amp=bob height, floor=planted-foot height, swing=lift range
  // momentum / weight: how fast horizontal velocity chases the target (m/s²). accel =
  // spin-up, decel = coast-down, turn = facing turn rate. Higher = snappier, lower = weightier.
  if (typeof window !== "undefined" && !window.__moveTune) window.__moveTune = { accel: 22, decel: 16, turn: 8 };
  const _moveDEF = { accel: 22, decel: 16, turn: 8 };

  let state = "anim";          // anim | ragdoll | getup | stagger | vault
  let getupTimer = 0, staggerTimer = 0;
  // parkour: vault over an obstacle too tall to step (a timed procedural arc + hand plant)
  let vaultT = 0, vaultCd = 0; const vaultDur = 0.55;
  const vaultStart = new THREE.Vector3(), vaultLand = new THREE.Vector3(), vaultTop = new THREE.Vector3();
  let rag = null, animator = null, bones = null, visual = null, footIK = null;

  const _f = new THREE.Vector3(), _rt = new THREE.Vector3(), _wish = new THREE.Vector3(), _look = new THREE.Vector3(), _dbg = new THREE.Vector3();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // ── locomotion (camera-relative walk/run/jump, optional fly) ──
  function move(dt, input, w) {
    if (!animator) return;
    // actual horizontal speed (how far he REALLY moved) — tells "stuck pushing a wall"
    // (≈0) apart from "sliding along it" (>0), so the brace pose doesn't slide sideways.
    const actualHSpeed = (move._px != null) ? Math.hypot(entity.position.x - move._px, entity.position.z - move._pz) / dt : 0;
    move._px = entity.position.x; move._pz = entity.position.z;
    const cam = w.camera;
    cam.getWorldDirection(_f); _f.y = 0;
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1);       // camera looking straight down → safe fallback
    _f.normalize();
    _rt.crossVectors(_f, UP);
    const stick = input.stick ? input.stick("left") : { x: 0, y: 0 };
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const running = input.down("ShiftLeft");
    const spd = running ? runSpeed : walkSpeed;
    _wish.copy(_f).multiplyScalar(iz).addScaledVector(_rt, ix);
    if (_wish.lengthSq() > 1) _wish.normalize();

    // PARKOUR: vault a too-tall ledge — needs a cooldown (no re-trigger spam) and either
    // Space or actually MOVING into it at speed (not a creep/graze → no spurious "boom up").
    if (vaultCd > 0) vaultCd -= dt;
    const bodyHSpd = Math.hypot(body.velocity.x, body.velocity.z);
    if (vaultCd <= 0 && (input.pressed("Space") || (_wish.lengthSq() > 0.3 && bodyHSpd > walkSpeed * 0.6)) && checkVault()) { startVault(); return; }

    if (fly && input.pressed("KeyG")) { freeFly = !freeFly; body.velocity.y = 0; }
    if (freeFly) {
      cam.getWorldDirection(_look);
      const rt3 = new THREE.Vector3().crossVectors(_look, UP).normalize();
      const flySpd = running ? 26 : 13;
      const wv = new THREE.Vector3().addScaledVector(_look, iz).addScaledVector(rt3, ix);
      if (input.down("Space")) wv.y += 1;
      if (wv.lengthSq() > 1) wv.normalize();
      body.velocity.set(wv.x * flySpd, wv.y * flySpd, wv.z * flySpd);
    } else {
      // MOMENTUM / WEIGHT: chase the target velocity with a capped rate instead of
      // snapping to it — he spins up and coasts down instead of starting/stopping on a
      // dime. accel while there's input, decel (slower) while coasting.
      const mt = (typeof window !== "undefined" && window.__moveTune) || _moveDEF;
      const tvx = _wish.x * spd, tvz = _wish.z * spd;
      const hasInput = _wish.lengthSq() > 0.01;
      // decel, with a SNAPPY final stop: once he's slow and off the stick, brake harder so
      // he plants and settles quickly instead of coasting forward in the walk pose for a
      // beat. The weighty initial decel (from full speed) is preserved.
      const curHSpd = Math.hypot(body.velocity.x, body.velocity.z);
      const decel = (!hasInput && curHSpd < 2.5) ? mt.decel * 3 : mt.decel;
      const rate = (hasInput ? mt.accel : decel) * dt;
      body.velocity.x += Math.max(-rate, Math.min(rate, tvx - body.velocity.x));
      body.velocity.z += Math.max(-rate, Math.min(rate, tvz - body.velocity.z));
      // vertical: OWN it (ran BEFORE the physics step so the capsule never drives DOWN
      // into the floor). planted → velocity.y = 0; airborne → our gravity; grounded + Space → jump.
      const gY = probeGround(entity.position.x, entity.position.z, entity.position.y);
      const near = gY != null && entity.position.y <= gY + 0.3;   // step band (matches groundClamp)
      if (near && input.pressed("Space")) { body.velocity.y = jumpSpeed; grounded = false; }
      else if (near && body.velocity.y <= 0) { body.velocity.y = 0; grounded = true; }
      else { body.velocity.y -= GRAVITY * dt; grounded = false; }
    }

    // face movement INTENT (not the ramping velocity, which is noisy at low speed)
    const mt2 = (typeof window !== "undefined" && window.__moveTune) || _moveDEF;
    if (_wish.lengthSq() > 0.01) {
      const want = Math.atan2(_wish.x, _wish.z);
      let d = want - entity.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
      entity.rotation.y += d * Math.min(1, mt2.turn * dt);
    }

    // animation state machine — driven by ACTUAL speed (not input) so his legs keep
    // moving as he coasts to a stop (no foot-sliding), and the walk clip scales to speed.
    if (grounded) airT = 0; else airT += dt;
    const gA = probeGround(entity.position.x, entity.position.z, entity.position.y);
    const heightAbove = gA != null ? entity.position.y - gA : 99;
    const airborne = body.velocity.y > 2.0 || (airT > 0.14 && heightAbove > 0.5);
    const inMove = Math.hypot(ix, iz);                                   // input intent (for the wall brace)
    const spd01 = Math.hypot(body.velocity.x, body.velocity.z);          // actual ground speed
    if (airborne) animator.play("jump", { fade: 0.1, once: true });
    else if (wallW > 0.4 && actualHSpeed < 1.2 && inMove > 0.15) animator.play("idle", { fade: 0.2 });   // braced + stuck on a wall
    // SPEED-MATCH clip playback to ground speed so the clip's own feet don't slide
    // (measured: walk clip 1.78 m/s, run clip 3.34 m/s at 1x). He moves much faster than
    // the clips were built for, so play them proportionally faster.
    // playback biased ~12% FASTER than the pure match (÷3.0/1.57 not 3.34/1.78) so the
    // clip cadence slightly leads ground speed — the planted foot lifts BEFORE it can
    // over-reach, so the lock holds the whole stance with no clamp-drag (removes the last
    // bit of foot slide).
    else if (spd01 > 2.6) animator.play("run", { fade: 0.2, speed: Math.max(0.6, Math.min(3.2, spd01 / 3.0)) });
    else if (spd01 > 0.4) animator.play("walk", { fade: 0.2, speed: Math.max(0.6, Math.min(3.2, spd01 / 1.57)) });
    else animator.play("idle", { fade: 0.3 });
  }

  // ── RAYCAST GROUND SUPPORT — our own grounding, not Rapier's. A ray down from
  // the chest finds the real ground; the feet are pinned to it and downward
  // velocity killed, so a standing character never sinks and rides uneven terrain.
  // Runs as a phys _post hook (after the capsule's own move wrote entity.position).
  const _gray = R ? new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }) : null;
  // one downward ray → the real surface Y under (x,z), from `fromY`+up. Hits ANY
  // collider (ground, ramps, steps, obstacles), so it works over arbitrary geometry.
  function probeGround(x, z, fromY, up = 1.2, len = 4.0) {
    if (!_gray || !phys?.world || !body.rb) return null;
    _gray.origin.x = x; _gray.origin.y = fromY + up; _gray.origin.z = z;
    _gray.dir.x = 0; _gray.dir.y = -1; _gray.dir.z = 0;   // DOWN (other callers reuse _gray for forward rays)
    const hit = phys.world.castRay(_gray, len, true, undefined, undefined, undefined, body.rb);
    return hit ? (fromY + up) - (hit.timeOfImpact ?? hit.toi) : null;
  }
  // foot-IK ground sampler (used by FootPlant): surface under a foot, cast from just above it
  function footProbe(x, z, footY) { return probeGround(x, z, footY, 0.6, 1.6); }
  // runs AFTER the capsule's horizontal move: catch any residual sink and keep the
  // render-interpolation Y in sync so the body doesn't visibly jitter up/down.
  function groundClamp(dt = 1 / 60) {
    if (!groundRay || state !== "anim" || freeFly) return;
    const px = entity.position.x, pz = entity.position.z;
    const gY = probeGround(px, pz, entity.position.y);
    if (gY == null) { grounded = false; body.onGround = false; return; }
    grounded = entity.position.y <= gY + 0.3 && body.velocity.y <= 0.02;
    if (grounded) {
      // PHYSICS: snap the capsule exactly onto the surface (no float, no sink).
      entity.position.y = gY;
      body.rb.setTranslation({ x: px, y: gY + height / 2, z: pz }, true);
      body.rb.setNextKinematicTranslation({ x: px, y: gY + height / 2, z: pz });
      body._lastSynced.copy(entity.position);
      if (body.velocity.y < 0) body.velocity.y = 0;
      // VISUAL: ease the rendered body toward the physics height so steps ramp SMOOTHLY
      // — this also absorbs Rapier's autostep, which pops the capsule up a step in ONE
      // frame (that was the "pops going up stairs"). The foot IK plants the feet on the
      // real surface during the lag, so the LEGS bend/extend to do the work.
      if (smoothVisY == null) smoothVisY = gY;
      smoothVisY += (gY - smoothVisY) * (1 - Math.exp(-9 * dt));
      if (Math.abs(gY - smoothVisY) < 0.006) smoothVisY = gY;
      // procedural GAIT BOB — a run/walk oscillates the CoM vertically, but the ground-pin
      // above flattens the clip's bob. Add it back: a stride-synced sinusoid (one cycle per
      // ~1.8m step, dip at footfall), amplitude scaling with speed. Feet stay planted (foot
      // IK) so the legs compress/extend to make the bob = a real gait, not a floating slide.
      const bt = (typeof window !== "undefined" && window.__bobTune) || _bobDEF;
      const hsp = Math.hypot(body.velocity.x, body.velocity.z);
      // AUTO-SYNC the bob to the FEET (read off the posed skeleton): the body is HIGH at
      // mid-stance / flight (a foot swung up) and LOW at footfall (both feet near the
      // ground). Locked to the animation at ANY speed — nothing to tune but taste (amp).
      let lift = 0;
      if (bones && visual) {
        const fl = limbChain(visual, "footL"), fr = limbChain(visual, "footR");
        const yL = fl ? fl.eff.getWorldPosition(_dbg).y - entity.position.y : 0;
        const yR = fr ? fr.eff.getWorldPosition(_dbg).y - entity.position.y : 0;
        lift = Math.max(yL, yR);                                    // the higher (swinging) foot
      }
      const norm = Math.min(1, Math.max(0, (lift - bt.floor) / Math.max(0.02, bt.swing)));  // 0 at footfall → 1 at peak swing
      const move01 = Math.min(1, hsp / (walkSpeed * 0.6));                                   // fade the bob in as he moves
      const bob = -bt.amp * (1 - norm) * move01;                                             // dip when no foot is lifted
      lastBob = bob;
      if (body._ipCurr) { body._ipCurr.y = smoothVisY + bob; if (body._ipPrev) body._ipPrev.y = smoothVisY + bob; }
    } else {
      smoothVisY = entity.position.y;   // airborne (jump/fall): visual tracks physics exactly
    }
    body.onGround = grounded;
  }

  // ── PARKOUR / VAULT — detect an obstacle too tall to step (0.4–1.3m) with a clear top
  // and a lower far side. Returns true (and fills _vTop/_vLand) when vaultable. ──
  const _vTop = new THREE.Vector3(), _vLand = new THREE.Vector3();
  const _vdbg = (typeof window !== "undefined");
  function checkVault() {
    if (!_gray || !phys?.world || !body.rb) return false;
    _wfwd.set(Math.sin(entity.rotation.y), 0, Math.cos(entity.rotation.y));
    _gray.origin.x = entity.position.x; _gray.origin.y = entity.position.y + 0.45; _gray.origin.z = entity.position.z;   // mid-obstacle (not the top edge)
    _gray.dir.x = _wfwd.x; _gray.dir.y = 0; _gray.dir.z = _wfwd.z;
    const fhit = phys.world.castRay(_gray, 1.2, true, undefined, undefined, undefined, body.rb);
    if (!fhit) { if (_vdbg) window.__vaultDbg = "no forward hit"; return false; }
    const d = fhit.timeOfImpact ?? fhit.toi;
    const tx = entity.position.x + _wfwd.x * (d + 0.18), tz = entity.position.z + _wfwd.z * (d + 0.18);
    const topY = probeGround(tx, tz, entity.position.y + 2.2, 0, 3.0);   // top surface just past the edge
    if (topY == null) { if (_vdbg) window.__vaultDbg = "no top d=" + d.toFixed(2); return false; }
    const h = topY - entity.position.y;
    if (h < 0.65 || h > 1.3) { if (_vdbg) window.__vaultDbg = "h out of range " + h.toFixed(2); return false; }  // < 0.65 = step/climb (not vault) so low platforms don't spuriously vault
    const lx = entity.position.x + _wfwd.x * (d + 1.1), lz = entity.position.z + _wfwd.z * (d + 1.1);
    const landY = probeGround(lx, lz, topY + 0.5, 0, 3.5);               // clear far-side landing?
    if (landY == null || landY > topY - 0.1) { if (_vdbg) window.__vaultDbg = "no land landY=" + landY; return false; }
    _vTop.set(tx, topY, tz); _vLand.set(lx, landY, lz);
    if (_vdbg) window.__vaultDbg = "OK h=" + h.toFixed(2);
    return true;
  }
  function startVault() {
    vaultStart.copy(entity.position); vaultTop.copy(_vTop); vaultLand.copy(_vLand);
    state = "vault"; vaultT = 0; body.setEnabled(false);
    animator && animator.play("jump", { fade: 0.1 });
  }

  // ── WALL TOUCH — walking into a wall, bring the hands up onto it instead of pressing
  // face-first. Forward ray from the chest; when close + pushing toward it, IK both hands
  // onto the wall surface, blended in/out by wallW. Runs per render frame (after the anim).
  let wallW = 0;
  // live-tunable wall-brace pose (console: __wallTune.height = 1.4, etc.)
  if (typeof window !== "undefined" && !window.__wallTune)
    window.__wallTune = { reach: 0.8, depth: 0.13, height: 1.25, width: 0.22, speed: 1.0 };
  const _wDEF = { reach: 0.8, depth: 0.13, height: 1.25, width: 0.22, speed: 1.0 };
  const _wray = R ? new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) : null;
  const _wfwd = new THREE.Vector3(), _wlat = new THREE.Vector3(), _wpt = new THREE.Vector3();
  const _wtgt = new THREE.Vector3(), _whand = new THREE.Vector3(), _wpole = new THREE.Vector3(), _wanchor = new THREE.Vector3();
  function updateWallTouch(dt) {
    if (!_wray || !phys?.world || !bones || !body.rb || state !== "anim" || freeFly) { wallW = Math.max(0, wallW - dt * 6); return; }
    const T = (typeof window !== "undefined" && window.__wallTune) || _wDEF;
    _wfwd.set(Math.sin(entity.rotation.y), 0, Math.cos(entity.rotation.y));
    _wray.origin.x = entity.position.x; _wray.origin.y = entity.position.y + 1.3; _wray.origin.z = entity.position.z;
    _wray.dir.x = _wfwd.x; _wray.dir.y = 0; _wray.dir.z = _wfwd.z;
    const reach = T.reach;
    const hit = phys.world.castRay(_wray, reach, true, undefined, undefined, undefined, body.rb);
    const pressing = grounded && Math.hypot(body.velocity.x, body.velocity.z) > 1.0;   // trying to walk forward
    const want = (hit && pressing) ? 1 : 0;
    wallW += (want - wallW) * (1 - Math.exp(-8 * dt));
    if (wallW < 0.02) return;
    const toi = hit ? (hit.timeOfImpact ?? hit.toi) : reach;
    // target the WRIST `depth` short of the wall so the palm/fingers rest ON the surface
    // (targeting the wrist AT the surface pushed the hand mesh through the wall).
    _wpt.copy(_wfwd).multiplyScalar(Math.max(0.05, toi - T.depth)).add(_wray.origin);
    _wlat.set(_wfwd.z, 0, -_wfwd.x);                                                 // LEFT of facing (fwd × up)
    // handL → left, handR → right (was swapped → arms crossed through the wall)
    for (const [limb, side] of [["handL", 1], ["handR", -1]]) {
      const chain = limbChain(visual, limb);
      if (!chain) continue;
      chain.eff.getWorldPosition(_whand);
      _wtgt.copy(_wpt).addScaledVector(_wlat, side * T.width); _wtgt.y = entity.position.y + T.height;  // shoulder-width, chest height
      _wtgt.lerpVectors(_whand, _wtgt, wallW);                                       // blend current hand → wall
      // elbow pole: straight DOWN from the shoulder (+ a touch back). Unambiguous (no
      // left/right term → can't flip/cross), and lets the hand come UP to chest height
      // on the wall (currentBendPole kept the hands hanging low at the waist).
      chain.root.getWorldPosition(_wanchor);
      _wpole.copy(_wanchor).addScaledVector(_wfwd, -0.2); _wpole.y -= 0.7;
      solveTwoBone({ ...chain, target: _wtgt, pole: _wpole, iterations: 3 });
    }
  }

  // ── natural get-up: settle → snap to where he lies → play a get-up clip ──
  function beginGetup() {
    const o = rag.groundOrientation();
    const p = rag.pelvisPos();
    rag.exit();
    entity.position.set(p.x, heightAt(p.x, p.z), p.z);
    entity.rotation.y = o.yaw;
    body.setEnabled(false); body.velocity.set(0, 0, 0); body._lastSynced.copy(entity.position);
    const clip = o.faceUp ? "getupBack" : "getupFront";
    const dur = animator.clips[clip]?.duration ?? 1.8;
    const speed = Math.min(2.4, Math.max(1, dur / 2.0));
    animator.play(clip, { fade: 0.1, once: true, speed });
    getupTimer = (dur / speed) * 0.95;
    state = "getup";
  }

  function goRagdoll(pos) {
    state = "ragdoll";
    body.setEnabled(false);
    if (!rag.active) rag.enter(pos);
  }

  // ── the driver component (runs inside the world's fixed/render loop) ──
  const motor = {
    fixedUpdate(dt, ctx) {
      const input = ctx.input;
      if (state === "vault") {
        vaultT += dt;
        const t = Math.min(1, vaultT / vaultDur);
        const x = vaultStart.x + (vaultLand.x - vaultStart.x) * t;
        const z = vaultStart.z + (vaultLand.z - vaultStart.z) * t;
        const peak = Math.max(vaultTop.y, vaultStart.y, vaultLand.y) + 0.25;   // clear the top
        const y = t < 0.5 ? vaultStart.y + (peak - vaultStart.y) * (t * 2)
                          : peak + (vaultLand.y - peak) * ((t - 0.5) * 2);
        entity.position.set(x, y, z);
        body.rb.setTranslation({ x, y: y + height / 2, z }, true);
        body.rb.setNextKinematicTranslation({ x, y: y + height / 2, z });
        body._lastSynced.copy(entity.position);
        if (t >= 1) { state = "anim"; body.setEnabled(true); body.velocity.set(0, 0, 0); smoothVisY = null; vaultCd = 0.5; }
        return;
      }
      if (state === "getup") {
        body.setEnabled(false);
        getupTimer -= dt;
        if (getupTimer <= 0) { state = "anim"; body.setEnabled(true); body.velocity.set(0, 0, 0); animator && animator.play("idle", { fade: 0.3 }); }
        return;
      }
      if (state === "stagger") {                       // light hit: braced muscle hold — TRIES TO STAY UP
        if (rag) rag.fixedUpdate(dt);
        staggerTimer -= dt;
        if (staggerTimer <= 0) { rag && rag.exitMuscle(); state = "anim"; body.setEnabled(true); body.velocity.set(0, 0, 0); animator && animator.play("idle", { fade: 0.25 }); }
        return;
      }
      if (state === "ragdoll" && rag && rag.active) {
        rag.fixedUpdate(dt);
        body.setEnabled(false);
        if (rag.muscle) return;                        // authoring/muscle mode: no settle/get-up
        const p = rag.pelvisPos();
        entity.position.set(p.x, Math.max(heightAt(p.x, p.z) - 0.2, p.y - 0.9), p.z);
        body._lastSynced.copy(entity.position);        // no teleport-fight on get-up
        if (rag.settled(1.3)) beginGetup();
        return;
      }
      move(dt, input, ctx.world);                      // state === "anim"
    },
    update(dt) {
      if (animator && (state === "anim" || state === "getup" || state === "stagger" || state === "vault")) animator.update(dt);
      if (state === "vault" && bones && visual) {      // plant hands on the ledge as he goes over
        const t = Math.min(1, vaultT / vaultDur);
        if (t > 0.1 && t < 0.75) {
          _wlat.set(_wfwd.z, 0, -_wfwd.x);
          for (const [limb, side] of [["handL", 1], ["handR", -1]]) {
            const chain = limbChain(visual, limb); if (!chain) continue;
            _wtgt.copy(vaultTop).addScaledVector(_wlat, side * 0.2);
            chain.root.getWorldPosition(_wanchor);
            _wpole.copy(_wanchor).addScaledVector(_wlat, side * 0.4); _wpole.y -= 0.4;
            solveTwoBone({ ...chain, target: _wtgt, pole: _wpole, iterations: 2 });
          }
        }
      }
      if (footIK && state === "anim") {                // foot IK on top of the anim pose
        const sp = Math.hypot(body.velocity.x, body.velocity.z);
        footIK.update(body.onGround && sp <= 0.6, body.onGround && sp > 0.6);
      }
      updateWallTouch(dt);                             // hands come up onto a wall he walks into
      // debug (lab only): expose foot heights + the bob value so a graph can show timing
      if (typeof window !== "undefined" && window.__bobDebugOn && visual) {
        const fl = limbChain(visual, "footL"), fr = limbChain(visual, "footR");
        window.__bobDebug = {
          bob: lastBob,
          footL: fl ? fl.eff.getWorldPosition(_dbg).y - entity.position.y : 0,
          footR: fr ? fr.eff.getWorldPosition(_dbg).y - entity.position.y : 0,
          speed: Math.hypot(body.velocity.x, body.velocity.z),
        };
      }
      if (rag && rag.active) rag.update();             // physics bodies → visual bones
    },
  };
  entity.add(motor);

  // our raycast grounding runs after the capsule's move each physics step
  if (groundRay) phys._pre && phys._post ? phys._post.push(groundClamp) : null;

  // ── third-person camera ──
  let rig = null;
  if (camera) {
    rig = new ThirdPersonRig(entity, { distance: 5.5, phys, heightAt, dragOrbit });
    world.spawn("camera").add(rig);
  }

  // ── async: load the model, wire the animator + ragdoll + procedural juice ──
  const ready = loadCharacter(model, { ...characterOpts, animations: anims }).then((ch) => {
    visual = ch.visual; animator = ch.animator; bones = ch.bones;
    entity.mesh(ch.visual);
    animator.play("idle");
    if (lean) entity.add(new TrajectoryLean(bones, () => body));          // lean into turns/accel
    if (footPlant) footIK = new FootPlant({ playerObj: visual, player: entity, heightAt, rayGround: footProbe, footOffset: 0.14 });   // foot IK on the real surface (ankle-above-sole → soles plant)
    rag = new Ragdoll(bones, phys, { tone });
    rag.build();                                        // pre-build capsules (disabled) so a picker can hit them
    handle.rag = rag; handle.animator = animator; handle.bones = bones; handle.visual = visual;
    if (onReady) onReady(handle);
    return handle;
  });

  const chest = () => { const p = rag.segPos ? (rag.segPos("chest") || rag.pelvisPos()) : rag.pelvisPos(); return { x: p.x, y: p.y, z: p.z }; };

  // ── triggers (mirror the ways the ragdoll fires in-game) ──
  const triggers = {
    drop() { if (!rag) return; goRagdoll(V(entity.position.x, 0, entity.position.z)); rag.shove({ x: 0, y: 0.1, z: -1 }, 3, "chest"); },
    punch() { if (!rag) return; if (state !== "ragdoll") goRagdoll(); rag.hit(chest(), V(6, 2, 0).multiplyScalar(60), { maxDeltaV: 14, soften: 0.4 }); },
    launch() { if (!rag) return; goRagdoll(V(entity.position.x, 9, entity.position.z)); rag.shove({ x: 0.3, y: 1, z: 0.2 }, 10, "pelvis"); },
    trip() { if (!rag) return; if (state !== "ragdoll") goRagdoll(); rag.trip({ x: 1, y: 0, z: 0 }, 6, Math.random() < 0.5 ? "L" : "R"); },
    clothesline() { if (!rag) return; if (state !== "ragdoll") goRagdoll(); rag.clothesline({ x: 1, y: 0, z: 0 }, 9); },
    muscle() {
      if (!rag) return;
      if (rag.muscle) { rag.exitMuscle(); state = "anim"; body.setEnabled(true); animator && animator.play("idle", { fade: 0.3 }); }
      else { state = "ragdoll"; body.setEnabled(false); rag.enterMuscle(rag.tone); }
    },
    getup() { if (rag && rag.active && !rag.muscle) beginGetup(); },
    reset() {
      if (!rag) return;
      if (rag.muscle) rag.exitMuscle();
      if (rag.active) rag.exit();
      state = "anim"; getupTimer = 0; staggerTimer = 0;
      entity.position.set(spawn[0], spawn[1], spawn[2]); entity.rotation.set(0, 0, 0);
      body.setEnabled(true); body.velocity.set(0, 0, 0); body._lastSynced.copy(entity.position);
      animator && animator.play("idle", { fade: 0.2 });
    },
  };

  // ── in-game hit: hard → knockdown, light → stagger (braced, stays up) ──
  function hit(point, impulse, power = Infinity) {
    if (!rag) return;
    if (power >= (rag.knockdownImpulse ?? 0)) {          // hard hit → full ragdoll
      if (rag.muscle) rag.exitMuscle();
      if (state !== "ragdoll") goRagdoll();
      staggerTimer = 0;
      rag.hit(point, impulse, { maxDeltaV: 16 });
    } else {                                             // light hit → stagger, tries to stay up
      if (state !== "stagger") {
        if (rag.active && !rag.muscle) rag.exit();
        state = "stagger"; body.setEnabled(false); rag.enterMuscle(rag.tone);
      }
      rag.hit(point, impulse, { maxDeltaV: 12 });
      staggerTimer = 1.0;
    }
  }

  const handle = {
    entity, body, rig, triggers, hit, goRagdoll, ready,
    rag: null, animator: null, bones: null, visual: null,
    get state() { return state; },
    set state(v) { state = v; },
    dispose() {
      if (rag && rag.active) rag.exit();
      if (phys._post) phys._post = phys._post.filter((h) => h !== groundClamp);
      entity && world.destroy && world.destroy(entity);
    },
  };
  return handle;
}

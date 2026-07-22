# Vehicle Physics Rebuild — Build Plan

**Goal:** Wreckfest-level driving + wrecking on **three.js + Rapier**, built correctly from
scratch. "Close to Wreckfest" is the bar, not exact. Non-negotiable: **zero jerk** — no play
session where the car stutters/spazzes.

**Decision (Erik, locked):** Build in a **separate minimal sandbox** ("the Garage"), prove the
physics where it's measurable and can't be masked by game weight, then **merge the proven module
back** into the game.

**Stack:** three.js (render) + Rapier `@dimforge/rapier3d` (physics), Vite, vanilla JS.
**Key architectural call:** *bypass* Rapier's built-in `DynamicRayCastVehicleController` (the twitch
source — suspension solved in WASM, JS tweaks over-correct). Chassis = plain dynamic `RigidBody`;
we run our own suspension/tire/deform logic in a fixed-timestep loop. **No Rapier fork, no WASM
rebuild.**

---

## Cross-cutting rules (apply to every stage)
- **Fixed timestep + render interpolation** from Stage 1 on. This is the *other half* of the jerk
  fix — the old system violated both this and the controller. Accumulator, fixed dt (1/60), lerp
  the visual transform between the last two physics states. Must be jerk-free at 30/60/144 Hz.
- **Zero hot-loop allocation.** Every `THREE.Vector3/Quaternion/Matrix4/Ray` used per-frame is
  hoisted to a module-level scratch var and reused. (The reference snippets Erik gathered all
  allocate in the loop — that reintroduces GC stutter; we don't.)
- **Every constant is HUD-tunable.** Spring/damper/mass/grip/thresholds — all live sliders. We tune
  by *feel*, never by recompile.
- **Each stage has a measurable pass gate.** Measure > eyeball. Frame-time trace proves "no jerk."
- **Feel gates are Erik's hands.** Headless runs at ~1 fps and can't judge handling — Stages 3/4/6
  are gated on Erik driving it.

## Reuse (don't rebuild)
- **Impact detection is already solved.** `phys.js` already reads real Rapier collision events and
  gates severity on **normal closing speed** (distinguishes impacts from scrapes). The deform system
  plugs into *that* existing seam. We do **not** use the hallucinated `contactPairs()/getContactPair()/
  getLocalPointA()/getNormalImpulse()` API from the research — none of those are real Rapier JS methods.
- **Cars are already component-split.** Synty FBX loads with named nodes (Door_FL/FR/BL/BR, Hood,
  Trunk, individual wheels, lightbar) via `loadVehicle`/`classify`. Crumple runs on the body mesh;
  detachment = detach the existing node. No mesh-cutting prep. (FBX→GLB conversion is an optional
  later optimization, not a blocker.)

---

## Stage 0 — The Garage (sandbox scaffold)
Isolated Vite entry `garage/` (index.html + main.js). Imports three + Rapier + the new car module
only — **none of the game**. Flat ground (Rapier fixed cuboid), a few ramps/kerbs, chase cam.
- Live **tuning HUD** (sliders): every physics constant hot-editable.
- Live **readouts**: fps, physics step time, per-wheel compression, speed, slip angle, contact count.
- **Pass:** empty scene locked 60; fixed-step + interpolation confirmed by a flat frame-time trace,
  zero hitches.

## Stage 1 — Deterministic timestep + chassis rigid body (anti-jerk foundation)
Fixed-timestep accumulator + render interpolation. Chassis = plain Rapier dynamic RigidBody, real
mass + inertia, cuboid/convex collider. **No built-in vehicle controller.**
- **Pass:** drop chassis from height → settles with zero jitter; frame-time flat at 30/60/144 Hz.
  This directly kills "every session it jerks."

## Stage 2 — Custom raycast suspension (handling foundation)
4 corner rays (`world.castRay`, exclude own body), Hooke's law spring + damper,
`applyImpulseAtPoint` per fixed step, anti-catapult clamp `max(0,…)`, `velocityAtPoint` damping.
Wheels visually follow compression. All scratch vars hoisted.
- **Pass:** car rests at ride height; absorbs ramps/kerbs without launching or oscillating; stable
  per-wheel compression on the HUD; no jitter landing a jump.

## Stage 3 — Drive + steer (longitudinal)  ← Erik feel-gate
Throttle/brake as force along tire-forward vector; steering rotates front-wheel forward vectors;
wheel roll; reverse; handbrake.
- **Pass:** Erik drives — accelerates/brakes/turns, feels planted, still zero jerk.

## Stage 4 — Tire slip / drift (lateral — the Wreckfest feel)  ← Erik feel-gate
Manual lateral friction: sideways velocity per tire → counter-impulse below slip threshold, cap at
threshold via handling curve → controllable slide. Rear-grip multiplier knob. Slip smoothed over a
few frames (lerp) to kill chatter. Weight transfer comes free from the suspension.
- **Pass:** Erik holds a sustained, controllable drift; rear breaks loose predictably; no snap-flip.

## Stage 5 — Impact deform (crumple)
Deform handler fed by the **existing phys.js impact seam** (normal-closing-speed severity). Transform
world contact point → car-local, radius scan with falloff, push vertices **along the contact normal**
(not toward mesh center — that pinches), event-gated `needsUpdate` + `computeVertexNormals`. Magic
constants are placeholders → one tuning pass vs real impulse units.
- **Pass:** ram a wall → body panel caves where hit, scaled by speed; no perf hitch.

## Stage 6 — Detach + debris + mechanical consequence (Wreckfest parts)  ← Erik feel-gate
Cache each named node's local bbox center at **load** (dynamic, not hardcoded coords). On hard
localized impact: detach node → **JS-animated debris** (car velocity + outward pop + gravity +
lifetime fade; no per-door Rapier body). Mechanical consequence: wheel off → kill that corner's
grip/suspension; bumper off → strip mass.
- **Pass:** hard hit tears a door/bumper off (tumbles + fades); knocking a wheel off visibly changes
  handling.

## Stage 7 — Scale to 20 + LOD, then merge
20 cars; physics LOD (full deform <50 m, math-only health flags beyond); confirm frame budget
< 16.6 ms on the readout. Then **merge** the self-contained module into the game (replace
`RapierVehicle`), behind an A/B flag.
- **Pass:** 20 cars within frame budget; Erik drives the merged game version with zero jerk.

---

## Deliverables
- `garage/` — sandbox entry (own Vite build, throwaway-safe).
- `src/carphysics.js` — new self-contained module (chassis + suspension + tires). Touches nothing in
  the existing `vehicle.js`/`phys.js`, so merge is additive.
- Deform/detach handler consuming the existing phys.js impact seam.

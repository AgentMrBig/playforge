# PlayForge — Character Animation Studio: System Plan

*Owner: General (character lane). Written 2026-07-20 in response to Erik's "what's your system plan?"*

## The one-line identity

**A Mixamo you OWN, welded to the game.**

Mixamo hands you a generic mocap clip — a quick, dirty dump, no tuning. Its value ends
at "download." Our system's value *starts* there: take any base clip and **reshape it to
fit the exact scenario** — re-pose, retime, layer, plant, weld, blend — then play it **live
in the actual game**, not in a preview window. The reshape control + the live runtime are
the entire moat. Everything else serves those two.

## Why ours beats Mixamo (the differentiators)

1. **Reshape, don't just grab** — full rig control (IK/FK, control rig, keyframes, tweak
   layer) on top of the clip, so one Mixamo "rifle idle" becomes ten scenario-perfect idles.
2. **Live, not a roundtrip** — author and *see it in the running game* immediately; bind to
   a key/event and it's part of the character now. No export→import loop.
3. **Event-driven runtime** — behaviors fire off gameplay (shoot, hit, vault, enter cover),
   so the character is *reactive*, not playing canned loops.
4. **Owned end-to-end** — no third-party dependency at runtime; the moveset is ours.
5. **Browser-speed iteration** — the reason we can out-iterate anyone.

## What the system PRODUCES (the outputs)

The system is an authoring tool; these are the assets it emits and the game consumes:

- **Pose** — a static full-skeleton snapshot. *(built: saved-poses panel)*
- **Behavior** — the atom. `base clip + pose keyframes + layers (weld/aim/foot-plant) +
  blend & trigger rules`. Named, saved, versioned, plays in-game. *(built: timeline + save/
  load + key triggers; grows in phases 3–5)*
- **Moveset** — the full set of behaviors/blends bound to the character's gameplay states
  and events. This is the real deliverable: **the character's animation "brain."**

## Layout — Mixamo grammar, 4 docks

Mixamo's UX is worth stealing: a **library on the left**, a **live preview in the center**,
and **a few high-leverage parameters on the right**. We generalize it to a 4-dock studio:

- **LEFT = Library / asset browser.** Tabs: *Animations* (base clips), *Poses*, *Behaviors*.
  Click to load-and-preview on the character. (Today's saved-poses panel is the seed of this.)
- **RIGHT = Inspector.** Context-sensitive properties:
  - a control/limb selected → transform, IK/FK, lock, sticky, weld
  - a *clip* selected → **Mixamo-style modifiers** (speed, mirror, trim, in-place, additive…)
- **BOTTOM = Trax / timeline.** NLA editor: base-clip track + layer tracks + keyframes +
  markers + scrub/play. (Partially built — the behavior timeline.)
- **CENTER = viewport.** Character, free camera, control rig + gizmo, playback bar.

Today everything is crammed into one right-hand panel + a bottom timeline bar. Phase 2 is
re-homing those into this grammar so the tool reads as a studio, not a wall of buttons.

## Roadmap

**Phase 1 — Foundation (DONE).** Test mode + free cam; state menu; IK pose editor; FK/IK +
limb locks + **sticky feet/hands**; **control rig** (Maya curves) + **gizmo** (move/rotate/
scale, W/E/R, local-space rotate) + **knee/elbow aims**; **tweak layer** (edits ride a
playing clip); **behavior timeline** (base + pose keyframes + blend windows); **weld**
(hand→weapon, pos+orientation); **foot planting** + ground/vehicle collision; **behaviors**
save/load + **key triggers** (play in-game); **saved-poses panel**; **undo/redo**;
upper/lower **blend** (run-and-gun).

**Phase 2 — Studio UI reorg.** Consolidate into the 4-dock layout above. Left library
(Animations/Poses/Behaviors), right context inspector, bottom trax, clean viewport. This is
what Erik's "think about the layout" points at. *Highest-value next step.*

**Phase 3 — Clip modifiers (the "far more control than Mixamo" core).** Per-clip, non-
destructive: **speed/retime · mirror · trim in/out · in-place ↔ root-motion · additive-over-
locomotion · loop-blend/smoothing · arm/leg space.** This is literally "modify the animation
to perfectly fit any scenario."

**Phase 4 — Timeline authoring.** Keyframe over *time*, not just single poses at markers:
multiple keys per track, interpolation/curve control, so you can author *original* motion,
not only edit existing clips. (Maya-Trax → full mini-DCC.)

**Phase 5 — Runtime moveset.** Behavior state-machine + event bus: movement, combat,
environment, and NPC events select/blend behaviors. Behaviors compose into a living
character in-game. This is where the authoring tool pays off as *gameplay*.

**Phase 6 — "Our Euphoria" (procedural + physics layer).** Muscle layer (animation→physics
via per-joint stiffness) then behavior controllers (balance/step, brace, protect, reach,
grab, get-up) blended by context. See "Layer 3" above. The muscle layer can start early — it
runs on our existing Rapier active ragdoll and needs no UI.

## Layer 3 — "Our Euphoria": procedural + physics-driven behavior (the capstone)

*Erik, 2026-07-20: "what makes it a behavior is the composite of the behavior animation WITH
procedural animation + physics-driven active ragdoll. We need to be our own Euphoria."*

### What Euphoria was (research)

**NaturalMotion's Euphoria** (Oxford; founder Torsten Reil) is the physics-driven character
tech behind **GTA IV, Red Dead Redemption, Max Payne 3, Star Wars: The Force Unleashed,
Backbreaker, LA Noire**. Three tools: **endorphin** (offline authoring, ~2005), **euphoria**
(the real-time runtime, ~2008), **morpheme** (animation blend-graph runtime). The core is
**DMS — Dynamic Motion Synthesis**: the character body is *simulated* (forward-dynamics
physics) and driven by **biomechanical behavior controllers** + a simple "nervous system,"
so every reaction is *synthesized live and context-aware* — the way you fall depends on where
you were shot, what's around you, and momentum. Never a canned clip; never the same twice.

It "fell off" because it was punishing to author/tune and NaturalMotion pivoted to mobile
(CSR Racing, Clumsy Ninja) before Zynga acquired them (2014). So that fidelity is genuinely
semi-lost tech — which is exactly why owning our own version is a moat.

### The composite IS the behavior

A Behavior is a **stack of three layers**, blended per-joint:

1. **Base clip** — raw mocap (Mixamo). *(have)*
2. **Authored edits** — our pose keyframes, tweak layer, welds, planting. *(have)*
3. **★ Procedural / physics layer (our Euphoria)** — active ragdoll + muscle motors +
   behavior controllers that react to forces and surroundings. *(this section)*

Layer 3 is what makes it *behave* instead of *play back*.

### Mechanism (buildable on our existing Rapier active ragdoll — `window.__rag`)

- **Muscle layer (the keystone, buildable first).** PD motors at each joint drive the
  *physics* body toward the authored pose: `torque = stiffness·(targetAngle − angle) −
  damping·angularVel`. **Stiffness = muscle tension.** High → the body tracks the animation
  but *physically* (a shove perturbs it, then it recovers); low → it goes limp (ragdoll). The
  entire "animated ↔ ragdoll" spectrum is just a stiffness ramp — per-joint, so you can go
  limp in the legs while the arms still brace.
- **Behavior controllers (procedural, prioritized, blended).** Modules that adjust joint
  targets + stiffness from **context**: `balance + protective step` (keep COM over the
  support polygon; step to catch), `brace for impact`, `protect head`, `reach to wound /
  support`, `grab ledge/object` (IK + attach), `stagger`, `get up`. Each emits a weighted
  pose-delta + stiffness change.
- **Arbitration.** Controllers blend by priority into the muscle layer → physics. Context
  inputs: impact force + location, balance state, wall/ground proximity, health, velocity.

Example: the "rifle idle" behavior plays our tweaked idle — but shove the character and he
staggers, steps to catch balance, braces if he hits a wall, and recovers to the idle. Shoot
him and the hit twists the torso realistically and a hand reaches toward the wound. All
emergent from physics + controllers, never the same twice. **That's the Euphoria feel.**

### Sequencing

The **muscle / pose-matching layer** is the tractable first slice and high-value on its own
(physically-reactive animation with a stiffness dial), and we already have the substrate
(Rapier active ragdoll + the `__rag.tone` de-floppiness dial). Behavior controllers layer on
after. This becomes **Phase 6** — but the muscle layer can be prototyped early, in parallel
with the UI work, because it's runtime, not UI.

## Keys, root motion, capture (design decisions, 2026-07-20)

**Markers vs keys.** Our *markers* are overlay tweaks — at a marker time we blend a base clip
toward an authored pose over a window (great for reshaping a Mixamo clip). A *key* is the
atom of animation: a pose (or per-bone value) pinned at a time, with the motion being the
interpolation between keys — no base clip required. Markers stay for clip-tweaking; we ADD
**keys** as the authoring primitive (Phase 4), so you can build original motion (a spin kick)
from scratch or from a captured moment. A marker is just a key with a blend-window over a clip.

**Root motion.** Is travel baked into the clip or added by code? *In-place*: clip cycles the
legs, code moves the capsule by velocity (risks foot-slide). *Root motion*: the clip's root
bone carries the displacement; the game reads that delta and moves the body by it — so
lunges/dodges/travelling kicks move exactly as animated. Per-behavior toggle (in-place↔root).
The motion recorder keeps the root world path, so captured moments preserve real travel.

**Capture-moment (SHIPPED, MotionRecorder).** A rolling buffer always holds the last ~15s
(all bone rotations + root pos). `captureLast()` freezes it into a scrubbable moment; start/
stop for deliberate takes. Anima scrubs / slow-mos / frame-steps it and slerps the pose; you
pose-edit any frame into a behavior. Root path retained.

**Animation-driven locomotion (Erik's direction, 2026-07-20 — PENDING his go).** Erik wants
the GTA4 feel: the character actually walks/runs, not a capsule sliding at a foot-matched
speed. Two routes: (a) **root-motion clips** — re-grab walk/run from Mixamo with "in place"
UNCHECKED; read the root delta each frame → move the capsule exactly as animated (clean baked
travel, zero slide); (b) **procedural foot-driven root motion** — keep the stance foot planted
in world space; the body's travel emerges from the planted foot moving back through the in-
place clip (no new assets, inherently slide-free). Recommendation: prototype (b) on our
existing FootPlant for an immediate win, and bring in (a)'s root-motion clips for the cleanest
result. ★ Core-movement change — overlaps Ninja's engine/character lane; coordinate + Erik's
eyes tune the feel.

## End state

Every animation the character plays is a base clip **reshaped, layered, and event-driven** —
bespoke and alive (GTA / Schedule 1 target), authored in minutes in the browser, owned
end-to-end. The Mixamo dump is just the raw stock; the Studio is the machine shop.

## Open decision for Erik

Recommended order: **Phase 2 (UI reorg)** first — you flagged layout, and a coherent studio
makes every later feature easier to place — then **Phase 3 (clip modifiers)** for the control
payoff. Alternative: jump straight to Phase 3 if you want the "reshape any clip" power before
the reorg. Your call on priority.

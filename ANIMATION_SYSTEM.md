# PlayForge — Locomotion, Behavior & Animation System

**Internal reference (us, not users).** How the character animation stack fits together, and — the part you asked for — an **itemized checklist of every animation the full system wants**, marked HAVE ✅ / NEED ⬜, so you have a clean Mixamo shopping list.

Owner: General (character/animation/combat lane).

---

## 1. The layer stack (how one frame is built)

The character is drawn by stacking layers, each running **on top of** the one below. A frame flows top-to-bottom:

```
INPUT (WASD / stick, camera-relative)
   │
1. LOCOMOTION INTENT  → wish-direction, speed, facing (PlayerMove)
   │
2. CLIP PLAYBACK      → Animator plays idle/walk/run, crossfades (animation.js)
   │
3. UPPER/LOWER SPLIT  → BlendController: legs run while arms aim/fire (animblend.js)
   │
4. PROCEDURAL POSE    → added on top of the clip, never blocked by it:
      • CharacterAim   — aim pitch, weapon hold (charanim.js)
      • TrajectoryLean — lean into acceleration/turns (charlean.js)   ← RDR2 weight
      • FootPlant      — lock feet to ground, conform to slopes (footplant.js)
   │
5. PHYSICS TAKEOVER (on knockdown/death) — the skeleton becomes a jointed
   ragdoll; muscles PD-track whatever the Animator is still playing:
      • 3-tier muscle stack (base ⊗ procedural ⊗ reflex) (ragdoll.js)
      • Reflexes — fall-brace now; stumble-catch next (ragdoll.js)
   │
6. AUTHORING (offline) — Anima studio records/edits/keys behaviors (testmode.js,
   animtimeline.js); saved behaviors fire in-game via triggers.
```

**Key principle (Erik's):** procedural layers are *additive over the clips* and never blocked on mocap. A missing animation degrades gracefully (we fall back to the nearest clip), it never breaks the game — so we can ship the systems now and drop better clips in as they arrive.

---

## 2. Locomotion model

- **Camera-relative**: WASD maps to camera forward/right; the character turns to face its movement direction and moves (RDR2/GTA style).
- **Facing**: eases toward the travel direction (armed = faces the camera aim instead).
- **Camera**: trails behind only when running *away* (forward-gated, so strafing doesn't spiral — the D-orbit fix).
- **Weight**: TrajectoryLean tips the spine into acceleration (run-in), pitches back on hard stops, banks into turns.
- **Speed tiers today**: walk (5.0) / run (9.3 on Shift). Motion-matching (future) will want start/stop/turn clips to interpolate between these.

---

## 3. What each system consumes (so you know why a clip matters)

| System | Needs | Today |
|---|---|---|
| Animator | named clips: `idle/walk/run/jump` | ✅ have |
| BlendController | a **lower** clip (run) + an **upper** clip (aim/fire) to blend | partial |
| CharacterAim | none (procedural) — but reads better over an *aim* base clip | ✅ |
| TrajectoryLean | none (procedural) | ✅ live |
| FootPlant | none (procedural) | ✅ |
| Muscle stack / Reflexes | the clip pose as the PD target; get-up clip for recovery | ⬜ get-up |
| Combat | per-weapon hold / aim / fire / reload | mostly ⬜ |

---

## 4. ★ ANIMATIONS NEEDED — the checklist

Legend: ✅ have · ⬜ need · 🔸 have-but-weak (placeholder / would upgrade).
Mixamo search terms in *italics*. All clips: humanoid, **in-place** (we drive locomotion; strip root motion — the loader already deletes `.position` tracks).

### A. Core locomotion
- ✅ Idle — *idle*
- ✅ Walk (fwd) — *walking*
- ✅ Run (fwd) — *running*
- ⬜ **Sprint** (faster, lower stance) — *sprint / fast run*
- ⬜ **Walk back / Run back** (backpedal) — *walking backward*
- ⬜ **Strafe L / R** (walk + run) — *strafe left/right* — needed for armed movement
- ⬜ **Turn in place L / R** (90° + 180°) — *turn left 90 / turn right*
- ⬜ **Start / Stop** (accel from idle, decel to idle, plant-and-stop) — *stop, jog to stop* — motion-matching fuel + the "digs heels in" RDR2 stop
- 🔸 Crouch idle / crouch walk — *crouch idle / crouch walk* (crouch is stubbed, no clip)

### B. Jump / fall / land
- ✅ Jump (up) — *jump*
- ✅ Falling (airborne loop) — *falling idle*
- ✅ Hard landing — *hard landing*
- ⬜ **Soft landing** (small drop, keep moving) — *soft landing / landing*
- ⬜ **Run-jump** (leap while running) — *running jump*
- ⬜ **Land-to-roll** (big fall recovery) — *falling to roll*

### C. Get-up from ragdoll ← **you're sourcing these now**
- ⬜ **Get up — face DOWN (prone)** — *stand up / getting up* (front)
- ⬜ **Get up — face UP (supine)** — *stand up from back / get up back*
- ⬜ (nice-to-have) **Get up — quick / to-run** — *stand up to run*
> The system will pick face-up vs face-down from the ragdoll's final chest orientation, blend out of the settled pose into the clip, then hand back to idle/locomotion. **This is the one hard blocker for natural get-up.**

### D. Combat — ranged (5 weapons: pistol, shotgun, smg, rifle, machinegun)
- ✅ Rifle idle (aim) — *rifle idle*
- ✅ Pistol idle (aim) — *pistol idle*
- ✅ Firing rifle — *firing rifle*
- ⬜ **Fire** — pistol / shotgun / smg / machinegun — *pistol fire / shotgun fire / …*
- ⬜ **Reload** — pistol / rifle / shotgun / smg — *reload*
- ⬜ **Aim walk / aim run / aim strafe** (upper-body layer while moving) — *rifle walk / strafe*
- ⬜ **Draw / Holster** — *draw gun / holster*
> BlendController already supports upper/lower split, so aim-move = lower(run) + upper(aim). Feeding it real aim-walk/strafe clips is the win.

### E. Combat — melee (3: bat, katana, chainsaw)
- ⬜ **Melee idle** — *bat idle / sword idle*
- ⬜ **Swing** light + heavy — *baseball swing / sword slash / melee attack*
- ⬜ **Chainsaw hold / attack loop** — *chainsaw*
- ⬜ (nice) **Block / parry** — *blocking*

### F. Hit reactions & staggers (RDR2 micro-interactivity)
- ⬜ **Flinch** front / back / L / R (light hit) — *hit reaction*
- ⬜ **Stagger** (heavy hit, stumble back) — *stagger / stumble backward*
- ⬜ **Stumble-catch** (trip recovery — feeds the next reflex) — *stumble / trip*
- ⬜ **Knockback** (big hit before ragdoll) — *knocked back*

### G. Interactions
- ⬜ **Enter car / Exit car** (currently a teleport) — *sitting / stand to sit*
- ⬜ **Pickup** (bend + grab — for Ember's pickup system) — *picking up object*
- ⬜ (nice) **Open door, vault, climb** — *opening door / vault*

---

## 5. How to add a clip (once you've got the FBX)

1. Export from Mixamo: **FBX, no skin needed** (we retarget by bone name), in-place (uncheck "in place" is fine — the loader strips root-motion `.position` tracks anyway).
2. Drop it in `public/models/character/anims/<name>.fbx`.
3. Register it in `demo/bigisland.js` where the player calls `loadCharacter(... animations: [ { name, url } ])`. NPCs share the same list.
4. Play it by name via the Animator / BlendController; I wire the state logic (when it plays).
> Bone naming: Mixamo `mixamorig:` prefix is auto-stripped → plain `Hips/Spine/LeftArm/…`, which every system speaks.

---

## 6. Priority order (biggest gameplay wins first)

1. **Get-up (C)** — unblocks natural recovery; you're already on it. 🔥
2. **Start/Stop + Turn-in-place (A)** — the RDR2 "weight" you feel most, and motion-matching fuel.
3. **Strafe + Aim-move (A/D)** — makes gunplay feel real (run-and-gun).
4. **Hit reactions / stagger (F)** — combat feedback + feeds the reflex layer.
5. **Fire/Reload per weapon (D)** — polish once the above land.
6. Melee (E), Interactions (G) — as those systems come online.

---

*Living doc — I'll keep the HAVE/NEED marks current as clips land and systems grow. Ping me to add a category.* — General

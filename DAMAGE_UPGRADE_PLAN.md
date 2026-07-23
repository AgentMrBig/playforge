# Damage Upgrade — Curated Plan (from external review, vetted 2026-07-22)

## Curation verdict on the research
- **§1 Compound box colliders — ADOPT, fix the API.** Concept is right (3–5 cuboid sub-colliders on the one body; shift them inward on damage; never rebuild hulls). But `collider.setShape()` is the wrong call for moving a sub-box — Rapier's real API is **multiple colliders attached to one rigid body**, repositioned with `collider.setTranslationWrtParent()`. Sub-boxes get **density 0** (our explicit mass properties stay authoritative).
- **§2 Vertex-color zone IDs — ADOPT the architecture, SWAP the tagging source.** Our Synty meshes already **use vertex colors for paint** (Assetsville), so we can't repurpose them without offline re-authoring every car. Same runtime structure (per-zone vertex index arrays + `zoneHealth[]`), but built by a **one-time load-time spatial partition in canonical body space** (front/hood/left/right/rear/roof from the normalized bbox). Their "spatial bleeds" objection applies to per-impact radius checks, not to load-time tagging. If Erik later paints IDs in Blender, drop-in swap.
- **§3 Suspension offsets for frame bend — ADOPT AS-IS.** We own the whole raycast suspension, so per-corner ray-direction tilt, rest-length reduction (sag), and steering-baseline offset are trivial and free. This is the highest feel-per-cost item.
- **§4 Crush via same-step opposing events — ADOPT.** We already drain contact-force events per fixed step; buffer them per step, and `dot(dir₁, dir₂) < −0.8` on the same car ⇒ crush event (flat severe deform both sides, bypass thresholds).
- **§5 Mechanical states — ADOPT, adapt transmission.** Engine/radiator overheat (front zone < 40% → torque decays ~1.5%/s + hood smoke via our particle engine) and steering offset (front corner zone < 50% → ±2–5° baseline) map directly. "Shift latency" doesn't exist in our drivetrain — adapt to **random brief torque dropouts + backfire pop** above 4M accumulated force.
- **§6 Priority order — AGREED**: zones → frame bend → mechanical states → compound colliders → crush.

## Staged build (each stage shippable + verifiable)
1. **D1 — Damage zones**: load-time spatial partition → per-zone vertex lists + `zoneHealth[]`; deform() constrained to the hit zone; HUD debug readout of zone healths.
2. **D2 — Frame bend**: per-wheel damage offsets (ray tilt, rest-length mul, steering baseline) driven by corner-zone health; car sags + pulls after hard corner hits.
3. **D3 — Mechanical states**: overheat torque decay + hood smoke; steering misalignment; transmission dropouts + pops. All off `zoneHealth` + accumulated severity.
4. **D4 — Compound collider feedback**: replace the single cuboid with 4–5 density-0 sub-boxes (nose/tail/left/right/cabin); on heavy zone damage, `setTranslationWrtParent` shifts that face inward (caved nose collides caved).
5. **D5 — Crush detection**: per-step event pairing, opposing-dir dot test, severe dual-side deform + max camera shake/audio.

Ref: full current-system spec in DAMAGE_SYSTEM_SPEC.md / .pdf.

# PlayForge — Impact Sound List (for Suno)

Shopping list for Erik's Suno session. Goal: a bank of short one-shots the physics
layer triggers by contact force (Ninja's crash-sound system already fires on real
impacts — this fills it with good material). Layering combos at the bottom, per Erik's
idea.

**Global recording notes for every prompt:** `sound effect, <description>, dry, close-mic,
mono, one-shot, no music, no reverb` — the game adds 3D spatialization + falloff itself.
Keep them ~0.2–1.5 s. Generate **3–4 variations of each** so repeats don't sound canned;
the engine can pick at random.

---

## A · METAL / CAR CRASH — hard hits (impact force HIGH)
1. **T-bone smash** — deep metallic crunch, sheet-metal buckle, short glass-tinkle tail
2. **Head-on high-speed** — big low boom + crumple + scatter, the "you totaled it" hit
3. **Side-swipe scrape** — sustained metal-on-metal grind/screech, ~0.6 s, no boom
4. **Fender/panel crumple** — mid crunch, dull, no glass
5. **Bumper tap** — light metallic clank/knock (low-speed nudge)
6. **Rollover slam** — car body flat onto tarmac, hollow metallic WHUMP + creak (for tumbles)

## B · GLASS
7. **Windshield shatter** — bright glass burst + falling-shard rain
8. **Headlight/small glass pop** — short crisp tick + tiny shards

## C · SOFT / NOT-SO-CRASHY (Erik: "some not so crashy")
9. **Body onto hood** — dull soft thud, cloth-on-metal, low & fleshy (the hood-standing case)
10. **Landing on roof from a jump** — muffled metallic whump + suspension creak
11. **Curb / pothole bump** — single suspension thunk, rubbery
12. **Car onto grass/dirt** — soft crunchy thud, earthy
13. **Light prop knock** — cone/barrel/fence tap, plastic-hollow

## D · TIRE / GROUND (drift + takeoff)
14. **Tire screech / burnout** — sustained rubber squeal (for the drift direction)
15. **Chirp** — short tire bark on a hard launch or gear catch
16. **Gravel scatter** — loose stones spraying under tires
17. **Skid-to-stop** — screech resolving to a stop

## E · DEBRIS TAILS (for layering under A/B)
18. **Metal debris scatter** — bolts/panel bits bouncing on tarmac
19. **Hubcap roll** — single metal disc wobbling to rest
20. **Glass-shard rain** — fine tinkling settle, ~1 s

---

## Layering combos (Erik's "layer them" idea)
- **Big crash** = A2 (boom) + B7 (glass) + E18 (debris), each offset ~40–80 ms
- **Rollover** = A6 (slam) + D14 short (scrape) + E20 (glass rain) on the second bounce
- **Soft body hit** = C9 (thud) + a faint cloth rustle — keep it low, no metal
- **Nudge** = A5 (bumper tap) alone, quiet

## Coverage tiers the engine wants
- 3 severity buckets — **light / medium / heavy** — so force can pick the right one.
  Easiest: tag each file `_light` / `_med` / `_heavy` and we map contact force → bucket.

*Owner: General. Ping me to add/trim categories or wire the buckets once the files land.*

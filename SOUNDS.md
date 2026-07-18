# PlayForge — Impact Sound List + Suno Prompts

Shopping list for Erik's Suno session. Filenames match Ninja's engine loader
(`public/sfx/…`), so what you generate drops straight in. Ninja layers + pitch-varies
by impact force, so **generate 3–4 variations of each** and keep them dry.

**Suno how-to:** paste the prompt, set it INSTRUMENTAL, keep clips short, and grab the
cleanest ~1–2s hit. Every prompt already asks for `dry, one-shot, no music, no reverb tail`
— the game adds 3D space + falloff itself. Trim silence at the head so the transient is
at t=0.

---

## A · HARD METAL CRASH  → `crash_metal_big_1/2/3.wav` (full wreck)
> **Suno:** `heavy car crash impact, two vehicles colliding at high speed, deep metallic crunch and sheet-metal buckle, shattering glass, scattering debris, huge punchy transient, dry, one-shot, no music, no reverb`

## B · MEDIUM METAL HIT  → `crash_metal_med_1/2.wav` (solid hit, no total)
> **Suno:** `car fender crumple impact, single solid metallic crunch, dull mid punch, small debris, no glass, dry close-mic one-shot, no music, no reverb`

## C · BODY vs CAR (soft, not crashy)  → `thud_body_1/2.wav`
> **Suno:** `body slamming onto a car hood, dull soft thud, muffled flesh-and-cloth on metal, low weight, short, no metal ring, dry one-shot, no music`

## D · SUSPENSION LANDING  → `thump_landing_1/2.wav` (jump / roof slam)
> **Suno:** `car landing hard after a jump, heavy suspension thump, muffled metallic whump with a spring creak, low-end weight, short, dry one-shot, no music, no reverb`

## E · WALL SCRAPE (loopable)  → `scrape_metal_loop.wav`
> **Suno:** `car scraping along a concrete wall, continuous metal-on-stone grinding screech with sparks, steady seamless loop, no impact spike, dry, no music, no reverb`

## F · GLASS  → `glass_pop_1/2.wav`
> **Suno:** `car window shattering, bright glass burst and falling shards tinkling, short and crisp, dry one-shot, no music, no reverb`

## G · PLASTIC / PROP  → `crunch_plastic_1/2.wav` (cones, bumpers, barrels)
> **Suno:** `hitting a plastic traffic cone, hollow plastic crunch and clatter, light, short, dry one-shot, no music, no reverb`

## H · NEAR-MISS  → `whoosh_nearmiss.wav`
> **Suno:** `fast car passing very close, sharp doppler whoosh of air and tire noise, quick, dry one-shot, no music, no reverb`

---

## Optional extras (nice-to-have, for later)
- **Tire burnout / drift** → `tire_screech_loop.wav` — `Suno: sustained tire screech, rubber squealing on asphalt during a drift, steady seamless loop, dry, no music`
- **Launch chirp** → `tire_chirp_1/2.wav` — `Suno: short tire chirp bark on a hard launch, quick rubber squeak, dry one-shot, no music`
- **Gravel** → `gravel_scatter_1.wav` — `Suno: loose gravel and small stones spraying under car tires, gritty scatter, dry one-shot, no music`
- **Debris tail** → `debris_metal_1.wav` — `Suno: metal debris and bolts bouncing and settling on tarmac, tinkling scatter, about one second, dry, no music`

## Severity → the engine buckets by contact force
`big` = heavy wrecks · `med` = solid hits · the soft ones (thud/thump/plastic) for
low-force + character contacts. Ninja maps force → bucket; more variations = less repetition.

*Owner: General — ping me to add/trim or to help wire the loader buckets once files land.*

// PlayForge start + loading screen — Ember's UI lane (Erik 2026-07-20: "a start
// screen" + "a loading screen so people can't see assets popping into existence").
// One polished intro that does both: the overlay (markup in index.html) paints
// INSTANTLY, shows the title + a loading bar while the world builds in the
// background, then — once physics + the initial tiles/decorations are in
// (window.__pfReady) — swaps the bar for a PLAY button. Clicking Play fades to a
// fully-built island, so nothing pops in front of the player.
//
// A hard maxMs ceiling reveals the Play button even if a readiness signal never
// fires, so the player can never be trapped behind the overlay.
export function initLoadingScreen({ minMs = 1200, maxMs = 12000, framesReady = 6, messages } = {}) {
  const el = typeof document !== "undefined" && document.getElementById("pf-loading");
  if (!el) return { reveal() {}, message() {}, ready() {} };
  const msgEl = document.getElementById("pf-loading-msg");
  const barEl = document.getElementById("pf-loading-bar");
  const playBtn = document.getElementById("pf-play");
  const t0 = performance.now();
  let frames = 0, forced = false, armed = false, done = false;

  const msgs = messages ?? ["Building the island…", "Streaming the terrain…", "Waking the town…", "Warming up the cars…"];
  let mi = 0;
  const msgTimer = setInterval(() => {
    if (armed || done || !msgEl) return;
    mi = (mi + 1) % msgs.length; msgEl.textContent = msgs[mi];
  }, 1500);

  const worldReady = () => forced || (typeof window !== "undefined" && window.__pf && window.__pfReady === true);

  // world is built → swap the loading bar for the PLAY button
  const arm = () => {
    if (armed) return; armed = true;
    clearInterval(msgTimer);
    if (barEl) barEl.style.display = "none";
    if (msgEl) msgEl.textContent = "Ready";
    if (playBtn) { playBtn.classList.add("pf-show"); playBtn.focus?.(); }
  };
  // Play clicked (or forced) → fade to the game
  const start = () => {
    if (done) return; done = true;
    el.classList.add("pf-hide");
    setTimeout(() => el.remove(), 700);
  };

  if (playBtn) playBtn.addEventListener("click", start, { once: true });

  const tick = () => {
    if (done) return;
    frames++;
    const elapsed = performance.now() - t0;
    if (!armed && ((elapsed >= minMs && frames >= framesReady && worldReady()) || elapsed >= maxMs)) arm();
    if (!done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    ready() { arm(); },                                   // force the Play button now
    reveal() { forced = true; arm(); start(); },          // skip straight into the game
    message(text) { if (msgEl && !armed) msgEl.textContent = text; },
  };
}

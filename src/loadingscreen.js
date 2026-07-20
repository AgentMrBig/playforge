// PlayForge loading screen — Ember's UI lane (Erik 2026-07-20: "a loading screen
// so people can't see assets popping into existence"). The overlay markup lives
// in index.html so it paints INSTANTLY on page load; this module holds it up
// until the world is actually built, then fades it out — the player drops into a
// finished island instead of watching tiles + buildings pop in.
//
// "Ready" = the game booted (window.__pf) AND the boot signalled window.__pfReady
// (set after physics + the initial tiles/vehicles settle) AND a few frames have
// rendered AND a minimum time has passed (so a too-fast local load still reads as
// intentional). A hard maxMs ceiling guarantees it never traps the player behind
// the overlay if a signal never fires.
export function initLoadingScreen({ minMs = 1400, maxMs = 12000, framesReady = 6, messages } = {}) {
  const el = typeof document !== "undefined" && document.getElementById("pf-loading");
  if (!el) return { reveal() {}, message() {} };
  const msgEl = document.getElementById("pf-loading-msg");
  const t0 = performance.now();
  let frames = 0, forced = false, done = false;

  // cycle a few flavour messages while we wait
  const msgs = messages ?? ["Building the island…", "Streaming the terrain…", "Waking the town…", "Warming up the cars…"];
  let mi = 0;
  const msgTimer = setInterval(() => {
    if (done || !msgEl) return;
    mi = (mi + 1) % msgs.length; msgEl.textContent = msgs[mi];
  }, 1500);

  const ready = () => forced || (typeof window !== "undefined" && window.__pf && window.__pfReady === true);

  const finish = () => {
    if (done) return; done = true;
    clearInterval(msgTimer);
    el.classList.add("pf-hide");
    setTimeout(() => el.remove(), 650);
  };

  const tick = () => {
    if (done) return;
    frames++;
    const elapsed = performance.now() - t0;
    if ((elapsed >= minMs && frames >= framesReady && ready()) || elapsed >= maxMs) { finish(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    reveal() { forced = true; },                          // force the fade now
    message(text) { if (msgEl && !done) msgEl.textContent = text; },
  };
}

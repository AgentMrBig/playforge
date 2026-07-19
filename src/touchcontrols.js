// PlayForge touch controls — on-screen controls for phones/tablets. Owned by General
// (HUD/UI lane). Zero coupling to the game or input.js: every button dispatches a
// synthetic KeyboardEvent on `window`, so it drives the EXACT same code paths as a real
// key (input.js `down()`/`pressed()` and the window keydown action listeners in
// demo/bigisland.js — KeyE enter/exit, KeyF recover, Space jump/handbrake).
//
// Layout: left WASD d-pad (walk + drive — both read WASD), right action cluster
// (E enter/exit, BRAKE/JUMP = Space, FLIP = KeyF). The container is pointer-events:none
// so the rest of the canvas still gets camera drag / the input.js twin-stick; only the
// buttons capture touches. Auto-shows on coarse-pointer devices; force with ?touch=1.

const KEYNAME = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyE: "e", KeyF: "f", Space: " " };
function fireKey(code, isDown) {
  window.dispatchEvent(new KeyboardEvent(isDown ? "keydown" : "keyup", { code, key: KEYNAME[code] || code, bubbles: true }));
}

export class TouchControls {
  static shouldShow() {
    const p = new URLSearchParams(location.search);
    if (p.get("touch") === "1") return true;
    if (p.get("touch") === "0") return false;
    return (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  }

  /** @param {object} [o] @param {HTMLElement} [o.mount=document.body] @param {boolean} [o.force] */
  constructor({ mount = document.body, force = false } = {}) {
    this.enabled = force || TouchControls.shouldShow();
    if (!this.enabled) return;
    this._injectStyle();
    this.root = document.createElement("div");
    this.root.className = "pf-touch";
    this.root.innerHTML = `
      <div class="pf-dpad">
        <button class="pf-btn pf-up"    data-code="KeyW" data-hold>▲</button>
        <button class="pf-btn pf-left"  data-code="KeyA" data-hold>◀</button>
        <button class="pf-btn pf-right" data-code="KeyD" data-hold>▶</button>
        <button class="pf-btn pf-down"  data-code="KeyS" data-hold>▼</button>
      </div>
      <div class="pf-actions">
        <button class="pf-btn pf-enter" data-code="KeyE">E<small>enter/exit</small></button>
        <button class="pf-btn pf-brake" data-code="Space" data-hold>⌷<small>jump/brake</small></button>
        <button class="pf-btn pf-flip"  data-code="KeyF">F<small>flip</small></button>
      </div>`;
    mount.appendChild(this.root);
    this._wire();
  }

  _wire() {
    this.root.querySelectorAll(".pf-btn").forEach((btn) => {
      const code = btn.dataset.code;
      const hold = btn.hasAttribute("data-hold");
      const press = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (btn._on) return;
        btn._on = true; btn.classList.add("pf-on");
        try { btn.setPointerCapture(e.pointerId); } catch {}
        fireKey(code, true);
        if (!hold) { fireKey(code, false); }   // tap actions: down+up now (edge-triggered listeners)
      };
      const release = (e) => {
        if (!btn._on) return;
        e.preventDefault(); e.stopPropagation();
        btn._on = false; btn.classList.remove("pf-on");
        if (hold) fireKey(code, false);        // hold actions: release the key
      };
      btn.addEventListener("pointerdown", press);
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("pointerleave", release);
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    });
  }

  _injectStyle() {
    if (document.getElementById("pf-touch-style")) return;
    const s = document.createElement("style");
    s.id = "pf-touch-style";
    s.textContent = `
      .pf-touch { position: fixed; inset: 0; pointer-events: none; z-index: 40;
        font-family: system-ui, sans-serif; -webkit-user-select: none; user-select: none; touch-action: none; }
      .pf-touch .pf-btn { pointer-events: auto; position: absolute; touch-action: none;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        width: 62px; height: 62px; border-radius: 16px; border: 1px solid rgba(255,255,255,.35);
        background: rgba(20,24,30,.42); color: #eef2f6; font-size: 22px; font-weight: 700;
        backdrop-filter: blur(2px); box-shadow: 0 2px 10px rgba(0,0,0,.3); }
      .pf-touch .pf-btn small { font-size: 8px; font-weight: 500; opacity: .7; margin-top: 1px; letter-spacing: .3px; }
      .pf-touch .pf-btn.pf-on { background: rgba(90,170,255,.55); transform: scale(.96); }
      .pf-dpad { position: absolute; left: 26px; bottom: 30px; width: 200px; height: 200px; }
      .pf-dpad .pf-up    { left: 69px; top: 0; }
      .pf-dpad .pf-down  { left: 69px; top: 138px; }
      .pf-dpad .pf-left  { left: 0;  top: 69px; }
      .pf-dpad .pf-right { left: 138px; top: 69px; }
      .pf-actions { position: absolute; right: 26px; bottom: 30px; width: 200px; height: 200px; }
      .pf-actions .pf-enter { right: 96px; bottom: 60px; background: rgba(40,120,60,.5); }
      .pf-actions .pf-brake { right: 20px; bottom: 6px; }
      .pf-actions .pf-flip  { right: 20px; bottom: 120px; }
      @media (max-width: 520px) { .pf-touch .pf-btn { width: 56px; height: 56px; } }`;
    document.head.appendChild(s);
  }

  dispose() { this.root?.remove(); }
}

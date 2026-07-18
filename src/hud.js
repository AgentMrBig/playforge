// PlayForge HUD — the on-screen instrument layer. Reads game state READ-ONLY and
// draws it; it never touches physics/vehicle/character. Owned by General.
//
// v1 = SPEEDOMETER (Erik 2026-07-18: "hard to see how fast I'm moving"). An analog
// arc gauge + big digital km/h + a redline near top speed, so speed reads at a glance.
//
// Design notes:
//  - Self-contained canvas overlay, no THREE dependency, DPR-aware for crisp text.
//  - TWO drive modes: `attach(source)` runs its own rAF loop (real game use), and
//    `render(state)` draws exactly one frame from an explicit state — the deterministic
//    seam used for headless verification (the game's rAF loop is throttled in a
//    background/agent tab, so needle motion can't be proven by screenshot alone).

const TAU = Math.PI * 2;
const A0 = 0.75 * Math.PI;   // gauge start: down-left (0 km/h)
const SWEEP = 1.5 * Math.PI; // 270° clockwise over the top to down-right (max)

/** Round up to a tidy gauge maximum (nearest 20). */
function niceMax(kmh) { return Math.max(60, Math.ceil(kmh / 20) * 20); }

export class HUD {
  /**
   * @param {object} [opts]
   * @param {number} [opts.size=190]    logical px (square) of the speedometer
   * @param {number} [opts.topKmh]      gauge max; default derived from the source's topSpeed
   * @param {string} [opts.corner="br"] tl|tr|bl|br placement
   * @param {number} [opts.margin=18]   px inset from the corner
   */
  constructor(opts = {}) {
    this.size = opts.size ?? 190;
    this.topKmh = opts.topKmh ?? null;   // resolved from source if null
    this.corner = opts.corner ?? "br";
    this.margin = opts.margin ?? 18;
    this._raf = 0;
    this._source = null;
    this._mounted = false;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pf-hud pf-hud-speedo";
    const s = this.canvas.style;
    s.position = "fixed"; s.zIndex = "50"; s.pointerEvents = "none";
    s.width = this.size + "px"; s.height = this.size + "px";
    this._placeCorner();
    this.ctx = this.canvas.getContext("2d");
    this._sizeBacking();
  }

  _placeCorner() {
    const s = this.canvas.style, m = this.margin + "px";
    s.top = s.bottom = s.left = s.right = "auto";
    if (this.corner.includes("t")) s.top = m; else s.bottom = m;
    if (this.corner.includes("l")) s.left = m; else s.right = m;
  }

  _sizeBacking() {
    const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Add the overlay to the page. */
  mount(parent) {
    (parent ?? document.body).appendChild(this.canvas);
    this._mounted = true;
    return this;
  }

  unmount() { this.stop(); this.canvas.remove(); this._mounted = false; return this; }

  /**
   * Drive the HUD from a live source every frame. `source` is a VehicleBody
   * (has `.kmh` + optional `.topSpeed`) or a function returning `{kmh, topKmh?}`.
   */
  attach(source) {
    if (!this._mounted) this.mount();
    this._source = source;
    this.start();
    return this;
  }

  start() {
    if (this._raf || typeof requestAnimationFrame === "undefined") return;
    const loop = () => { this.render(this._read()); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }

  /** Pull a state object from the attached source. */
  _read() {
    const src = this._source;
    if (!src) return { kmh: 0 };
    if (typeof src === "function") return src() || { kmh: 0 };
    return { kmh: src.kmh ?? 0, topKmh: src.topSpeed != null ? src.topSpeed * 3.6 : undefined, onGround: src.onGround };
  }

  /**
   * Draw one frame. Deterministic — same state in, same pixels out.
   * @param {object} state
   * @param {number} state.kmh        current speed
   * @param {number} [state.topKmh]   gauge maximum (else derived / remembered)
   * @param {boolean}[state.onGround] dims the gauge slightly when airborne
   */
  render(state = {}) {
    const kmh = Math.max(0, state.kmh || 0);
    // gauge max is FIXED once set (Erik 2026-07-18: the dial must NOT grow/rescale when
    // you max out — a real speedo's top number never moves). The needle pins at the top
    // instead (clamped below). Pass an explicit topKmh from the car's top speed.
    this.topKmh = state.topKmh ?? this.topKmh ?? niceMax(kmh || 120);
    const top = this.topKmh;
    const ctx = this.ctx, S = this.size, c = S / 2, r = S * 0.41;

    ctx.clearRect(0, 0, S, S);

    // bezel — dark translucent disc so it reads over any scene
    ctx.beginPath(); ctx.arc(c, c, r + 12, 0, TAU);
    ctx.fillStyle = "rgba(12,14,18,0.62)"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.stroke();

    // track
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(c, c, r, A0, A0 + SWEEP);
    ctx.lineWidth = 8; ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.stroke();

    // redline arc — top ~18% of the range
    const redFrom = 0.82;
    ctx.beginPath(); ctx.arc(c, c, r, A0 + SWEEP * redFrom, A0 + SWEEP);
    ctx.lineWidth = 8; ctx.strokeStyle = "rgba(255,64,52,0.9)"; ctx.stroke();

    // filled progress up to current speed
    const t = Math.min(1, kmh / top);
    const grad = ctx.createLinearGradient(0, 0, S, S);
    grad.addColorStop(0, "#4fd1ff"); grad.addColorStop(1, t > redFrom ? "#ff4034" : "#5affa2");
    ctx.beginPath(); ctx.arc(c, c, r, A0, A0 + SWEEP * t);
    ctx.lineWidth = 8; ctx.strokeStyle = grad; ctx.stroke();

    // ticks + labels every 20 km/h
    ctx.save(); ctx.translate(c, c);
    for (let v = 0; v <= top; v += 20) {
      const a = A0 + SWEEP * (v / top);
      const cos = Math.cos(a), sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cos * (r - 12), sin * (r - 12));
      ctx.lineTo(cos * (r - 4), sin * (r - 4));
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = `${Math.round(S * 0.058)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(v), cos * (r - 24), sin * (r - 24));
    }
    // needle
    const na = A0 + SWEEP * t;
    ctx.rotate(na);
    ctx.beginPath(); ctx.moveTo(-r * 0.12, 0); ctx.lineTo(r * 0.9, 0);
    ctx.lineWidth = 3; ctx.strokeStyle = t > redFrom ? "#ff4034" : "#ffffff"; ctx.stroke();
    ctx.restore();

    // hub
    ctx.beginPath(); ctx.arc(c, c, 5, 0, TAU); ctx.fillStyle = "#e8eef5"; ctx.fill();

    // digital readout
    ctx.fillStyle = state.onGround === false ? "rgba(255,255,255,0.65)" : "#ffffff";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = `700 ${Math.round(S * 0.19)}px system-ui, sans-serif`;
    ctx.fillText(String(Math.round(kmh)), c, c + S * 0.30);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `${Math.round(S * 0.062)}px system-ui, sans-serif`;
    ctx.fillText("KM/H", c, c + S * 0.40);
    return this;
  }
}

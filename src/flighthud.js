// Flight HUD — a real attitude/instrument overlay for flying the jet (Erik: "I get lost
// flying, I need instrumentation that shows the horizon" + speed + altitude). Owned by
// General. Self-contained canvas overlay, data-driven: feed it a state each frame and it
// draws an artificial horizon (pitch + roll), a speed tape, an altitude tape, and heading.
//
//   const fhud = new FlightHUD();
//   fhud.show();                                   // when you enter the jet
//   fhud.render({ speed, altitude, pitch, roll, heading });   // each frame while flying
//   fhud.hide();                                   // when you exit
//
// Angles in RADIANS. speed in m/s (shown as km/h), altitude in metres.

export class FlightHUD {
  constructor({ size = 360 } = {}) {
    const c = this.canvas = document.createElement("canvas");
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.w = size; this.h = size * 0.72; this.dpr = dpr;
    c.width = this.w * dpr; c.height = this.h * dpr;
    Object.assign(c.style, {
      position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
      width: this.w + "px", height: this.h + "px", pointerEvents: "none",
      zIndex: "40", display: "none", opacity: "0.92",
    });
    if (typeof document !== "undefined") document.body.appendChild(c);
    this.ctx = c.getContext("2d");
    this.ctx.scale(dpr, dpr);
    this.visible = false;
    this.color = "#7dff9e";           // instrument green
  }

  show() { this.visible = true; this.canvas.style.display = "block"; }
  hide() { this.visible = false; this.canvas.style.display = "none"; }

  /** @param {{speed:number, altitude:number, pitch:number, roll:number, heading?:number}} s */
  render(s) {
    if (!this.visible) return;
    const ctx = this.ctx, W = this.w, H = this.h, cx = W / 2, cy = H / 2, col = this.color;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.font = "13px 'Consolas', monospace"; ctx.textBaseline = "middle";

    // ---- ARTIFICIAL HORIZON (clipped to a center circle) --------------------
    const R = Math.min(W, H) * 0.42;
    const pitch = s.pitch || 0, roll = s.roll || 0;
    const pxPerRad = R / (Math.PI / 3);              // ±60° fills the ball
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);                                // bank
    ctx.translate(0, pitch * pxPerRad);               // nose-up → horizon drops
    // horizon line + pitch ladder
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(-R * 1.6, 0); ctx.lineTo(R * 1.6, 0); ctx.stroke();  // horizon
    ctx.font = "10px 'Consolas', monospace"; ctx.textAlign = "center";
    for (let deg = -60; deg <= 60; deg += 10) {
      if (deg === 0) continue;
      const y = -deg * (Math.PI / 180) * pxPerRad;
      const half = deg % 20 === 0 ? 34 : 18;
      ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.moveTo(-half, y); ctx.lineTo(half, y); ctx.stroke();
      if (deg % 20 === 0) { ctx.fillText(Math.abs(deg), -half - 12, y); ctx.fillText(Math.abs(deg), half + 12, y); }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ball ring + roll pointer
    ctx.strokeStyle = col; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    // roll arc ticks (top)
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const rad = -Math.PI / 2 + a * Math.PI / 180;
      const r1 = R, r2 = R - (a % 30 === 0 ? 12 : 7);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * r1, cy + Math.sin(rad) * r1);
      ctx.lineTo(cx + Math.cos(rad) * r2, cy + Math.sin(rad) * r2);
      ctx.stroke();
    }
    // current-roll pointer (triangle at top, fixed; the arc scale rotates under it)
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-roll);
    ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(-6, -R + 11); ctx.lineTo(6, -R + 11); ctx.closePath();
    ctx.fillStyle = "#ffd23f"; ctx.fill(); ctx.restore();

    // fixed aircraft reference (waterline "wings")
    ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 3; ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 46, cy); ctx.lineTo(cx - 18, cy); ctx.lineTo(cx - 10, cy + 8);
    ctx.moveTo(cx + 46, cy); ctx.lineTo(cx + 18, cy); ctx.lineTo(cx + 10, cy + 8);
    ctx.moveTo(cx, cy - 4); ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;

    // ---- SPEED tape (left) + ALTITUDE tape (right) --------------------------
    const kmh = Math.round((s.speed || 0) * 3.6);
    const alt = Math.round(s.altitude || 0);
    this._box(ctx, 6, cy, 66, `${kmh}`, "km/h", "right");
    this._box(ctx, W - 6, cy, 78, `${alt} m`, "ALT", "left");

    // ---- heading (top center) ----------------------------------------------
    if (s.heading != null) {
      let hd = Math.round(((-s.heading * 180 / Math.PI) % 360 + 360) % 360);
      ctx.fillStyle = col; ctx.globalAlpha = 0.95; ctx.textAlign = "center"; ctx.font = "14px 'Consolas', monospace";
      const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(hd / 45) % 8];
      ctx.fillText(`${String(hd).padStart(3, "0")}°  ${dir}`, cx, 12);
    }
    ctx.globalAlpha = 1;
  }

  _box(ctx, x, cy, w, big, label, side) {
    const col = this.color, h = 30, right = side === "right";
    const bx = right ? x : x - w;
    ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.rect(bx, cy - h / 2, w, h); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = right ? "left" : "right"; ctx.font = "16px 'Consolas', monospace";
    ctx.fillText(big, right ? bx + 6 : bx + w - 6, cy);
    ctx.font = "9px 'Consolas', monospace"; ctx.globalAlpha = 0.7;
    ctx.textAlign = "center"; ctx.fillText(label, bx + w / 2, cy - h / 2 - 7);
    ctx.globalAlpha = 1;
  }

  dispose() { this.canvas.remove(); }
}

if (typeof window !== "undefined") window.FlightHUD = FlightHUD;   // console test/tune

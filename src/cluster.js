/**
 * Cluster — a car-style instrument cluster overlay: analog tachometer + speedo
 * with sweeping needles, redline zone, and digital readouts. Pure canvas 2D,
 * drawn each frame. Fed by the audio RPM + the car speed.
 *
 *   const cluster = new Cluster();
 *   cluster.update(rpm, kmh);
 */
export class Cluster {
  constructor({ maxRpm = 7000, redlineRpm = 6000, maxKmh = 220 } = {}) {
    this.maxRpm = maxRpm; this.redlineRpm = redlineRpm; this.maxKmh = maxKmh;
    const c = document.createElement("canvas");
    c.width = 460; c.height = 210;
    c.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);" +
      "pointer-events:none;z-index:30;filter:drop-shadow(0 3px 8px rgba(0,0,0,.6));";
    if (innerWidth < 760) {                 // phone: smaller cluster, clear of thumb buttons
      c.style.transformOrigin = "50% 100%";
      c.style.transform = "translateX(-50%) scale(0.58)";
      c.style.bottom = "2px";
    }
    document.body.appendChild(c);
    this.canvas = c; this.ctx = c.getContext("2d");
    this.rpm = 0; this.kmh = 0;
  }

  update(rpm, kmh) {
    this.rpm += (rpm - this.rpm) * 0.25;
    this.kmh += (kmh - this.kmh) * 0.25;
    this._draw();
  }

  _gauge(cx, cy, r, frac, big, label, redFrac) {
    const ctx = this.ctx;
    const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25, span = A1 - A0;   // 270° sweep
    // face
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10,14,18,.9)"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#243240"; ctx.stroke();
    // redline arc
    if (redFrac != null) {
      ctx.beginPath(); ctx.arc(cx, cy, r - 6, A0 + span * redFrac, A1);
      ctx.lineWidth = 5; ctx.strokeStyle = "#c0392b"; ctx.stroke();
    }
    // ticks
    const majors = 8;
    for (let i = 0; i <= majors; i++) {
      const a = A0 + span * (i / majors);
      const on = redFrac != null && i / majors >= redFrac;
      ctx.strokeStyle = on ? "#e05a4a" : "#7fd7ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
      ctx.lineTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14));
      ctx.stroke();
    }
    // needle
    const na = A0 + span * Math.max(0, Math.min(1, frac));
    ctx.strokeStyle = "#ff5533"; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx - Math.cos(na) * 8, cy - Math.sin(na) * 8);
    ctx.lineTo(cx + Math.cos(na) * (r - 16), cy + Math.sin(na) * (r - 16)); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fillStyle = "#ff5533"; ctx.fill();
    // digital readout
    ctx.fillStyle = "#eaf6ff"; ctx.textAlign = "center";
    ctx.font = "700 26px ui-monospace, monospace";
    ctx.fillText(big, cx, cy + r - 4);
    ctx.fillStyle = "#6f8496"; ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(label, cx, cy + r + 12);
  }

  _draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const r = 82, cy = 96;
    this._gauge(150, cy, r, this.rpm / this.maxRpm, (this.rpm / 1000).toFixed(1), "RPM x1000", this.redlineRpm / this.maxRpm);
    this._gauge(310, cy, r, this.kmh / this.maxKmh, Math.round(this.kmh) + "", "KM/H", null);
  }
}

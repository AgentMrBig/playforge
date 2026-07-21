/**
 * PlaneTuner — a live flight-feel panel (Ember, Erik 2026-07-20 planes). Mirrors
 * the car tuning sliders: dial the plane's aerodynamics WHILE flying so Erik can
 * find the feel without code round-trips. Binds straight to window.__pfPlane (the
 * single FlightModel), so every change is read next physics step. Toggle with the
 * ✈️ PLANE button or the P key. Self-contained — no dependency on the car panel.
 */
export class PlaneTuner {
  constructor() {
    this._buildUI();
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyP" && !e.repeat && !/input|textarea/i.test(document.activeElement?.tagName || "")) this.toggle();
    });
  }

  toggle() {
    const open = this.panel.style.display === "none";
    this.panel.style.display = open ? "block" : "none";
    this.btn.classList.toggle("pf-on", open);
    if (open) this._syncSliders();
  }

  _buildUI() {
    if (!document.getElementById("pf-ptest-css")) {
      const css = document.createElement("style"); css.id = "pf-ptest-css";
      css.textContent = `
        .pf-ptest-btn { position: fixed; top: 46px; left: 242px; z-index: 30; padding: 8px 12px;
          background: rgba(20,24,32,.85); color: #fff; border: 1px solid rgba(255,255,255,.25);
          border-radius: 8px; font: 600 13px system-ui; cursor: pointer; }
        .pf-ptest-btn.pf-on { background: rgba(70,150,230,.85); }
        .pf-ptest-panel { position: fixed; top: 188px; right: 10px; z-index: 30; width: 236px;
          max-height: calc(100vh - 206px); overflow-y: auto;
          background: rgba(18,24,34,.9); color: #fff; border: 1px solid rgba(120,170,230,.3);
          border-radius: 10px; padding: 10px; font: 500 12px system-ui; }
        .pf-ptest-panel h4 { margin: 2px 0 6px; font-size: 11px; opacity: .7; text-transform: uppercase; }
        .pf-ptest-panel label.pf-slide { display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 11px; }
        .pf-ptest-panel label.pf-slide b { width: 74px; opacity: .74; font-weight: 600; }
        .pf-ptest-panel label.pf-slide input[type=range] { flex: 1; accent-color: #4a9be6; min-width: 0; }
        .pf-ptest-panel label.pf-slide span { width: 40px; text-align: right; opacity: .85; font-variant-numeric: tabular-nums; }
        .pf-ptest-panel .pf-hint { opacity: .5; font-size: 10px; margin: 2px 0 6px; }
        .pf-ptest-panel button { margin: 6px 2px 0 0; padding: 6px 8px; background: rgba(255,255,255,.08);
          color: #fff; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; font: 600 11px system-ui; cursor: pointer; }
        .pf-ptest-panel button:hover { background: rgba(255,255,255,.16); }`;
      document.head.appendChild(css);
    }
    this.btn = document.createElement("button");
    this.btn.className = "pf-ptest-btn"; this.btn.textContent = "✈️ PLANE (P)";
    this.btn.addEventListener("click", () => this.toggle());
    document.body.appendChild(this.btn);

    this.panel = document.createElement("div");
    this.panel.className = "pf-ptest-panel"; this.panel.style.display = "none";
    this.panel.innerHTML = `
      <h4>🎛️ flight tuning · live</h4>
      <div class="pf-hint">dial while flying — reads next frame</div>
      <label class="pf-slide"><b>Thrust</b><input type="range" data-knob="maxThrust" min="8000" max="42000" step="500"><span data-kv="maxThrust"></span></label>
      <label class="pf-slide"><b>Lift</b><input type="range" data-knob="liftCoef" min="4" max="16" step="0.5"><span data-kv="liftCoef"></span></label>
      <label class="pf-slide"><b>Drag</b><input type="range" data-knob="dragCoef" min="2" max="10" step="0.25"><span data-kv="dragCoef"></span></label>
      <label class="pf-slide"><b>Stall spd</b><input type="range" data-knob="stallSpeed" min="14" max="40" step="1"><span data-kv="stallSpeed"></span></label>
      <label class="pf-slide"><b>Pitch</b><input type="range" data-knob="pitchTorque" min="8000" max="48000" step="1000"><span data-kv="pitchTorque"></span></label>
      <label class="pf-slide"><b>Roll</b><input type="range" data-knob="rollTorque" min="20000" max="90000" step="2000"><span data-kv="rollTorque"></span></label>
      <label class="pf-slide"><b>Yaw</b><input type="range" data-knob="yawTorque" min="6000" max="34000" step="1000"><span data-kv="yawTorque"></span></label>
      <label class="pf-slide"><b>Steadiness</b><input type="range" data-knob="stabilize" min="0" max="4000" step="100"><span data-kv="stabilize"></span></label>
      <button data-act="reset">↺ reset tuning</button>`;

    this.panel.addEventListener("input", (e) => {
      const el = e.target.closest("input[type=range]"); if (!el) return;
      const knob = el.dataset.knob, val = +el.value;
      const fm = window.__pfPlane; if (fm) fm[knob] = val;
      this._kvText(knob, val);
    });
    this.panel.addEventListener("click", (e) => {
      if (e.target.closest("button")?.dataset.act === "reset") {
        const fm = window.__pfPlane;
        if (fm) for (const [k, v] of Object.entries(PlaneTuner.DEFAULTS)) fm[k] = v;
        this._syncSliders();
      }
    });
    document.body.appendChild(this.panel);
  }

  _kvText(knob, val) {
    const fine = knob === "liftCoef" || knob === "dragCoef";
    const kv = this.panel.querySelector(`[data-kv="${knob}"]`);
    if (kv) kv.textContent = fine ? (+val).toFixed(2) : String(Math.round(val));
  }

  /** set every slider + readout to the live plane's current values */
  _syncSliders() {
    const fm = window.__pfPlane; if (!fm) return;
    for (const knob of Object.keys(PlaneTuner.DEFAULTS)) {
      const cur = fm[knob]; if (cur == null) continue;
      const inp = this.panel.querySelector(`input[data-knob="${knob}"]`);
      if (inp) inp.value = cur;
      this._kvText(knob, cur);
    }
  }
}

// mirrors src/flight.js FlightModel constructor defaults (keep in sync)
PlaneTuner.DEFAULTS = {
  maxThrust: 22000, liftCoef: 9, dragCoef: 5.5, stallSpeed: 26,
  pitchTorque: 15000, rollTorque: 50000, yawTorque: 15000, stabilize: 1600,
};

import * as THREE from "three";

/**
 * VehicleTestMode — Ember's vehicle test rig (Erik: "there will be a vehicle
 * test mode as well"). Sibling of General's character TestMode: 🚗 button (or V)
 * detaches the camera into a free orbit around a car and opens a panel that
 * drives the REAL damage pipeline — no cosmetic fakes:
 *
 *   • crash buttons  → CarCollisions.testHit (same dent/spark/wheel/smoke path
 *                      as a physics contact, same severity units)
 *   • wheel buttons  → cycle OK → FLAT → LOCKED → OFF via Ninja's live setters
 *   • smoke buttons  → set entity.smokeDmg (clean / wisps / wrecked plume)
 *   • ♻ reset       → CarCollisions.resetCar (un-dent, revive wheels, zero dmg)
 *
 * Orbit: drag = rotate, wheel = zoom. Spawn AFTER the camera rig so this
 * update() runs later and wins while active (General's pattern).
 */
export class VehicleTestMode {
  /** @param {object} o.world needs .camera; cars found via window.__pf */
  constructor({ world } = {}) {
    this.world = world;
    this.active = false;
    this.carIdx = 0;
    this.side = "front";
    this.yaw = 0.7; this.pitch = 0.45; this.dist = 9;
    this._drag = null;
    this._buildUI();
    window.addEventListener("keydown", (e) => { if (e.code === "KeyV" && !e.repeat) this.toggle(); });
    window.addEventListener("mousedown", (e) => { if (this.active && e.target.tagName === "CANVAS") this._drag = [e.clientX, e.clientY]; });
    window.addEventListener("mouseup", () => (this._drag = null));
    window.addEventListener("mousemove", (e) => {
      if (!this.active || !this._drag) return;
      this.yaw -= (e.clientX - this._drag[0]) * 0.008;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this._drag[1]) * 0.006, 0.05, 1.35);
      this._drag = [e.clientX, e.clientY];
    });
    window.addEventListener("wheel", (e) => { if (this.active) this.dist = THREE.MathUtils.clamp(this.dist + Math.sign(e.deltaY) * 0.8, 4, 25); });
  }

  get car() {
    const cars = window.__pf?.cars ?? [];
    if (!cars.length) return null;
    return window.__pf?.drivingCar ?? cars[Math.abs(this.carIdx) % cars.length];
  }
  get dmgSys() { return window.__pfDamage ?? null; }
  _vb(car) { return car?.components?.find((c) => c.rb && c.suspension); }

  toggle(on = !this.active) {
    this.active = on;
    document.exitPointerLock?.();                      // free the mouse for the panel
    this.btn.classList.toggle("pf-on", on);
    this.panel.style.display = on ? "block" : "none";
    if (on) this._refresh();
  }

  _hit(sev) { const c = this.car; if (c && this.dmgSys) { this.dmgSys.testHit(c, sev, this.side); this._refresh(); } }

  _cycleWheel(i) {
    const vb = this._vb(this.car); if (!vb) return;
    const flat = !!vb._flat?.[i], locked = !!vb._locked?.[i], off = !!vb._detached?.[i];
    if (off) { vb.setWheelDetached(i, false); vb.setWheelLocked(i, false); vb.setWheelFlat?.(i, false); }
    else if (locked) { vb.setWheelLocked(i, false); vb.setWheelDetached(i, true); }
    else if (flat) { vb.setWheelFlat?.(i, false); vb.setWheelLocked(i, true); }
    else vb.setWheelFlat?.(i, true);
    this._refresh();
  }

  _refresh() {
    const c = this.car, vb = this._vb(c);
    this.panel.querySelector("[data-car]").textContent =
      c ? `${c.specName ?? "car"} · dmg ${(c.damage ?? 0).toFixed(1)} · smoke ${(c.smokeDmg ?? 0).toFixed(1)}` : "(no car)";
    this.panel.querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("pf-sel", b.dataset.side === this.side));
    const names = ["FL", "FR", "RL", "RR"];
    this.panel.querySelectorAll("[data-wheel]").forEach((b) => {
      const i = +b.dataset.wheel;
      const st = vb?._detached?.[i] ? "OFF" : vb?._locked?.[i] ? "LOCK" : vb?._flat?.[i] ? "FLAT" : "ok";
      b.textContent = `${names[i]}: ${st}`;
      b.classList.toggle("pf-sel", st !== "ok");
    });
  }

  /** per-frame: orbit the camera around the car (runs after the rig → wins) */
  update() {
    if (!this.active) return;
    // the game re-grabs pointer lock on canvas click (Erik: "if it captures my
    // cursor, I can't click anything") — while the test rig is open, the cursor
    // must ALWAYS stay visible, so break the lock the moment it re-engages
    if (document.pointerLockElement) document.exitPointerLock?.();
    const c = this.car; if (!c?.position) return;
    const cam = this.world.camera;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    cam.position.set(
      c.position.x + Math.cos(this.yaw) * cp * this.dist,
      c.position.y + sp * this.dist,
      c.position.z + Math.sin(this.yaw) * cp * this.dist,
    );
    cam.lookAt(c.position.x, c.position.y + 0.6, c.position.z);
    if ((this._t = (this._t ?? 0) + 1) % 30 === 0) this._refresh();   // live dmg readout
  }

  _buildUI() {
    if (!document.getElementById("pf-vtest-css")) {
      const css = document.createElement("style"); css.id = "pf-vtest-css";
      css.textContent = `
        .pf-vtest-btn { position: fixed; top: 46px; left: 148px; z-index: 30; padding: 8px 12px;
          background: rgba(20,24,32,.85); color: #fff; border: 1px solid rgba(255,255,255,.25);
          border-radius: 8px; font: 600 13px system-ui; cursor: pointer; }
        .pf-vtest-btn.pf-on { background: rgba(230,120,40,.85); }
        .pf-vtest-panel { position: fixed; top: 92px; left: 10px; z-index: 30; width: 200px;
          background: rgba(20,24,32,.88); color: #fff; border: 1px solid rgba(255,255,255,.2);
          border-radius: 10px; padding: 10px; font: 500 12px system-ui; }
        .pf-vtest-panel h4 { margin: 6px 0 4px; font-size: 11px; opacity: .7; text-transform: uppercase; }
        .pf-vtest-panel button { display: inline-block; margin: 2px 2px 2px 0; padding: 6px 8px;
          background: rgba(255,255,255,.08); color: #fff; border: 1px solid rgba(255,255,255,.18);
          border-radius: 6px; font: 600 11px system-ui; cursor: pointer; }
        .pf-vtest-panel button:hover { background: rgba(255,255,255,.16); }
        .pf-vtest-panel button.pf-sel { background: rgba(230,120,40,.5); }
        .pf-vtest-panel .pf-row { margin-bottom: 2px; }`;
      document.head.appendChild(css);
    }
    this.btn = document.createElement("button");
    this.btn.className = "pf-vtest-btn"; this.btn.textContent = "🚗 CAR (V)";
    this.btn.addEventListener("click", () => this.toggle());
    document.body.appendChild(this.btn);

    this.panel = document.createElement("div");
    this.panel.className = "pf-vtest-panel"; this.panel.style.display = "none";
    this.panel.innerHTML = `
      <div data-car style="margin-bottom:6px;font-weight:700"></div>
      <h4>hit side</h4>
      <div class="pf-row">
        <button data-side="front">front</button><button data-side="rear">rear</button>
        <button data-side="left">left</button><button data-side="right">right</button>
      </div>
      <h4>crash</h4>
      <div class="pf-row">
        <button data-sev="1">light</button><button data-sev="5">hard</button><button data-sev="25">💀 total</button>
      </div>
      <h4>wheels (click to cycle)</h4>
      <div class="pf-row">
        <button data-wheel="0"></button><button data-wheel="1"></button>
        <button data-wheel="2"></button><button data-wheel="3"></button>
      </div>
      <h4>smoke</h4>
      <div class="pf-row">
        <button data-smoke="0">clean</button><button data-smoke="12">wisps</button><button data-smoke="30">plume</button>
      </div>
      <div class="pf-row" style="margin-top:8px">
        <button data-act="reset">♻ reset car</button>
      </div>`;
    this.panel.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.side) this.side = b.dataset.side;
      else if (b.dataset.sev) this._hit(+b.dataset.sev);
      else if (b.dataset.wheel) this._cycleWheel(+b.dataset.wheel);
      else if (b.dataset.smoke !== undefined) { const c = this.car; if (c) c.smokeDmg = +b.dataset.smoke; }
      else if (b.dataset.act === "reset") { const c = this.car; if (c && this.dmgSys) this.dmgSys.resetCar(c); }
      this._refresh();
    });
    document.body.appendChild(this.panel);
  }
}

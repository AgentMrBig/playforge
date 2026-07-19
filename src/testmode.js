// PlayForge TEST MODE — the character inspector Erik specced (2026-07-19):
// "out of the player's body, move around the character freely, make the character do
// the actions via a menu — toggle walk, run, all the different states, observe from
// all angles. This will help us MASSIVELY."
//
// Owned by General (character lane). Design: a DOM side panel + an orbit camera that
// takes over AFTER the game's rig each frame. State forcing goes through
// window.__pfTest, which the game's anim-select respects (one small hook in
// bigisland.js); everything else reads the public handles (__pf, __pfCombat, __rag).
//
// Toggle: the 🧪 TEST button (top-left, next to 💥) or press T. In test mode:
// drag = orbit · wheel = zoom · panel picks the state/weapon. Firing clicks are
// disabled so the mouse is free for the camera.

export class TestMode {
  /**
   * @param {object} o
   * @param {object} o.world      needs .camera
   * @param {object} o.player     the player entity (position + object3d)
   * @param {object} o.input      engine input (pointer dx/dy + wheel)
   * @param {string[]} [o.anims]  clip names to list (buttons); defaults to the known set
   */
  constructor({ world, player, input, anims } = {}) {
    this.world = world; this.player = player; this.input = input;
    this.active = false;
    this.anim = null;               // forced clip name (null = game logic drives)
    this.yaw = 0.6; this.pitch = 0.35; this.dist = 4.2;   // orbit state
    this.anims = anims || ["idle", "walk", "run", "jump", "rifleIdle", "pistolIdle", "firingRifle"];
    this._buildUI();
    window.addEventListener("keydown", (e) => { if (e.code === "KeyT" && !e.repeat) this.toggle(); });
    if (typeof window !== "undefined") window.__pfTest = this;
  }

  toggle(on = !this.active) {
    this.active = on;
    this.panel.style.display = on ? "" : "none";
    this.btn.classList.toggle("pf-on", on);
    if (!on) this.anim = null;                       // hand animation back to the game
  }

  /** force a state; null returns control to the game's anim logic */
  set(name) {
    this.anim = name;
    this.panel.querySelectorAll("[data-anim]").forEach((b) => b.classList.toggle("pf-sel", b.dataset.anim === String(name)));
  }

  /** per-frame: orbit camera around the character (runs after the rig → wins) */
  update() {
    if (!this.active || !this.player) return;
    const p = this.player.position;
    // drag orbits, wheel zooms (reads the engine's own pointer deltas)
    const ptr = this.input?.pointer;
    if (ptr) {
      if (ptr.down) { this.yaw -= ptr.dx * 0.008; this.pitch = Math.max(-1.2, Math.min(1.35, this.pitch + ptr.dy * 0.006)); }
      if (ptr.wheel) this.dist = Math.max(1.4, Math.min(14, this.dist + ptr.wheel * 0.5));
    }
    const cam = this.world.camera;
    const cy = Math.cos(this.pitch), h = 1.05;
    cam.position.set(
      p.x + Math.sin(this.yaw) * cy * this.dist,
      p.y + h + Math.sin(this.pitch) * this.dist,
      p.z + Math.cos(this.yaw) * cy * this.dist);
    cam.lookAt(p.x, p.y + h, p.z);
  }

  _buildUI() {
    if (!document.getElementById("pf-test-style")) {
      const s = document.createElement("style");
      s.id = "pf-test-style";
      s.textContent = `
        .pf-test-btn { position: fixed; left: 16px; top: 64px; z-index: 45; padding: 10px 16px; border-radius: 10px;
          border: 0; background: #2c6e8fdd; color: #fff; font: 700 14px system-ui; cursor: pointer; }
        .pf-test-btn.pf-on { background: #1d9b6cdd; }
        .pf-test-panel { position: fixed; right: 16px; top: 205px; z-index: 45; width: 172px;   /* below the minimap */
          background: rgba(16,20,26,.88); border: 1px solid rgba(255,255,255,.16); border-radius: 12px;
          padding: 10px; font: 12px system-ui; color: #dfe6ec; }
        .pf-test-panel h4 { margin: 4px 0 6px; font-size: 11px; letter-spacing: .8px; opacity: .65; text-transform: uppercase; }
        .pf-test-panel button { display: block; width: 100%; margin: 3px 0; padding: 7px 9px; text-align: left;
          border: 0; border-radius: 8px; background: rgba(255,255,255,.08); color: #eef2f6; font: 12px system-ui; cursor: pointer; }
        .pf-test-panel button:hover { background: rgba(255,255,255,.16); }
        .pf-test-panel button.pf-sel { background: rgba(60,160,255,.45); }
        .pf-test-hint { opacity: .55; font-size: 10.5px; margin-top: 7px; line-height: 1.45; }
        .pf-grip-row { display: flex; gap: 3px; align-items: center; margin: 3px 0; }
        .pf-grip-row span { width: 24px; opacity: .6; font-size: 10.5px; }
        .pf-grip-row b { flex: 1; text-align: center; padding: 5px 0; border-radius: 6px; font-weight: 600;
          background: rgba(255,255,255,.08); cursor: pointer; font-size: 10.5px; user-select: none; }
        .pf-grip-row b:hover { background: rgba(90,170,255,.4); }
        .pf-grip-vals { font-size: 9.5px; opacity: .7; margin: 4px 0 5px; word-break: break-all; line-height: 1.4; }`;
      document.head.appendChild(s);
    }
    this.btn = document.createElement("button");
    this.btn.className = "pf-test-btn"; this.btn.textContent = "🧪 TEST (T)";
    this.btn.addEventListener("click", () => this.toggle());
    document.body.appendChild(this.btn);

    this.panel = document.createElement("div");
    this.panel.className = "pf-test-panel"; this.panel.style.display = "none";
    const animBtns = this.anims.map((a) => `<button data-anim="${a}">${a}</button>`).join("");
    this.panel.innerHTML = `
      <h4>Animation state</h4>
      <button data-anim="null" class="pf-sel">game logic (live)</button>
      ${animBtns}
      <h4>Weapon</h4>
      <button data-act="weapon">cycle weapon (Q)</button>
      <h4>Grip editor</h4>
      <div class="pf-grip">
        <div class="pf-grip-row"><span>pos</span>
          <b data-n="px-">−x</b><b data-n="px+">+x</b><b data-n="py-">−y</b><b data-n="py+">+y</b><b data-n="pz-">−z</b><b data-n="pz+">+z</b></div>
        <div class="pf-grip-row"><span>rot</span>
          <b data-n="rx-">−x</b><b data-n="rx+">+x</b><b data-n="ry-">−y</b><b data-n="ry+">+y</b><b data-n="rz-">−z</b><b data-n="rz+">+z</b></div>
        <div class="pf-grip-vals"></div>
        <button data-act="capture">📸 capture grip</button>
        <button data-act="gripreset">↩ reset grip</button>
      </div>
      <h4>Physics</h4>
      <button data-act="ragdoll">💥 ragdoll (B)</button>
      <div class="pf-test-hint">drag = orbit · wheel = zoom<br>grip: 1cm / 5° per tap<br>T toggles test mode</div>`;
    document.body.appendChild(this.panel);
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());   // panel clicks don't orbit
    this.panel.querySelectorAll("[data-anim]").forEach((b) =>
      b.addEventListener("click", () => this.set(b.dataset.anim === "null" ? null : b.dataset.anim)));
    this.panel.querySelector('[data-act="weapon"]').addEventListener("click", () => { window.__pfCombat?.cycle(1); setTimeout(() => this._gripReadout(), 300); });
    this.panel.querySelector('[data-act="ragdoll"]').addEventListener("click", () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyB" })));
    // grip editor: nudge the held weapon 1cm / 5° per tap, capture persists it per-weapon
    const STEP_P = 0.01, STEP_R = Math.PI / 36;
    this.panel.querySelectorAll(".pf-grip b").forEach((b) => b.addEventListener("click", () => {
      const cs = window.__pfCombat; if (!cs) return;
      const [kind, axis, sign] = [b.dataset.n[0], b.dataset.n[1], b.dataset.n[2] === "+" ? 1 : -1];
      const d = [0, 0, 0]; d[{ x: 0, y: 1, z: 2 }[axis]] = sign * (kind === "p" ? STEP_P : STEP_R);
      cs.nudgeHold(kind === "p" ? d : [0, 0, 0], kind === "r" ? d : [0, 0, 0]);
      this._gripReadout();
    }));
    this.panel.querySelector('[data-act="capture"]').addEventListener("click", () => {
      const saved = window.__pfCombat?.saveGrip();
      this._gripReadout(`📸 saved ${saved?.weapon}`);
      console.log("[grip captured]", JSON.stringify(saved));   // paste this to General to bake in for everyone
    });
    this.panel.querySelector('[data-act="gripreset"]').addEventListener("click", () => { window.__pfCombat?.resetGrip(); this._gripReadout("reset"); });
    this._gripReadout();
  }

  _gripReadout(note) {
    const el = this.panel?.querySelector(".pf-grip-vals"); const cs = window.__pfCombat;
    if (el && cs) el.textContent = `${cs.weaponId}: p[${cs.hold.pos.map((v) => v.toFixed(2)).join(",")}] r[${cs.hold.rot.map((v) => v.toFixed(2)).join(",")}]${note ? " · " + note : ""}`;
  }
}

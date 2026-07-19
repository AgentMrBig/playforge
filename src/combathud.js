// PlayForge combat HUD — crosshair + weapon/ammo readout. Owned by General (HUD lane).
// DOM overlay (pointer-events:none), independent of the canvas speedometer. Driven by
// the CombatSystem: call update({name, ammo, maxAmmo, kind}) on equip/fire, flashHit()
// on a confirmed hit. Auto-hidden until the first weapon is equipped.

export class CombatHUD {
  constructor({ mount = document.body } = {}) {
    this._injectStyle();
    this.root = document.createElement("div");
    this.root.className = "pf-combat";
    this.root.innerHTML = `
      <div class="pf-xhair" aria-hidden="true"><span></span><span></span><span></span><span></span><i></i></div>
      <div class="pf-wpn"><b class="pf-wpn-name">—</b><span class="pf-wpn-ammo"></span></div>`;
    mount.appendChild(this.root);
    this.name = this.root.querySelector(".pf-wpn-name");
    this.ammoEl = this.root.querySelector(".pf-wpn-ammo");
    this.xhair = this.root.querySelector(".pf-xhair");
    this.root.style.display = "none";
  }

  update({ name = "—", ammo = Infinity, maxAmmo = Infinity, kind = "ranged" } = {}) {
    this.root.style.display = "";
    this.name.textContent = name;
    // melee shows no ammo; ranged shows ammo (∞ for unlimited)
    this.ammoEl.textContent = kind === "melee" ? "melee" : (Number.isFinite(ammo) ? `${ammo}${Number.isFinite(maxAmmo) ? " / " + maxAmmo : ""}` : "∞");
    this.ammoEl.classList.toggle("pf-empty", Number.isFinite(ammo) && ammo <= 0);
    // crosshair collapses to a dot for melee
    this.xhair.classList.toggle("pf-melee", kind === "melee");
  }

  /** brief red pulse on a confirmed hit */
  flashHit() {
    this.xhair.classList.remove("pf-hit"); void this.xhair.offsetWidth; this.xhair.classList.add("pf-hit");
  }

  _injectStyle() {
    if (document.getElementById("pf-combat-style")) return;
    const s = document.createElement("style");
    s.id = "pf-combat-style";
    s.textContent = `
      .pf-combat { position: fixed; inset: 0; pointer-events: none; z-index: 35; font-family: system-ui, sans-serif; }
      .pf-xhair { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; transform: translate(-50%, -50%); }
      .pf-xhair span { position: absolute; background: rgba(255,255,255,.85); box-shadow: 0 0 2px rgba(0,0,0,.6); }
      .pf-xhair span:nth-child(1), .pf-xhair span:nth-child(2) { left: 50%; width: 2px; height: 8px; margin-left: -1px; }
      .pf-xhair span:nth-child(1) { top: 0; } .pf-xhair span:nth-child(2) { bottom: 0; }
      .pf-xhair span:nth-child(3), .pf-xhair span:nth-child(4) { top: 50%; height: 2px; width: 8px; margin-top: -1px; }
      .pf-xhair span:nth-child(3) { left: 0; } .pf-xhair span:nth-child(4) { right: 0; }
      .pf-xhair i { position: absolute; left: 50%; top: 50%; width: 2px; height: 2px; margin: -1px 0 0 -1px; background: rgba(255,255,255,.9); border-radius: 50%; }
      .pf-xhair.pf-melee span { opacity: 0; } .pf-xhair.pf-melee i { width: 6px; height: 6px; margin: -3px 0 0 -3px; background: rgba(255,120,90,.9); }
      .pf-xhair.pf-hit span, .pf-xhair.pf-hit i { background: #ff4d4d !important; animation: pf-hit .18s ease-out; }
      @keyframes pf-hit { from { transform: scale(1.5); } to { transform: scale(1); } }
      .pf-wpn { position: absolute; right: 20px; bottom: 18px; text-align: right; color: #eef2f6;
        text-shadow: 0 1px 3px rgba(0,0,0,.7); font-weight: 700; }
      .pf-wpn-name { font-size: 15px; letter-spacing: .5px; text-transform: uppercase; opacity: .9; }
      .pf-wpn-ammo { display: block; font-size: 26px; margin-top: 2px; }
      .pf-wpn-ammo.pf-empty { color: #ff5a5a; }`;
    document.head.appendChild(s);
  }

  dispose() { this.root?.remove(); }
}

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

import * as THREE from "three";
import { solveTwoBone, limbChain } from "./ik.js";
import { BehaviorTimeline } from "./animtimeline.js";

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
    this.limb = null;               // selected IK effector (handR/handL/footR/footL)
    this._ikTarget = null;          // world-space target the drag moves
    this.yaw = 0.6; this.pitch = 0.35; this.dist = 4.2;   // orbit state
    this.anims = anims || ["idle", "walk", "run", "jump", "rifleIdle", "pistolIdle", "firingRifle"];
    this._buildUI();
    window.addEventListener("keydown", (e) => { if (e.code === "KeyT" && !e.repeat) this.toggle(); });
    // middle-mouse = orbit, always (Erik) — input.js only tracks L/R, so track MMB here
    this._mmb = false;
    window.addEventListener("pointerdown", (e) => { if (e.button === 1) { this._mmb = true; if (this.active) e.preventDefault(); } });
    window.addEventListener("pointerup", (e) => { if (e.button === 1) this._mmb = false; });
    window.addEventListener("mousedown", (e) => { if (e.button === 1 && this.active) e.preventDefault(); });  // kill autoscroll
    if (typeof window !== "undefined") window.__pfTest = this;
  }

  /** glowing marker on the grabbed limb's target — the visual feedback for the pose editor */
  _marker() {
    if (!this._markerMesh) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffa53b, depthTest: false, transparent: true, opacity: 0.95 }));
      m.renderOrder = 999; m.visible = false;
      this.world.scene?.add(m);
      this._markerMesh = m;
    }
    return this._markerMesh;
  }

  toggle(on = !this.active) {
    this.active = on;
    this.panel.style.display = on ? "" : "none";
    this.btn.classList.toggle("pf-on", on);
    if (!on) this.anim = null;                       // hand animation back to the game
  }

  /** force a state; null returns control to the game's anim logic. "tpose" freezes the bind pose. */
  set(name) {
    const anim = window.__ch && window.__ch.animator;
    if (this.anim === "tpose" && anim) anim.current = null;   // stopped actions must restart cleanly
    this.anim = name;
    if (name === "tpose" && anim) {
      anim.mixer.stopAllAction(); anim.current = null;
      let skel = null; this.player?.object3d?.traverse((o) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; }); if (skel) skel.pose();  // BODY skeleton only — secondary (clothes) skeletons carry raw UE bind offsets that teleport the visual if posed
    }
    this.setPaused(false);                                     // switching states always unpauses
    this.panel.querySelectorAll("[data-anim]").forEach((b) => b.classList.toggle("pf-sel", b.dataset.anim === String(name)));
  }

  /** ⏸ freeze the current pose mid-frame (grip placement needs a still character) */
  setPaused(on = !this.paused) {
    this.paused = on;
    const anim = window.__ch && window.__ch.animator;
    if (anim) anim.mixer.timeScale = on ? 0 : 1;
    this.panel?.querySelector('[data-act="pause"]')?.classList.toggle("pf-sel", on);
  }

  /** select an IK effector; drag then moves that limb instead of orbiting. null = back to orbit */
  selectLimb(limb) {
    this.limb = this.limb === limb ? null : limb;      // toggle
    this._ikTarget = null;
    if (this.limb) this.setPaused(true);               // posing needs a still skeleton
    this.panel.querySelectorAll("[data-limb]").forEach((b) => b.classList.toggle("pf-sel", b.dataset.limb === this.limb));
  }

  /** 📸 capture the full skeleton pose (persists + logs JSON to bake in) */
  capturePose() {
    let skel = null; this.player?.object3d?.traverse((o) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; });
    if (!skel) return null;
    const pose = {};
    for (const b of skel.bones) pose[b.name] = b.quaternion.toArray().map((v) => +v.toFixed(4));
    const name = `pose_${Date.now() % 100000}`;
    try { localStorage.setItem(`pf.pose.${name}`, JSON.stringify(pose)); } catch {}
    console.log(`[pose captured: ${name}]`, JSON.stringify(pose));
    return name;
  }

  /** open/close the behavior timeline (Maya-Trax-style NLA editor) */
  toggleTimeline(on) {
    const anim = window.__ch && window.__ch.animator;
    if (!anim) return;
    if (!this.timeline) { this.timeline = new BehaviorTimeline(anim, this.player.object3d); window.__pfTimeline = this.timeline; this._buildTimelineUI(); }
    const open = on ?? this.bar.style.display === "none";
    this.bar.style.display = open ? "" : "none";
    if (open) {
      this.anim = "__timeline__";                 // game anim-select no-ops on this; timeline owns the mixer
      this.timeline.setBase(this.timeline.base || (this.anims.includes("rifleIdle") ? "rifleIdle" : this.anims[0]), true);
      this._tlSync();
    } else { this.timeline.close(); this.anim = null; }
    this.panel.querySelector('[data-act="timeline"]')?.classList.toggle("pf-sel", open);
  }

  /** per-frame: orbit camera around the character (runs after the rig → wins) */
  update(dt = 0.016) {
    if (!this.active || !this.player) return;
    // cursor must stay VISIBLE + clickable in test mode (Erik) — break pointer lock the
    // instant anything re-grabs it (same treatment Ember gave the vehicle rig)
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
    // behavior timeline drives the skeleton first; live IK drags layer on top
    if (this.timeline && this.anim === "__timeline__") { this.timeline.evaluate(dt); this._tlSync(false); }
    if (this.anim === "tpose")                  // hold the bind pose absolutely still, every frame,
      { let skel = null; this.player.object3d?.traverse((o) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; }); if (skel) skel.pose(); }
    const p = this.player.position;
    const ptr = this.input?.pointer;
    const marker = this._marker();
    // MMB always orbits (Erik); LMB orbits when no limb is grabbed, moves the limb when one is
    if (ptr) {
      if (this._mmb && (ptr.dx || ptr.dy)) { this.yaw -= ptr.dx * 0.008; this.pitch = Math.max(-1.2, Math.min(1.35, this.pitch + ptr.dy * 0.006)); }
      if (ptr.wheel) this.dist = Math.max(1.4, Math.min(14, this.dist + ptr.wheel * 0.5));
    }
    if (this.limb && ptr) {
      const chain = limbChain(this.player.object3d, this.limb);
      if (chain) {
        if (!this._ikTarget) this._ikTarget = chain.eff.getWorldPosition(new THREE.Vector3());
        if (!this._mmb && ptr.down && (ptr.dx || ptr.dy)) {
          const cam = this.world.camera;
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
          const k = 0.0022 * this.dist;
          this._ikTarget.addScaledVector(right, ptr.dx * k).addScaledVector(up, -ptr.dy * k);
        }
        // ★ the ball must never escape (Erik: "ends up on the ground, can never get it
        // back") — clamp to the limb's reach sphere around the shoulder/hip + above ground
        const anchor = chain.root.getWorldPosition(new THREE.Vector3());
        const bpos = chain.mid.getWorldPosition(new THREE.Vector3());
        const epos = chain.eff.getWorldPosition(new THREE.Vector3());
        const maxR = (anchor.distanceTo(bpos) + bpos.distanceTo(epos)) * 1.02 + 0.02;
        const off = this._ikTarget.clone().sub(anchor);
        if (off.length() > maxR) this._ikTarget.copy(anchor).addScaledVector(off.normalize(), maxR);
        const ground = window.__pf?.heightAt ? window.__pf.heightAt(this._ikTarget.x, this._ikTarget.z) : -Infinity;
        if (this._ikTarget.y < ground + 0.06) this._ikTarget.y = ground + 0.06;
        this.ikError = solveTwoBone({ ...chain, target: this._ikTarget });
        marker.visible = true; marker.position.copy(this._ikTarget);
      }
    } else {
      marker.visible = false;
      if (ptr && !this._mmb && ptr.down && (ptr.dx || ptr.dy)) {
        this.yaw -= ptr.dx * 0.008; this.pitch = Math.max(-1.2, Math.min(1.35, this.pitch + ptr.dy * 0.006));
      }
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
      <button data-anim="tpose">🧍 T-pose (still)</button>
      <button data-anim="blend:run+firingRifle">🔀 run + fire (blend)</button>
      <button data-anim="blend:walk+rifleIdle">🔀 walk + aim (blend)</button>
      <button data-act="pause">⏸ pause animation</button>
      <h4>Weapon</h4>
      <button data-act="weapon">cycle weapon (Q)</button>
      <h4>Pose editor (IK)</h4>
      <div class="pf-grip-row"><span>grab</span>
        <b data-limb="handL">LH</b><b data-limb="handR">RH</b><b data-limb="footL">LF</b><b data-limb="footR">RF</b></div>
      <button data-act="posecap">📸 capture pose</button>
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
      <h4>Behavior editor</h4>
      <button data-act="timeline">🎞 timeline (NLA)</button>
      <h4>Physics</h4>
      <button data-act="ragdoll">💥 ragdoll (B)</button>
      <div class="pf-test-hint">🖱️ MMB-drag = orbit · wheel = zoom<br>pose: pick a limb, then LEFT-drag —<br>the 🟠 ball is the limb's target<br>grip: 1cm / 5° per tap · T = exit</div>`;
    document.body.appendChild(this.panel);
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());   // panel clicks don't orbit
    this.panel.querySelectorAll("[data-anim]").forEach((b) =>
      b.addEventListener("click", () => this.set(b.dataset.anim === "null" ? null : b.dataset.anim)));
    this.panel.querySelector('[data-act="pause"]').addEventListener("click", () => this.setPaused());
    this.panel.querySelectorAll("[data-limb]").forEach((b) => b.addEventListener("click", () => this.selectLimb(b.dataset.limb)));
    this.panel.querySelector('[data-act="posecap"]').addEventListener("click", () => {
      const n = this.capturePose(); this._gripReadout(n ? `📸 ${n}` : "no skeleton");
    });
    this.panel.querySelector('[data-act="weapon"]').addEventListener("click", () => {
      if (this.anim === "tpose") { this.set("idle"); this.setPaused(true); }   // tpose hides gear — show the swap on a still idle
      window.__pfCombat?.cycle(1); setTimeout(() => this._gripReadout(), 400);
    });
    this.panel.querySelector('[data-act="ragdoll"]').addEventListener("click", () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyB" })));
    this.panel.querySelector('[data-act="timeline"]').addEventListener("click", () => this.toggleTimeline());
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

  _buildTimelineUI() {
    const s = document.createElement("style");
    s.textContent = `
      .pf-tl { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 46; width: min(760px, 92vw);
        background: rgba(16,20,26,.92); border: 1px solid rgba(255,255,255,.16); border-radius: 12px;
        padding: 9px 12px; font: 12px system-ui; color: #dfe6ec; }
      .pf-tl-row { display: flex; gap: 6px; align-items: center; margin: 3px 0; }
      .pf-tl select, .pf-tl input[type=text] { background: rgba(255,255,255,.1); color: #eef2f6; border: 0; border-radius: 6px; padding: 4px 6px; font: 12px system-ui; }
      .pf-tl button { border: 0; border-radius: 7px; background: rgba(255,255,255,.1); color: #eef2f6; padding: 5px 9px; cursor: pointer; font: 12px system-ui; }
      .pf-tl button:hover { background: rgba(90,170,255,.4); }
      .pf-tl input[type=range] { flex: 1; }
      .pf-tl-track { position: relative; height: 12px; margin: 1px 2px 2px; }
      .pf-tl-track i { position: absolute; top: 1px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%;
        background: #ffa53b; cursor: pointer; opacity: .65; }
      .pf-tl-track i.pf-sel-m { opacity: 1; box-shadow: 0 0 0 2px #fff; }
      .pf-tl-time { min-width: 84px; text-align: right; opacity: .8; }`;
    document.head.appendChild(s);
    this.bar = document.createElement("div");
    this.bar.className = "pf-tl"; this.bar.style.display = "none";
    this.bar.innerHTML = `
      <div class="pf-tl-row">
        <select class="pf-tl-clip">${this.anims.map((a) => `<option>${a}</option>`).join("")}</select>
        <button data-tl="play">▶ play</button>
        <button data-tl="marker">+ marker</button>
        <button data-tl="setpose">📸 set pose</button>
        <button data-tl="delmarker">✕ marker</button>
        <span class="pf-tl-time">0.00 / 0.00s</span>
      </div>
      <div class="pf-tl-row"><input type="range" class="pf-tl-scrub" min="0" max="1" step="0.005" value="0"></div>
      <div class="pf-tl-track"></div>
      <div class="pf-tl-row">
        <input type="text" class="pf-tl-name" placeholder="behavior name" style="flex:1">
        <button data-tl="save">💾 save</button>
        <select class="pf-tl-load"><option value="">load…</option></select>
      </div>`;
    document.body.appendChild(this.bar);
    this.bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    const tl = this.timeline;
    const q = (sel) => this.bar.querySelector(sel);
    q(".pf-tl-clip").addEventListener("change", (e) => { tl.setBase(e.target.value); this._tlSync(); });
    q(".pf-tl-scrub").addEventListener("input", (e) => { tl.pause(); tl.scrub(+e.target.value * tl.duration()); this._tlSync(false); });
    q('[data-tl="play"]').addEventListener("click", () => { tl.playing ? tl.pause() : tl.play(); });
    q('[data-tl="marker"]').addEventListener("click", () => { tl.addMarker(); this._tlSync(); });
    q('[data-tl="setpose"]').addEventListener("click", () => { q('[data-tl="setpose"]').textContent = tl.capturePoseToMarker() ? "📸 saved!" : "select a marker"; setTimeout(() => q('[data-tl="setpose"]').textContent = "📸 set pose", 900); });
    q('[data-tl="delmarker"]').addEventListener("click", () => { tl.deleteMarker(); this._tlSync(); });
    q('[data-tl="save"]').addEventListener("click", () => { const n = q(".pf-tl-name").value.trim() || "behavior1"; tl.save(n); this._tlRefreshLoad(); });
    q(".pf-tl-load").addEventListener("change", (e) => { if (e.target.value) { tl.load(e.target.value); q(".pf-tl-clip").value = tl.base; q(".pf-tl-name").value = e.target.value; this._tlSync(); } });
    this._tlRefreshLoad();
  }

  _tlRefreshLoad() {
    const sel = this.bar.querySelector(".pf-tl-load");
    sel.innerHTML = `<option value="">load…</option>` + BehaviorTimeline.list().map((n) => `<option>${n}</option>`).join("");
  }

  /** refresh the bar from timeline state; full=true also rebuilds marker dots */
  _tlSync(full = true) {
    const tl = this.timeline; if (!tl || !this.bar) return;
    const dur = tl.duration() || 1;
    this.bar.querySelector(".pf-tl-time").textContent = `${tl.time.toFixed(2)} / ${dur.toFixed(2)}s`;
    if (!this._scrubbing) this.bar.querySelector(".pf-tl-scrub").value = String(tl.time / dur);
    this.bar.querySelector('[data-tl="play"]').textContent = tl.playing ? "⏸ pause" : "▶ play";
    if (!full) return;
    const track = this.bar.querySelector(".pf-tl-track");
    track.innerHTML = tl.markers.map((m, i) => `<i style="left:${(m.t / dur * 100).toFixed(1)}%" data-mi="${i}" class="${i === tl.selected ? "pf-sel-m" : ""}"></i>`).join("");
    track.querySelectorAll("i").forEach((dot) => dot.addEventListener("click", () => { tl.selected = +dot.dataset.mi; tl.pause(); tl.scrub(tl.markers[tl.selected].t); this._tlSync(); }));
  }
}

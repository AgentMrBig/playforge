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
import { solveTwoBone, limbChain, rotateWorld } from "./ik.js";
import { BehaviorTimeline } from "./animtimeline.js";
import { ControlRig } from "./controlrig.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

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
    this.fkLimbs = {};              // limb → true = FK mode (drag rotates joints)
    this.limbLocks = {};            // limb → world Vector3 (pinned while posing others)
    this.poleOverrides = {};        // limb → world Vector3 (knee/elbow aim controls)
    this._shift = false;
    this._ikTarget = null;          // world-space target the drag moves
    this.yaw = 0.6; this.pitch = 0.35; this.dist = 4.2;   // orbit state
    this.pan = new THREE.Vector3();                        // LMB drag = pan offset (Erik)
    this.anims = anims || ["idle", "walk", "run", "jump", "rifleIdle", "pistolIdle", "firingRifle"];
    this._buildUI();
    window.addEventListener("keydown", (e) => { if (e.code === "KeyT" && !e.repeat) this.toggle(); if (e.key === "Shift") this._shift = true; });
    // Maya tool shortcuts (Erik): W=move E=rotate R=scale — CAPTURE phase so the game's
    // E (enter car) / R (new island) / W (walk) never fire while the workshop is open
    window.addEventListener("keydown", (e) => {
      if (!this.active || e.repeat) return;
      const t = e.target && e.target.tagName;
      if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
      if (e.code === "KeyZ" && (e.ctrlKey || e.metaKey) && e.shiftKey) { this.redo(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.code === "KeyZ" && (e.ctrlKey || e.metaKey)) { this.undo(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.code === "KeyY" && (e.ctrlKey || e.metaKey)) { this.redo(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.code === "KeyZ" && e.shiftKey) { this.redo(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.code === "KeyZ") { this.undo(); e.preventDefault(); e.stopImmediatePropagation(); return; }   // Maya plain-Z undo
      const mode = { KeyW: "translate", KeyE: "rotate", KeyR: "scale" }[e.code];
      if (!mode) return;
      this.setGizmoMode(mode);
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
    window.addEventListener("keyup", (e) => { if (e.key === "Shift") this._shift = false; });
    // middle-mouse = orbit, always (Erik) — input.js only tracks L/R, so track MMB here
    this._mmb = false; this._uiDrag = false;
    window.addEventListener("pointerdown", (e) => {
      if (e.button === 1) { this._mmb = true; if (this.active) e.preventDefault(); }
      // drags that START on UI (timeline scrubber, panels, buttons) must never orbit or
      // move limbs (Erik: "can't control the time slider — my mouse still rotates the camera")
      this._uiDrag = !!(e.target && e.target.closest && e.target.closest(".pf-tl, .pf-test-panel, .pf-test-btn, .pf-touch, button, input, select"));
      // limb drag with the rig hidden (panel-selected limb) still needs an undo snapshot
      if (this.active && e.button === 0 && !this._uiDrag && this.limb && !(this.rig && this.rig.visible)) this.pushUndo();
    }, true);
    window.addEventListener("pointerup", (e) => { if (e.button === 1) this._mmb = false; this._uiDrag = false; });
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
    if (on) this.pan.set(0, 0, 0);                   // start each session centered
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
    this._modeSync();
  }

  /** refresh the FK/lock buttons for the selected limb */
  _modeSync() {
    const fkB = this.panel.querySelector('[data-act="fk"]'), lkB = this.panel.querySelector('[data-act="lock"]');
    if (!fkB) return;
    const l = this.limb;
    fkB.textContent = l && this.fkLimbs[l] ? "FK" : "IK";
    fkB.classList.toggle("pf-sel", !!(l && this.fkLimbs[l]));
    lkB.textContent = l && this.limbLocks[l] ? "🔒 locked" : "🔓 lock";
    lkB.classList.toggle("pf-sel", !!(l && this.limbLocks[l]));
  }

  /** ↩︎ undo/redo (Erik: "moved his leg, it didn't move the way I wanted") — snapshot
   * of every bone (pos/rot/scale) + locks + aim overrides, pushed at gesture START */
  _snapshotPose() {
    const bones = []; this.player.object3d.traverse((o) => { if (o.isBone) bones.push(o); });
    return {
      b: bones.map((o) => [o.position.toArray(), o.quaternion.toArray(), o.scale.toArray()]),
      locks: Object.fromEntries(Object.entries(this.limbLocks).map(([k, v]) => [k, v.clone()])),
      poles: Object.fromEntries(Object.entries(this.poleOverrides).map(([k, v]) => [k, v.clone()])),
      ikTarget: this._ikTarget ? this._ikTarget.clone() : null,
    };
  }
  _applyPose(s) {
    const bones = []; this.player.object3d.traverse((o) => { if (o.isBone) bones.push(o); });
    for (let i = 0; i < bones.length && i < s.b.length; i++) {
      bones[i].position.fromArray(s.b[i][0]); bones[i].quaternion.fromArray(s.b[i][1]); bones[i].scale.fromArray(s.b[i][2]);
    }
    this.limbLocks = Object.fromEntries(Object.entries(s.locks).map(([k, v]) => [k, v.clone()]));
    this.poleOverrides = Object.fromEntries(Object.entries(s.poles).map(([k, v]) => [k, v.clone()]));
    this._ikTarget = s.ikTarget ? s.ikTarget.clone() : null;
    this._modeSync();
  }
  pushUndo() {
    if (this._lastPush && performance.now() - this._lastPush < 150) return;   // one push per gesture
    this._lastPush = performance.now();
    (this._undoStack = this._undoStack || []).push(this._snapshotPose());
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._redoStack = [];
  }
  undo() {
    if (!this._undoStack || !this._undoStack.length) return;
    (this._redoStack = this._redoStack || []).push(this._snapshotPose());
    this._lastPush = 0;
    this._applyPose(this._undoStack.pop());
  }
  redo() {
    if (!this._redoStack || !this._redoStack.length) return;
    (this._undoStack = this._undoStack || []).push(this._snapshotPose());
    this._lastPush = 0;
    this._applyPose(this._redoStack.pop());
  }

  /** a limb's pole position: the aim-control override if the animator placed one,
   * else the natural default (elbows back+down, knees forward+up) */
  polePos(limb) {
    if (this.poleOverrides[limb]) return this.poleOverrides[limb];
    const chain = limbChain(this.player.object3d, limb);
    if (!chain) return new THREE.Vector3();
    const anchor = chain.root.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.object3d.quaternion);
    const isLeg = limb.startsWith("foot");
    return anchor.addScaledVector(fwd, isLeg ? 0.8 : -0.6).add(new THREE.Vector3(0, isLeg ? 0.4 : -0.5, 0));
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

  /** 🎛 control rig: clickable handles on the body (hands/feet = IK, hips = translate,
   * chest/head = rotate). Click a handle to grab it; click empty space to orbit/release. */
  toggleRig(on) {
    if (!this.rig) {
      this.rig = new ControlRig({ scene: this.world.scene, playerObj: this.player.object3d, player: this.player });
      window.__pfRig = this.rig;
      window.addEventListener("pointerdown", (e) => {
        if (!this.rig.visible || this._uiDrag || e.button !== 0) return;
        if (this._tc && this._tc.axis) return;                                    // click is ON the gizmo — let it drive
        const nx = (e.clientX / window.innerWidth) * 2 - 1, ny = -(e.clientY / window.innerHeight) * 2 + 1;
        const id = this.rig.pick(nx, ny, this.world.camera);
        if (id !== null || this.limb) this.pushUndo();   // gesture may edit the pose — snapshot first
        this.rigControl = null;
        if (id === null) { if (this.limb) this.selectLimb(this.limb); this.attachGizmo(null); return; }   // empty space → release
        const h = this.rig._handles[id];
        if (h.limb) { if (this.limb !== h.limb) this.selectLimb(h.limb); }        // hands/feet → the IK grab
        else if (h.aimFor) {
          // knee/elbow aim: pin the limb's effector where it is, then the aim swivels
          // the joint around it (pole vector) — Maya behavior
          if (this.limb) this.selectLimb(this.limb);
          this.rigControl = id; this.setPaused(true);
          if (!this.limbLocks[h.aimFor]) {
            const c = limbChain(this.player.object3d, h.aimFor);
            if (c) { this.limbLocks[h.aimFor] = c.eff.getWorldPosition(new THREE.Vector3()); this._modeSync(); }
          }
          this.setGizmoMode("translate");                                         // aims are position-only
        }
        else { if (this.limb) this.selectLimb(this.limb); this.rigControl = id; this.setPaused(true); }
        this.attachGizmo(id);                                                     // manipulators on the selected control
      }, true);
    }
    const vis = on ?? !this.rig.visible;
    this.rig.setVisible(vis);
    if (!vis) this.rigControl = null;
    if (!vis && this._tc) this.attachGizmo(null);
    this.panel.querySelector('[data-act="rig"]')?.classList.toggle("pf-sel", vis);
  }

  /** the manipulator gizmo (Erik: "all the standard manipulators, x,y,z movement…
   * i also need rotation") — three's TransformControls attached to a proxy at the
   * selected control; translate drives IK/hips, rotate turns the bone itself. */
  _gizmo() {
    if (this._tc) return this._tc;
    const dom = window.__pf?.engine?.renderer?.domElement || document.body;
    const tc = new TransformControls(this.world.camera, dom);
    tc.setSize(0.85);
    this.world.scene.add(tc.getHelper ? tc.getHelper() : tc);
    this._tcProxy = new THREE.Object3D(); this.world.scene.add(this._tcProxy);
    this._tcPrevQ = new THREE.Quaternion();
    tc.addEventListener("dragging-changed", (e) => {
      this._gizmoDragging = e.value;
      if (e.value) { this.pushUndo(); this._tcPrevQ.copy(this._tcProxy.quaternion); }
    });
    tc.addEventListener("objectChange", () => this._onGizmoChange());
    this._tc = tc;
    return tc;
  }

  attachGizmo(id) {
    const tc = this._gizmo();
    this._gizmoTarget = id || null;
    if (!id) { tc.detach(); return; }
    const h = this.rig._handles[id];
    this._tcProxy.position.copy(h.mesh.position);
    this._tcProxy.quaternion.identity();
    this._tcProxy.scale.set(1, 1, 1);
    this._tcPrevQ.identity();
    this._tcPrevS = this._tcPrevS || new THREE.Vector3();
    this._tcPrevS.set(1, 1, 1);
    tc.attach(this._tcProxy);
  }

  setGizmoMode(m) {
    this._gizmo().setMode(m);
    this.panel.querySelectorAll("[data-gmode]").forEach((b) => b.classList.toggle("pf-sel", b.dataset.gmode === m));
  }

  _onGizmoChange() {
    const id = this._gizmoTarget; if (!id || !this.rig) return;
    const h = this.rig._handles[id];
    if (this._tc.mode === "translate") {
      if (h.aimFor) {
        this.poleOverrides[h.aimFor] = (this.poleOverrides[h.aimFor] || new THREE.Vector3()).copy(this._tcProxy.position);
      } else if (h.limb) {
        // arrows drive the IK target — the per-frame solve moves the limb onto it
        this._ikTarget = (this._ikTarget || new THREE.Vector3()).copy(this._tcProxy.position);
      } else if (id === "hips") {
        const bone = h.bone, parent = bone.parent;
        if (bone) bone.position.copy(parent.worldToLocal(this._tcProxy.position.clone()));
      }
    } else if (this._tc.mode === "scale") {
      // scale handles multiply the bone's scale by the drag ratio (Maya R tool)
      const s = this._tcProxy.scale, p = this._tcPrevS;
      const bone = h.limb ? (limbChain(this.player.object3d, h.limb) || {}).eff : h.bone;
      if (bone && p.x && p.y && p.z) bone.scale.set(bone.scale.x * s.x / p.x, bone.scale.y * s.y / p.y, bone.scale.z * s.z / p.z);
      p.copy(s);
    } else {
      // rotation rings turn the CONTROL'S bone (wrist/ankle/chest/head) by the delta
      const dq = this._tcProxy.quaternion.clone().multiply(this._tcPrevQ.clone().invert());
      this._tcPrevQ.copy(this._tcProxy.quaternion);
      const bone = h.limb ? (limbChain(this.player.object3d, h.limb) || {}).eff : h.bone;
      if (bone) rotateWorld(bone, dq);
    }
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
      if (this._mmb && !this._uiDrag && (ptr.dx || ptr.dy)) { this.yaw -= ptr.dx * 0.008; this.pitch = Math.max(-1.2, Math.min(1.35, this.pitch + ptr.dy * 0.006)); }
      if (ptr.rightDown && !this._uiDrag && !this._gizmoDragging && (ptr.dx || ptr.dy)) {
        // RMB drag = PAN, STRICTLY screen axes (Erik: 'no forward/back at all — that's zoom').
        // X = the camera's right flattened to horizontal, Y = pure world up — so a pitched
        // camera can never leak drag into the view axis (that leak read as zooming).
        const cam = this.world.camera;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        right.y = 0; right.normalize();
        const k = 0.0016 * this.dist;
        this.pan.addScaledVector(right, ptr.dx * k);   // L/R inverted per Erik 15:25
        this.pan.y += ptr.dy * k;
      }
      if (ptr.wheel) this.dist = Math.max(1.4, Math.min(14, this.dist + ptr.wheel * 0.5));
    }
    // control rig: keep handles glued to bones; route drags on hips/chest/head
    if (this.rig && this.rig.visible) {
      this.rig.update(limbChain, (l) => this.polePos(l));
      this.rig.highlight(this.rigControl || this.limb || null);   // grabbed control glows white
      if (this._gizmoTarget && !this._gizmoDragging && this._tcProxy)
        this._tcProxy.position.copy(this.rig._handles[this._gizmoTarget].mesh.position);   // follow the anim when idle
      if (this.rigControl && ptr && !this._mmb && !this._uiDrag && !this._gizmoDragging && ptr.down && (ptr.dx || ptr.dy)) {
        const k = 0.0022 * this.dist;
        const hc = this.rig._handles[this.rigControl];
        if (hc && hc.aimFor) {
          // freeform-drag an aim control in the camera plane (gizmo covers precise axes)
          const cam = this.world.camera;
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
          const ov = this.poleOverrides[hc.aimFor] || (this.poleOverrides[hc.aimFor] = this.polePos(hc.aimFor).clone());
          ov.addScaledVector(right, -ptr.dx * k).addScaledVector(up, -ptr.dy * k);
        } else {
          this.rig.drag(this.rigControl, -ptr.dx * k, -ptr.dy * k, this.world.camera);
        }
      }
    }
    if (this.limb && ptr && this.fkLimbs[this.limb]) {
      // FK mode: drag ROTATES the joints directly — shoulder/hip normally, Shift = elbow/knee
      const chain = limbChain(this.player.object3d, this.limb);
      if (chain && !this._mmb && !this._uiDrag && !this._gizmoDragging && ptr.down && (ptr.dx || ptr.dy)) {
        const cam = this.world.camera;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ptr.dx * 0.006)
          .multiply(new THREE.Quaternion().setFromAxisAngle(right, -ptr.dy * 0.006));
        rotateWorld(this._shift ? chain.mid : chain.root, q);
      }
      marker.visible = false;
    } else if (this.limb && ptr) {
      const chain = limbChain(this.player.object3d, this.limb);
      if (chain) {
        if (!this._ikTarget) this._ikTarget = chain.eff.getWorldPosition(new THREE.Vector3());
        if (!this._mmb && !this._uiDrag && !this._gizmoDragging && ptr.down && (ptr.dx || ptr.dy)) {
          const cam = this.world.camera;
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
          const k = 0.0022 * this.dist;
          this._ikTarget.addScaledVector(right, -ptr.dx * k).addScaledVector(up, -ptr.dy * k);  // dx flipped: Erik reports L/R reversed in practice
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
        this.ikError = solveTwoBone({ ...chain, target: this._ikTarget, pole: this.polePos(this.limb) });
        marker.visible = true; marker.position.copy(this._ikTarget);
      }
    } else {
      marker.visible = false;
      if (ptr && !this._mmb && !this._uiDrag && !this._gizmoDragging && !this.rigControl && ptr.down && (ptr.dx || ptr.dy)) {
        // LMB untouched = orbit (Erik's corrected spec: RMB pans, MMB orbits, LMB stays)
        this.yaw -= ptr.dx * 0.008; this.pitch = Math.max(-1.2, Math.min(1.35, this.pitch + ptr.dy * 0.006));
      }
    }
    // 🔒 locked limbs: re-solve onto their pinned targets every frame, so posing hips/
    // chest/other limbs leaves them exactly where they were locked (plant feet → lean!)
    for (const l in this.limbLocks) {
      if (l === this.limb) continue;                    // the actively-dragged limb wins
      const c = limbChain(this.player.object3d, l);
      if (!c) continue;
      solveTwoBone({ ...c, target: this.limbLocks[l], pole: this.polePos(l), iterations: 4 });
    }
    // 👣 always-on foot-ground collision while posing (Erik 19:34: "I don't want to have
    // to lock my ik to get foot-to-ground — lower the character and his feet have to
    // detect collisions"). Only clamps BELOW ground: lifting raises the feet freely.
    const hAt = window.__pf?.heightAt;
    if (hAt && (this.paused || this.limb || this.rigControl || this._gizmoTarget)) {
      for (const fl of ["footL", "footR"]) {
        if (fl === this.limb || this.limbLocks[fl]) continue;   // grabbed/locked feet already handled
        const c = limbChain(this.player.object3d, fl);
        if (!c) continue;
        const fp = c.eff.getWorldPosition(new THREE.Vector3());
        const g = hAt(fp.x, fp.z) + 0.02;
        if (fp.y < g - 0.01) {
          const target = fp.clone(); target.y = g;
          solveTwoBone({ ...c, target, pole: this.polePos(fl), iterations: 2 });
        }
      }
    }

    const cam = this.world.camera;
    const cy = Math.cos(this.pitch), h = 1.05;
    const fx = p.x + this.pan.x, fy = p.y + h + this.pan.y, fz = p.z + this.pan.z;
    cam.position.set(
      fx + Math.sin(this.yaw) * cy * this.dist,
      fy + Math.sin(this.pitch) * this.dist,
      fz + Math.cos(this.yaw) * cy * this.dist);
    cam.lookAt(fx, fy, fz);
  }

  _buildUI() {
    if (!document.getElementById("pf-test-style")) {
      const s = document.createElement("style");
      s.id = "pf-test-style";
      s.textContent = `
        .pf-test-btn { position: fixed; left: 16px; top: 64px; z-index: 45; padding: 10px 16px; border-radius: 10px;
          border: 0; background: #2c6e8fdd; color: #fff; font: 700 14px system-ui; cursor: pointer; }
        .pf-test-btn.pf-on { background: #1d9b6cdd; }
        .pf-test-panel { position: fixed; right: 16px; top: 205px; z-index: 45; width: 184px;   /* below the minimap */
          background: rgba(16,20,26,.88); border: 1px solid rgba(255,255,255,.16); border-radius: 12px;
          padding: 8px; font: 12px system-ui; color: #dfe6ec; box-sizing: border-box;
          max-height: calc(100vh - 221px); overflow-y: auto; }   /* never run off screen; all groups collapse by default so this only scrolls if you open a big one (Erik dislikes scrollbars) */
        .pf-test-panel::-webkit-scrollbar { width: 7px; }
        .pf-test-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 4px; }
        .pf-test-panel h4 { margin: 4px 0 6px; font-size: 11px; letter-spacing: .8px; opacity: .65; text-transform: uppercase; }
        /* collapsible groups by purpose (Erik: "too many things going on… collapsible items grouped by purpose") */
        .pf-grp { margin: 3px 0; }
        .pf-grp-h { display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;
          padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,.07); font: 700 11px system-ui; letter-spacing: .5px; color: #eef2f6; }
        .pf-grp-h:hover { background: rgba(255,255,255,.14); }
        .pf-grp-h::after { content: "▾"; opacity: .55; font-size: 10px; }
        .pf-grp.pf-collapsed .pf-grp-h::after { content: "▸"; }
        .pf-grp.pf-collapsed .pf-grp-b { display: none; }
        .pf-grp-b { padding: 4px 1px 2px; }
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
    // grouped + collapsible (Erik). Each .pf-grp = a clickable header + a body;
    // Animation is open by default, the rest collapsed, so the panel opens as 5
    // tidy rows instead of a wall. Regroups DOM only — every data-act/anim/limb
    // is untouched, so all the existing handlers below still bind (General's trap #3).
    this.panel.innerHTML = `
      <div class="pf-grp pf-collapsed" data-grp="anim">
        <div class="pf-grp-h">🎬 Animation</div>
        <div class="pf-grp-b">
          <button data-anim="null" class="pf-sel">game logic (live)</button>
          ${animBtns}
          <button data-anim="tpose">🧍 T-pose (still)</button>
          <button data-anim="blend:run+firingRifle">🔀 run + fire (blend)</button>
          <button data-anim="blend:walk+rifleIdle">🔀 walk + aim (blend)</button>
          <button data-act="pause">⏸ pause animation</button>
        </div>
      </div>
      <div class="pf-grp pf-collapsed" data-grp="pose">
        <div class="pf-grp-h">🦾 Posing</div>
        <div class="pf-grp-b">
          <button data-act="rig">🎛 control rig</button>
          <div class="pf-grip-row"><span>grab</span>
            <b data-limb="handL">LH</b><b data-limb="handR">RH</b><b data-limb="footL">LF</b><b data-limb="footR">RF</b></div>
          <div class="pf-grip-row"><span>gizmo</span>
        <b data-gmode="translate" class="pf-sel" title="W">↔ move</b><b data-gmode="rotate" title="E">⟳ rotate</b><b data-gmode="scale" title="R">⤢ scale</b>
        <b data-act="undo" title="Z">↩ undo</b><b data-act="redo" title="Shift+Z">↪ redo</b></div>
      <div class="pf-grip-row"><span>mode</span>
            <b data-act="fk" title="drag rotates the joints instead (Shift = elbow/knee)">IK</b>
            <b data-act="lock" title="pin this limb in place while you pose everything else">🔓 lock</b></div>
          <button data-act="posecap">📸 capture pose</button>
        </div>
      </div>
      <div class="pf-grp pf-collapsed" data-grp="weapon">
        <div class="pf-grp-h">🔫 Weapon</div>
        <div class="pf-grp-b">
          <button data-act="weapon">cycle weapon (Q)</button>
          <div class="pf-grip">
            <div class="pf-grip-row"><span>pos</span>
              <b data-n="px-">−x</b><b data-n="px+">+x</b><b data-n="py-">−y</b><b data-n="py+">+y</b><b data-n="pz-">−z</b><b data-n="pz+">+z</b></div>
            <div class="pf-grip-row"><span>rot</span>
              <b data-n="rx-">−x</b><b data-n="rx+">+x</b><b data-n="ry-">−y</b><b data-n="ry+">+y</b><b data-n="rz-">−z</b><b data-n="rz+">+z</b></div>
            <div class="pf-grip-vals"></div>
            <button data-act="capture">📸 capture grip</button>
            <button data-act="gripreset">↩ reset grip</button>
          </div>
        </div>
      </div>
      <div class="pf-grp pf-collapsed" data-grp="timeline">
        <div class="pf-grp-h">🎞 Timeline</div>
        <div class="pf-grp-b"><button data-act="timeline">🎞 timeline (NLA)</button></div>
      </div>
      <div class="pf-grp pf-collapsed" data-grp="physics">
        <div class="pf-grp-h">💥 Physics</div>
        <div class="pf-grp-b"><button data-act="ragdoll">💥 ragdoll (B)</button></div>
      </div>
      <div class="pf-test-hint">🖱️ LMB = orbit · RMB = pan · MMB = orbit<br>wheel = zoom<br>pose: pick a limb, then LEFT-drag —<br>the 🟠 ball is the limb's target<br>grip: 1cm / 5° per tap · T = exit</div>`;
    document.body.appendChild(this.panel);
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());   // panel clicks don't orbit
    // group headers toggle their own section open/closed
    this.panel.querySelectorAll(".pf-grp-h").forEach((h) =>
      h.addEventListener("click", () => h.parentElement.classList.toggle("pf-collapsed")));
    this.panel.querySelectorAll("[data-anim]").forEach((b) =>
      b.addEventListener("click", () => this.set(b.dataset.anim === "null" ? null : b.dataset.anim)));
    this.panel.querySelector('[data-act="pause"]').addEventListener("click", () => this.setPaused());
    this.panel.querySelectorAll("[data-limb]").forEach((b) => b.addEventListener("click", () => this.selectLimb(b.dataset.limb)));
    this.panel.querySelector('[data-act="fk"]').addEventListener("click", () => {
      if (this.limb) { this.fkLimbs[this.limb] = !this.fkLimbs[this.limb]; this._ikTarget = null; this._modeSync(); }
    });
    this.panel.querySelectorAll('[data-gmode]').forEach((b) => b.addEventListener('click', () => this.setGizmoMode(b.dataset.gmode)));
    this.panel.querySelector('[data-act="undo"]').addEventListener('click', () => this.undo());
    this.panel.querySelector('[data-act="redo"]').addEventListener('click', () => this.redo());
    this.panel.querySelector('[data-act="lock"]').addEventListener("click", () => {
      if (!this.limb) return;
      if (this.limbLocks[this.limb]) delete this.limbLocks[this.limb];
      else { const c = limbChain(this.player.object3d, this.limb); if (c) this.limbLocks[this.limb] = c.eff.getWorldPosition(new THREE.Vector3()); }
      this._modeSync();
    });
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
    this.panel.querySelector('[data-act="rig"]').addEventListener("click", () => this.toggleRig());
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
      .pf-tl select, .pf-tl input[type=text] { background: #232a33; color: #eef2f6; border: 0; border-radius: 6px; padding: 4px 6px; font: 12px system-ui; }
      .pf-tl select option { background: #232a33; color: #eef2f6; }
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

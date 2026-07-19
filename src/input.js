/**
 * Input — unified keyboard / mouse / touch with named actions.
 *
 *   input.bind("jump", ["Space", "touch:right"]);
 *   if (input.pressed("jump")) ...     // this frame only
 *   if (input.down("KeyW")) ...        // raw key held
 *   input.axis("KeyA", "KeyD")         // -1..1
 *   input.pointer                       // { x, y, dx, dy, down, rightDown }
 *   input.stick("left")                 // virtual touch stick { x, y } (-1..1)
 *
 * Touch: left half of the screen is the "left" stick, right half is "right"
 * (the twin-stick scheme our games proved out).
 */
export class Input {
  constructor(target) {
    this.target = target;
    this._keys = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this._bindings = new Map();
    this.pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false, rightDown: false, wheel: 0 };
    this._sticks = { left: { id: null, ox: 0, oy: 0, x: 0, y: 0 }, right: { id: null, ox: 0, oy: 0, x: 0, y: 0 } };

    this._h = [];
    const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); this._h.push([el, ev, fn]); };

    on(window, "keydown", (e) => {
      if (e.repeat) return;
      this._keys.add(e.code);
      this._pressed.add(e.code);
    });
    on(window, "keyup", (e) => { this._keys.delete(e.code); this._released.add(e.code); });
    on(window, "blur", () => this._keys.clear());

    on(target, "pointerdown", (e) => {
      if (e.pointerType === "touch") return this._touchStart(e);
      if (e.button === 0) { this.pointer.down = true; this._pressed.add("Mouse0"); }
      if (e.button === 2) { this.pointer.rightDown = true; this._pressed.add("Mouse2"); }
    });
    on(window, "pointerup", (e) => {
      if (e.pointerType === "touch") return this._touchEnd(e);
      if (e.button === 0) { this.pointer.down = false; this._released.add("Mouse0"); }
      if (e.button === 2) { this.pointer.rightDown = false; this._released.add("Mouse2"); }
    });
    on(window, "pointermove", (e) => {
      if (e.pointerType === "touch") return this._touchMove(e);
      this.pointer.dx += e.movementX;
      this.pointer.dy += e.movementY;
      const r = target.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left;
      this.pointer.y = e.clientY - r.top;
      // ★ reconcile button STATE from the bitmask: pressing a SECOND mouse button while
      // one is held fires NO pointerdown (only pointermove with e.buttons changed), so
      // LMB-shoot never registered while RMB-aiming. Synthesize the missing edges here.
      const L = !!(e.buttons & 1), R = !!(e.buttons & 2);
      if (L !== this.pointer.down) { this.pointer.down = L; this[L ? "_pressed" : "_released"].add("Mouse0"); }
      if (R !== this.pointer.rightDown) { this.pointer.rightDown = R; this[R ? "_pressed" : "_released"].add("Mouse2"); }
    });
    on(target, "wheel", (e) => { this.pointer.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    on(target, "contextmenu", (e) => e.preventDefault());
  }

  /** GTA-style mouse look: click canvas → pointer locks; Esc releases (browser default) */
  enablePointerLock() {
    const req = () => {
      // the character workshop needs a FREE cursor — a lock request mid-gizmo-drag
      // throws InvalidStateError inside TransformControls' setPointerCapture and
      // freezes clientX/Y, killing the drag (Erik: "it knows how it SHOULD move")
      if (window.__pfTest && window.__pfTest.active) return;
      if (document.pointerLockElement !== this.target) this.target.requestPointerLock();
    };
    this.target.addEventListener("pointerdown", req);
    this._h.push([this.target, "pointerdown", req]);
  }
  get pointerLocked() { return document.pointerLockElement === this.target; }

  bind(action, codes) { this._bindings.set(action, codes); }

  down(code) { return this._keys.has(code); }
  pressed(codeOrAction) {
    const codes = this._bindings.get(codeOrAction) ?? [codeOrAction];
    return codes.some((c) => this._pressed.has(c));
  }
  released(codeOrAction) {
    const codes = this._bindings.get(codeOrAction) ?? [codeOrAction];
    return codes.some((c) => this._released.has(c));
  }
  /** action held: any bound key currently down */
  held(action) {
    const codes = this._bindings.get(action) ?? [action];
    return codes.some((c) => this._keys.has(c));
  }
  axis(neg, pos) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); }
  stick(side) { const s = this._sticks[side]; return { x: s.x, y: s.y }; }

  _touchStart(e) {
    const r = this.target.getBoundingClientRect();
    const side = e.clientX - r.left < r.width / 2 ? "left" : "right";
    const s = this._sticks[side];
    if (s.id !== null) return;
    s.id = e.pointerId; s.ox = e.clientX; s.oy = e.clientY; s.x = s.y = 0;
  }
  _touchMove(e) {
    for (const s of Object.values(this._sticks)) {
      if (s.id !== e.pointerId) continue;
      const R = 60;
      s.x = Math.max(-1, Math.min(1, (e.clientX - s.ox) / R));
      s.y = Math.max(-1, Math.min(1, (e.clientY - s.oy) / R));
    }
  }
  _touchEnd(e) {
    for (const s of Object.values(this._sticks))
      if (s.id === e.pointerId) { s.id = null; s.x = s.y = 0; }
  }

  /** engine calls this after each frame: clears edge states + deltas */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this.pointer.dx = this.pointer.dy = 0;
    this.pointer.wheel = 0;
  }

  dispose() { for (const [el, ev, fn] of this._h) el.removeEventListener(ev, fn); }
}

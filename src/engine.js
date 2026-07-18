import * as THREE from "three";
import { Input } from "./input.js";
import { Tweens } from "./tween.js";

/**
 * Engine — owns the renderer, the loop, and the active scene.
 *
 * Loop contract:
 *   fixedUpdate(dt)  runs at a fixed 60hz regardless of framerate (physics/gameplay)
 *   update(dt)       runs once per rendered frame (animation, cameras, UI)
 * Both are driven for every Entity in the active World, then the frame renders.
 *
 *   const engine = new Engine(canvas);
 *   engine.world = myWorld;
 *   engine.start();
 */
export class Engine {
  static FIXED_DT = 1 / 60;
  static MAX_CATCHUP = 5; // fixed steps per frame cap (spiral-of-death guard)

  constructor(canvas, { clearColor = 0x10131a, shadows = true } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(clearColor);
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.input = new Input(canvas);
    this.world = null;          // active World (scene + entities)
    this.time = 0;              // seconds since start (render clock)
    this.running = false;

    this._accum = 0;
    this._last = 0;
    this._frame = this._frame.bind(this);
    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._onResize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    requestAnimationFrame(this._frame);
  }
  stop() { this.running = false; }

  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this._frame);
    let dt = (now - this._last) / 1000;
    this._last = now;
    dt = Math.min(dt, 0.25); // tab-switch clamp
    this.time += dt;

    const world = this.world;
    if (world) {
      this._accum += dt;
      let steps = 0;
      while (this._accum >= Engine.FIXED_DT && steps < Engine.MAX_CATCHUP) {
        world._fixedUpdate(Engine.FIXED_DT, this);
        this._accum -= Engine.FIXED_DT;
        steps++;
      }
      if (steps === Engine.MAX_CATCHUP) this._accum = 0;
      Tweens.update(dt);
      world._update(dt, this);
      if (world.camera) this.renderer.render(world.scene, world.camera);
    }
    this.input.endFrame();
  }

  _onResize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    if (this.world?.camera) {
      this.world.camera.aspect = this.aspect;
      this.world.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener("resize", this._onResize);
    this.input.dispose();
    this.renderer.dispose();
  }
}

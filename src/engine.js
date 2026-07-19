import * as THREE from "three";
import { Input } from "./input.js";
import { Tweens } from "./tween.js";
// postprocessing (Ember, lighting lane): ambient occlusion pass
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

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
    // filmic color pipeline (Ember, lighting lane): ACES tames the flat washed-
    // out look — highlights roll off instead of clipping, colors get depth
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.input = new Input(canvas);
    this.world = null;          // active World (scene + entities)
    this.time = 0;              // seconds since start (render clock)
    this.running = false;
    // ambient occlusion (Ember, lighting lane): GTAO post-pass, on by default,
    // ?ao=0 kills it (falls back to the plain render path). Built lazily on the
    // first frame that has a camera. Seam: window.__pfAO = the GTAOPass.
    this.aoEnabled = typeof location === "undefined" || new URLSearchParams(location.search).get("ao") !== "0";
    this._composer = null;

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
      if (world.camera) {
        if (this.aoEnabled && !this._composer) this._buildComposer(world);
        if (this._composer) {
          // worlds/cameras can swap — keep the passes pointed at the live ones
          if (this._rp.camera !== world.camera || this._rp.scene !== world.scene) {
            this._rp.camera = world.camera; this._rp.scene = world.scene;
            this._gtao.camera = world.camera; this._gtao.scene = world.scene;
          }
          this._composer.render();
        } else this.renderer.render(world.scene, world.camera);
      }
    }
    this.input.endFrame();
  }

  _buildComposer(world) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this._composer = new EffectComposer(this.renderer);
    this._rp = new RenderPass(world.scene, world.camera);
    this._gtao = new GTAOPass(world.scene, world.camera, w, h);
    this._gtao.output = GTAOPass.OUTPUT.Default;
    // OutputPass applies the renderer's tone mapping (ACES) + sRGB at the end,
    // so the day/night exposure ramp keeps working through the composer
    this._composer.addPass(this._rp);
    this._composer.addPass(this._gtao);
    this._composer.addPass(new OutputPass());
    if (typeof window !== "undefined") window.__pfAO = this._gtao;
  }

  _onResize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this._composer?.setSize(w, h);
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

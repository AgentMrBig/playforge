import * as THREE from "three";

/**
 * World — a three.js scene plus a flat list of Entities.
 * Entity — a named THREE.Group carrying Components. Add three objects to
 * `entity.object3d`, behavior via components. No deep hierarchy required.
 * Component — plain class with optional hooks:
 *   init(entity, world)      once, when added (or when entity joins a world)
 *   fixedUpdate(dt, ctx)     60hz gameplay step
 *   update(dt, ctx)          per-frame
 *   dispose()                cleanup
 * ctx = { engine, world, input, entity }
 */
export class World {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
    this.entities = [];
    this._pendingRemove = new Set();
  }

  spawn(name = "entity") {
    const e = new Entity(name, this);
    this.entities.push(e);
    this.scene.add(e.object3d);
    for (const c of e.components) c.init?.(e, this);
    return e;
  }

  destroy(entity) { this._pendingRemove.add(entity); }

  find(name) { return this.entities.find((e) => e.name === name) ?? null; }
  findAll(name) { return this.entities.filter((e) => e.name === name); }

  _fixedUpdate(dt, engine) {
    for (const e of this.entities)
      if (!this._pendingRemove.has(e))
        for (const c of e.components)
          c.fixedUpdate?.(dt, { engine, world: this, input: engine.input, entity: e });
    this._flush();
  }

  _update(dt, engine) {
    for (const e of this.entities)
      if (!this._pendingRemove.has(e))
        for (const c of e.components)
          c.update?.(dt, { engine, world: this, input: engine.input, entity: e });
    this._flush();
  }

  _flush() {
    if (!this._pendingRemove.size) return;
    for (const e of this._pendingRemove) {
      const i = this.entities.indexOf(e);
      if (i >= 0) this.entities.splice(i, 1);
      this.scene.remove(e.object3d);
      for (const c of e.components) c.dispose?.();
    }
    this._pendingRemove.clear();
  }
}

export class Entity {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.object3d = new THREE.Group();
    this.object3d.name = name;
    this.components = [];
  }

  /** position shorthand: entity.at(x, y, z) — chainable */
  at(x, y, z) { this.object3d.position.set(x, y, z); return this; }

  get position() { return this.object3d.position; }
  get rotation() { return this.object3d.rotation; }

  /** add a Component instance (chainable): e.add(new Spin(2)) */
  add(component) {
    this.components.push(component);
    component.entity = this;
    if (this.world) component.init?.(this, this.world);
    return this;
  }

  /** add a three.js object (mesh, light, ...) under this entity (chainable) */
  mesh(obj) { this.object3d.add(obj); return this; }

  /** first component of a given class, or null */
  get(cls) { return this.components.find((c) => c instanceof cls) ?? null; }
}

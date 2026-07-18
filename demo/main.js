// PlayForge demo v2: platform-hopper showcasing physics, particles, tweens.
// Jump across floating islands, grab the gold cubes, don't fall.
import {
  Engine, World, OrbitRig, Audio, Body, Collider, Emitter,
  tween, after, THREE,
} from "../src/index.js";

const engine = new Engine(document.getElementById("game"));
const world = new World();
const audio = new Audio();
engine.world = world;

// ---- lights ----------------------------------------------------------------
world.spawn("sun").mesh(makeSun());
function makeSun() {
  const g = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
  sun.position.set(12, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 24;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  g.add(sun, new THREE.AmbientLight(0x8899bb, 0.7));
  return g;
}

// ---- floating islands (physics colliders + meshes) -------------------------
const ISLANDS = [
  [0, 0, 0, 7],      // x, y, z, size — home island
  [9, 1.2, -3, 4],
  [15, 2.5, 2, 3.5],
  [10, 3.6, 8, 3],
  [2, 4.5, 12, 3.5],
  [-6, 3.2, 8, 3],
  [-9, 1.6, 0, 4],
];
for (const [x, y, z, s] of ISLANDS) {
  world.spawn("island")
    .mesh(shadowed(new THREE.Mesh(
      new THREE.BoxGeometry(s, 1, s),
      new THREE.MeshStandardMaterial({ color: 0x3d7a3f }),
    ), true))
    .at(x, y - 0.5, z)
    .add(new Collider({ size: [s, 1, s] }));
}

// bobbing motion on the outer islands — tween as ambient animation
world.findAll("island").slice(1).forEach((isl, i) => {
  tween(isl.position, { y: isl.position.y + 0.4 }, 1.6 + i * 0.2,
        { ease: "sineInOut", yoyo: true, repeat: Infinity, delay: i * 0.3 });
});

// ---- player (real physics body now) ----------------------------------------
class PlayerMove {
  fixedUpdate(dt, { input, world, entity }) {
    const body = entity.get(Body);
    const cam = world.camera;
    const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const stick = input.stick("left");
    const ix = input.axis("KeyA", "KeyD") + stick.x;
    const iz = input.axis("KeyS", "KeyW") - stick.y;
    const wish = f.multiplyScalar(iz).addScaledVector(r, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    body.velocity.x = wish.x * 6;
    body.velocity.z = wish.z * 6;
    if (input.pressed("Space") && body.onGround) {
      body.velocity.y = 9.5;
      audio.play("jump");
      dust.burst(10, entity.position.clone().setY(entity.position.y - 0.4));
    }
    if (wish.lengthSq() > 0.01)
      entity.rotation.y = Math.atan2(body.velocity.x, body.velocity.z);
    // fell off the world
    if (entity.position.y < -12) {
      audio.play("die");
      entity.at(0, 2, 0);
      body.velocity.set(0, 0, 0);
      shake(0.5);
    }
  }
}

const player = world.spawn("player")
  .mesh(makeBody())
  .at(0, 2, 0)
  .add(new Body({ size: [0.6, 1.35, 0.6], offset: [0, 0.55, 0] }))
  .add(new PlayerMove());

function makeBody() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x4d8dff }));
  body.position.y = 0.45; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xf2c9a0 }));
  head.position.y = 1.15; head.castShadow = true;
  g.add(body, head);
  return g;
}

// world-space particle emitters (attached to a static root entity)
const fx = world.spawn("fx");
const dust = new Emitter({ color: 0xcfc7b8, count: 128, speed: [0.5, 2], life: [0.2, 0.5], gravity: 2, size: 0.1 });
const boomGold = new Emitter({ color: 0xffd75e, color2: 0xff7722, count: 256, speed: [2, 7], life: [0.3, 0.8], gravity: 7, size: 0.16 });
fx.add(dust).add(boomGold);

// ---- coins on random islands ----------------------------------------------
let score = 0;
function spawnCoin() {
  const [x, y, z] = ISLANDS[1 + Math.floor(Math.random() * (ISLANDS.length - 1))];
  const coin = world.spawn("coin")
    .mesh(shadowed(new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xffd75e, emissive: 0x664400 }),
    )))
    .at(x, y + 1.0, z)
    .add({ update(dt, { entity, engine }) { entity.rotation.y += 3 * dt; } })
    .add(new Collider({
      size: [1.4, 1.6, 1.4], trigger: true,
      onEnter(other) {
        if (other.name !== "player") return;
        audio.play("pickup");
        score++;
        document.getElementById("score").textContent = score;
        boomGold.burst(36, coin.position.clone());
        world.destroy(coin);
        after(0.6, spawnCoin);
      },
    }));
  // pop-in: scale 0 → 1 with backOut
  coin.object3d.scale.setScalar(0.01);
  tween(coin.object3d.scale, { x: 1, y: 1, z: 1 }, 0.35, { ease: "backOut" });
}
for (let i = 0; i < 3; i++) spawnCoin();

function shadowed(m, receive = false) { m.castShadow = true; m.receiveShadow = receive; return m; }

// ---- camera + screen shake -------------------------------------------------
const rig = new OrbitRig({ target: [2, 2, 4], distance: 22, pitch: 0.5 });
world.spawn("camera").add(rig).add({
  update(dt, { world }) { // follow the player loosely
    rig.target.lerp(player.position.clone().add(new THREE.Vector3(0, 1, 0)), dt * 2.5);
    if (shakeT > 0) {
      shakeT -= dt;
      world.camera.position.x += (Math.random() - 0.5) * shakeT * 0.6;
      world.camera.position.y += (Math.random() - 0.5) * shakeT * 0.6;
    }
  },
});
let shakeT = 0;
function shake(t) { shakeT = t; }

engine.start();
window.__pf = { engine, world, audio, player, spawnCoin }; // debug/test handle

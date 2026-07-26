// PLAYFORGE — direct mouse interaction with the active ragdoll (shared by the
// Ragdoll Lab + Character Editor).
//
//   • RIGHT-CLICK on the character   → PUNCH at the clicked segment. The strike's
//     power vs the ragdoll's knockdownImpulse budget decides the outcome: a light/
//     medium hit STAGGERS him (he braces and stays up, then recovers his footing);
//     a hard hit KNOCKS HIM DOWN (he falls, settles, gets up). The host decides via
//     the onPunch callback.
//   • RIGHT-CLICK + DRAG on the character → GRAB that segment and drag it around a
//     view-plane point (a kinematic anchor the limb springs toward). Release to let
//     go. Lets you shove/pose limbs directly.
//
// Segment picking raycasts against the ragdoll's capsule bodies (nearest to the
// ray). Kept host-agnostic: the host supplies the camera, the live ragdoll, the
// physics, and a couple of small callbacks so it keeps owning its state machine.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

export function attachRagdollMouse({
  canvas, getCamera, getRag, getPhys,
  ensureActive,           // () => rag|null : put the host into a grabbable ragdoll state
  onPunch,                // (segName, worldPoint, impulseVec, power) => void
  punchPower = 340,       // normal right-click punch (usually a STAGGER — stays up)
  hardPunchPower = 720,   // SHIFT + right-click = a hard punch (KNOCKS HIM DOWN)
  grabStiffness = 600, grabDamping = 30,
  dragThreshold = 6,      // px of movement before a click becomes a drag/grab
}) {
  const ray = new THREE.Raycaster();
  const tmp = new THREE.Vector3(), n = new THREE.Vector3(), plane = new THREE.Plane();
  let down = null;        // { x, y, seg, point, moved }
  let grab = null;        // { id, anchor, seg, depth }

  const ndc = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };

  // nearest ragdoll segment to the pick ray (capsule centre within radius+slop,
  // closest along the ray to the camera)
  function pick(rag, camera, p) {
    ray.setFromCamera(p, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let best = null, bestProj = 1e9;
    for (const s of rag.segments) {
      const t = s.body.translation();
      const px = t.x - o.x, py = t.y - o.y, pz = t.z - o.z;
      const proj = px * d.x + py * d.y + pz * d.z;
      if (proj < 0) continue;
      const dist = Math.hypot(px - d.x * proj, py - d.y * proj, pz - d.z * proj);
      if (dist < s.radius + 0.14 && proj < bestProj) {
        bestProj = proj; best = { seg: s, point: { x: t.x, y: t.y, z: t.z }, depth: proj };
      }
    }
    return best;
  }

  // map a mouse position to a world point on the camera-facing plane at `depthPt`
  function planePoint(camera, p, depthPt) {
    ray.setFromCamera(p, camera);
    camera.getWorldDirection(n);
    plane.setFromNormalAndCoplanarPoint(n, tmp.set(depthPt.x, depthPt.y, depthPt.z));
    const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
    return hit || tmp.clone();
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 2) return;                       // right button only
    const rag = getRag();
    if (!rag || !rag.segments.length) return;         // nothing to hit until built once
    const hit = pick(rag, getCamera(), ndc(e));
    if (!hit) return;
    e.preventDefault();
    down = { x: e.clientX, y: e.clientY, seg: hit.seg, point: hit.point, depth: hit.depth, moved: false, hard: e.shiftKey };
    canvas.setPointerCapture?.(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > dragThreshold) {
      down.moved = true;                              // promote click → drag/grab
      startGrab(e);
    }
    if (grab) {
      const pt = planePoint(getCamera(), ndc(e), { x: grab.anchor.translation().x, y: grab.anchor.translation().y, z: grab.anchor.translation().z });
      // keep the drag on the plane at the segment's grabbed depth
      const pin = planePoint(getCamera(), ndc(e), grab.depthPt);
      grab.anchor.setNextKinematicTranslation({ x: pin.x, y: pin.y, z: pin.z });
    }
  });

  const end = (e) => {
    if (!down) return;
    if (grab) endGrab();
    else if (!down.moved) doPunch();                  // quick click = punch
    down = null;
    canvas.releasePointerCapture?.(e.pointerId);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  function startGrab() {
    const rag = ensureActive?.() || getRag();
    const phys = getPhys();
    if (!rag || !phys) return;
    // re-find the segment on the (now active) ragdoll by name
    const seg = rag.segments.find((s) => s.name === down.seg.name) || down.seg;
    const t = seg.body.translation();
    const anchor = phys.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(t.x, t.y, t.z));
    const id = rag.grab(seg.name, { body: anchor }, { x: t.x, y: t.y, z: t.z },
      { stiffness: grabStiffness, damping: grabDamping });
    grab = { id, anchor, seg, depthPt: { x: t.x, y: t.y, z: t.z } };
  }
  function endGrab() {
    const rag = getRag(), phys = getPhys();
    if (grab) {
      try { rag?.release(grab.id); } catch (_) {}
      try { phys?.world.removeRigidBody(grab.anchor); } catch (_) {}
    }
    grab = null;
  }
  function doPunch() {
    const camera = getCamera();
    // impulse along the camera view direction (you punch INTO the screen), lifted a
    // touch so hits read
    const power = down.hard ? hardPunchPower : punchPower;
    camera.getWorldDirection(n);
    const imp = { x: n.x * power, y: n.y * power + power * 0.15, z: n.z * power };
    onPunch?.(down.seg.name, down.point, imp, power);
  }

  return {
    dispose() {
      endGrab();
      // listeners are on the canvas; leave them (labs are single-page). Provided for API symmetry.
    },
    isGrabbing: () => !!grab,
  };
}

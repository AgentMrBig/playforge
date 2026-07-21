import * as THREE from "three";

/**
 * makeWater — an animated ocean surface (Ember, Erik 2026-07-21: "make the water
 * like water so we can have boats in it"). Replaces the flat blue sheet with a
 * real moving sea:
 *   • summed-sine wave displacement in WORLD space (so waves don't slide as the
 *     mesh follows the player), with analytic normals
 *   • depth/fresnel shading — deep blue face-on, sky reflection at grazing angle
 *   • a moving sun glint that tracks the DayNight sun (sunset streaks included)
 *   • foam flecks on the wave crests + a high-freq sparkle
 *   • distance blend to the sky colour so the far edge melts into the horizon
 * Reads window.__pfSky each frame for live sun direction / colour + sky tint, so
 * the sea recolours through the whole day. Boats float on getHeight(x,z,t).
 */
export function makeWater({ size = 3600, segments = 180, y = 0 } = {}) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2);

  // wave set — direction (unit), wavelength, amplitude, speed. Kept in sync with
  // the JS getHeight() below so physics matches what you see.
  const WAVES = [
    { dx: 0.85, dz: 0.53, len: 120, amp: 0.55, spd: 1.0 },
    { dx: -0.6, dz: 0.8, len: 64, amp: 0.30, spd: 1.35 },
    { dx: 0.2, dz: -0.98, len: 34, amp: 0.16, spd: 1.7 },
  ];
  const AMP_SUM = WAVES.reduce((s, w) => s + w.amp, 0);
  const uWaves = WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, (2 * Math.PI) / w.len, w.amp));
  const uSpeeds = new THREE.Vector4(WAVES[0].spd, WAVES[1].spd, WAVES[2].spd, 0);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uWaves: { value: uWaves },
      uSpeeds: { value: uSpeeds },
      uAmpSum: { value: AMP_SUM },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(0xfff0d0) },
      uDeep: { value: new THREE.Color(0x0b2a44) },
      uShallow: { value: new THREE.Color(0x2f7fa6) },
      uSky: { value: new THREE.Color(0x8fb9dc) },
      uCamPos: { value: new THREE.Vector3() },
      uOpacity: { value: 0.9 },
      uFogStart: { value: size * 0.16 },
      uFogEnd: { value: size * 0.52 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uWaves[3];      // xy=dir, z=k(2pi/len), w=amplitude
      uniform vec4 uSpeeds;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vCrest;

      void main() {
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;   // world pos (pre-wave)
        float h = 0.0; vec2 dxz = vec2(0.0);
        for (int i = 0; i < 3; i++) {
          vec2 dir = uWaves[i].xy; float k = uWaves[i].z; float a = uWaves[i].w;
          float phase = dot(dir, wp.xz) * k + uTime * uSpeeds[i] * k * 4.0;
          h += a * sin(phase);
          // d(height)/d(world xz) for the analytic normal
          float c = a * k * cos(phase);
          dxz += dir * c;
        }
        wp.y += h;
        vCrest = h;
        vNormal = normalize(vec3(-dxz.x, 1.0, -dxz.y));
        vWorld = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uAmpSum, uOpacity, uFogStart, uFogEnd;
      uniform vec3 uSunDir, uSunColor, uDeep, uShallow, uSky, uCamPos;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vCrest;

      void main() {
        vec3 V = normalize(uCamPos - vWorld);
        vec3 N = normalize(vNormal);
        // high-freq sparkle: perturb the normal with fast little ripples
        float rx = sin(vWorld.x * 0.9 + uTime * 2.3) + sin(vWorld.z * 1.3 - uTime * 1.7);
        float rz = sin(vWorld.z * 0.8 - uTime * 2.1) + sin(vWorld.x * 1.1 + uTime * 1.9);
        N = normalize(N + vec3(rx, 0.0, rz) * 0.045);

        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        fres = clamp(0.02 + 0.98 * fres, 0.0, 1.0);

        // deep face-on, brighter where the surface tilts toward us
        vec3 base = mix(uDeep, uShallow, smoothstep(0.86, 1.0, N.y));
        vec3 col = mix(base, uSky, fres * 0.75);

        // sun glint — specular off the wave normals toward the DayNight sun
        vec3 R = reflect(-uSunDir, N);
        float spec = pow(max(dot(R, V), 0.0), 140.0);
        col += uSunColor * spec * 1.8;

        // foam flecks riding the highest crests — broken up by a little noise so
        // they read as whitecaps, not straight streaks along the wave lines
        float crest = vCrest / max(uAmpSum, 0.001);
        float speck = 0.5 + 0.5 * sin(vWorld.x * 2.7 + uTime * 3.0) * sin(vWorld.z * 3.1 - uTime * 2.4);
        float foam = smoothstep(0.82, 1.0, crest) * speck;
        col = mix(col, vec3(0.92, 0.96, 1.0), foam * 0.6);

        // melt the far plane into the sky (doubles as fog)
        float d = distance(uCamPos, vWorld);
        float fog = smoothstep(uFogStart, uFogEnd, d);
        col = mix(col, uSky, fog);

        float alpha = mix(uOpacity, 1.0, fres);
        alpha = mix(alpha, 1.0, foam);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;      // it follows the camera; never cull it
  mesh.renderOrder = 1;
  mesh.position.y = y;

  const _sunDir = new THREE.Vector3();
  const _c = new THREE.Color();

  return {
    mesh,
    mat,
    /** wave height (world y offset) at world x,z and time — for floating boats */
    getHeight(x, z, t) {
      let h = 0;
      for (const w of WAVES) {
        const k = (2 * Math.PI) / w.len;
        h += w.amp * Math.sin((w.dx * x + w.dz * z) * k + t * w.spd * k * 4.0);
      }
      return h;
    },
    update(dt, { engine, camera, anchor }) {
      mat.uniforms.uTime.value = engine.time;
      if (anchor) { mesh.position.x = anchor.x; mesh.position.z = anchor.z; }
      if (camera) mat.uniforms.uCamPos.value.copy(camera.position);
      // track the live sun + sky from DayNight
      const sky = typeof window !== "undefined" ? window.__pfSky : null;
      if (sky?.sun) {
        _sunDir.copy(sky.sun.position).sub(sky.sun.target.position).normalize();
        mat.uniforms.uSunDir.value.copy(_sunDir);
        mat.uniforms.uSunColor.value.copy(sky.sun.color);
        if (sky._sky) { _c.copy(sky._sky); mat.uniforms.uSky.value.copy(_c); }
      }
    },
  };
}

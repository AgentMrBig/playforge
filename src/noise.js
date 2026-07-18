/**
 * Seeded 2D value noise + fBm — the terrain workhorse.
 * No deps, deterministic, fast enough to fill a 256×256 heightmap in ~ms.
 */
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1; // -1..1
}

const smooth = (t) => t * t * (3 - 2 * t);

/** single octave of value noise at (x, y), seeded; ~[-1, 1] */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fractal brownian motion: `octaves` layers of noise2, halving amplitude */
export function fbm(x, y, { octaves = 5, freq = 1, gain = 0.5, lacunarity = 2, seed = 0 } = {}) {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f, y * f, seed + i * 101) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** ridged fbm: sharp mountain crests (1 - |noise|, squared) */
export function ridged(x, y, opts = {}) {
  const { octaves = 4, freq = 1, gain = 0.5, lacunarity = 2, seed = 0 } = opts;
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2(x * f, y * f, seed + i * 137));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm; // 0..1
}

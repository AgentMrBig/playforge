// PlayForge minimap — top-down radar for the streamed island. Part of the HUD lane.
// Generic + decoupled like HUD: all game data comes in through render(state); the module
// knows nothing about the world. Reads only — never mutates anything.
//
// v1 (General, #179): circular north-up map with land/water shading (sampled from a
// height function), the player as a heading arrow at center, and dots for the fleet +
// settlements. Terrain is cached to an offscreen buffer and only re-sampled when the
// player moves ~15% of the view range, so the per-frame cost is just blitting + dots.

const TAU = Math.PI * 2;

export class Minimap {
  /**
   * @param {object} [opts]
   * @param {number} [opts.size=168]    logical px (square)
   * @param {number} [opts.range=380]   world units from center to edge
   * @param {string} [opts.corner="tr"] tl|tr|bl|br
   * @param {number} [opts.margin=18]
   * @param {number} [opts.grid=48]     terrain sample resolution (grid×grid)
   */
  constructor(opts = {}) {
    this.size = opts.size ?? 168;
    this.range = opts.range ?? 380;
    this.corner = opts.corner ?? "tr";
    this.margin = opts.margin ?? 18;
    this.grid = opts.grid ?? 48;
    this._mounted = false;
    this._terr = document.createElement("canvas");   // offscreen terrain cache
    this._terr.width = this._terr.height = this.grid;
    this._tctx = this._terr.getContext("2d");
    this._last = null;                                // {x,z} of last terrain bake

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pf-hud pf-minimap";
    const s = this.canvas.style;
    s.position = "fixed"; s.zIndex = "50"; s.pointerEvents = "none";
    s.width = this.size + "px"; s.height = this.size + "px";
    this._placeCorner();
    this.ctx = this.canvas.getContext("2d");
    const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _placeCorner() {
    const s = this.canvas.style, m = this.margin + "px";
    s.top = s.bottom = s.left = s.right = "auto";
    if (this.corner.includes("t")) s.top = m; else s.bottom = m;
    if (this.corner.includes("l")) s.left = m; else s.right = m;
  }

  mount(parent) { (parent ?? document.body).appendChild(this.canvas); this._mounted = true; return this; }
  unmount() { this.canvas.remove(); this._mounted = false; return this; }

  /** (re)bake the terrain layer into the offscreen grid canvas, centered on (cx,cz). */
  _bakeTerrain(cx, cz, sampleHeight, sea) {
    const N = this.grid, img = this._tctx.createImageData(N, N);
    const step = (this.range * 2) / N;
    for (let j = 0; j < N; j++) {
      const wz = cz - this.range + (j + 0.5) * step;   // north (−z) at top
      for (let i = 0; i < N; i++) {
        const wx = cx - this.range + (i + 0.5) * step;
        const h = sampleHeight(wx, wz);
        let r, g, b;
        if (h < sea) { r = 46; g = 92; b = 138; }                    // water
        else if (h < sea + 1.8) { r = 190; g = 172; b = 120; }       // beach
        else if (h > 42) { r = 122; g = 118; b = 112; }              // rock
        else if (h > 60) { r = 226; g = 230; b = 236; }              // snow
        else { const t = Math.min(1, (h - sea) / 40); r = 70 + t * 30; g = 120 - t * 20; b = 66 + t * 10; } // grass→dry
        const k = (j * N + i) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    this._tctx.putImageData(img, 0, 0);
    this._last = { x: cx, z: cz };
  }

  /**
   * Draw one frame.
   * @param {object} state
   * @param {number} state.x, state.z        player world position (map center)
   * @param {number} [state.heading=0]       player heading (rad) for the arrow
   * @param {(x:number,z:number)=>number} [state.sampleHeight]  land/water source
   * @param {number} [state.sea=0]           sea level
   * @param {Array<{x,z,color,r?}>} [state.points]  markers (cars, settlements…)
   */
  render(state = {}) {
    const { x = 0, z = 0, heading = 0, sampleHeight, sea = 0, points = [] } = state;
    const ctx = this.ctx, S = this.size, c = S / 2, R = S * 0.46;

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.clip();   // round mask

    // terrain — rebake only after moving ~15% of the range
    if (sampleHeight) {
      if (!this._last || Math.hypot(x - this._last.x, z - this._last.z) > this.range * 0.15)
        this._bakeTerrain(x, z, sampleHeight, sea);
      ctx.imageSmoothingEnabled = true;
      // offset the cached tile by how far we've moved since the bake (keeps it glued to world)
      const px = ((x - this._last.x) / (this.range * 2)) * S;
      const pz = ((z - this._last.z) / (this.range * 2)) * S;
      ctx.drawImage(this._terr, -px, -pz, S, S);
    } else {
      ctx.fillStyle = "#2a2f36"; ctx.fillRect(0, 0, S, S);
    }

    // world→map: north (−z) up, 1 world unit = S/(2·range) px
    const k = S / (this.range * 2);
    const mapPt = (wx, wz) => [c + (wx - x) * k, c + (wz - z) * k];

    // markers
    for (const p of points) {
      const [mx, my] = mapPt(p.x, p.z);
      if (Math.hypot(mx - c, my - c) > R - 2) continue;   // outside the dial
      ctx.beginPath(); ctx.arc(mx, my, p.r ?? 3, 0, TAU);
      ctx.fillStyle = p.color ?? "#ffd75e"; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.stroke();
    }

    // player arrow at center (points toward heading; screen y is down, so negate)
    ctx.save(); ctx.translate(c, c); ctx.rotate(-heading);
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6); ctx.closePath();
    ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = "#1c2530"; ctx.stroke();
    ctx.restore();

    ctx.restore(); // remove clip

    // bezel ring + N
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU);
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,14,18,0.85)"; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.round(S * 0.085)}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("N", c, c - R + S * 0.085);
    return this;
  }
}

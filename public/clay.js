/**
 * clay.js — the volume, the brush, and the surface extraction.
 *
 * Deliberately free of three.js and of the DOM: this is the part worth testing
 * headlessly, and the part that will be ported to a compute shader later.
 *
 * Representation is a signed distance field, negative inside the clay. Brushes
 * are SDF stamps combined with smooth min/max. A mesh is extracted per chunk
 * with Surface Nets — one vertex per sign-changing cell — and only chunks a
 * stroke actually touched are re-extracted.
 */

export const CFG = {
  N: 64,                 // cells per axis
  WORLD: 0.30,           // metres across the volume
  CS: 16,                // cells per chunk — one mesh, one draw call
  SUB: 8,                // cells per sub-chunk — the unit that is actually re-extracted
  BLOCK_HALF: 0.09,      // starting cuboid half-extent
};
CFG.DIM    = CFG.N + 1;
CFG.VOX    = CFG.WORLD / CFG.N;
CFG.CHUNKS = CFG.N / CFG.CS;
CFG.SUBS   = CFG.N / CFG.SUB;
CFG.CLAMP  = CFG.VOX * 4;

const { N, DIM, WORLD, VOX, CS, SUB, CHUNKS, SUBS, CLAMP } = CFG;
const SPC = CS / SUB;    // sub-chunks per chunk, per axis

export const field = new Float32Array(DIM * DIM * DIM);
/** Render chunks whose mesh is stale. The renderer clears these as it rebuilds. */
export const dirty = new Uint8Array(CHUNKS * CHUNKS * CHUNKS);
/** Sub-chunks whose cached surface is stale. buildChunk clears these. */
const dirtySub = new Uint8Array(SUBS * SUBS * SUBS);
const sidx = (a, b, c) => (c * SUBS + b) * SUBS + a;

export const idx  = (x, y, z) => (z * DIM + y) * DIM + x;
export const cidx = (a, b, c) => (c * CHUNKS + b) * CHUNKS + a;
/** sample index -> local metres, volume centred on the origin */
export const sx = i => (i / N - 0.5) * WORLD;

const clamp = v => v < -CLAMP ? -CLAMP : (v > CLAMP ? CLAMP : v);

/* ── initial block ───────────────────────────────────────────────────────── */
export function resetToCuboid(half = CFG.BLOCK_HALF) {
  for (let z = 0; z < DIM; z++) {
    const wz = sx(z);
    for (let y = 0; y < DIM; y++) {
      const wy = sx(y);
      for (let x = 0; x < DIM; x++) {
        const wx = sx(x);
        const qx = Math.abs(wx) - half, qy = Math.abs(wy) - half, qz = Math.abs(wz) - half;
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
        const outside = Math.sqrt(ox*ox + oy*oy + oz*oz);
        const inside  = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
        field[idx(x, y, z)] = clamp(outside + inside);
      }
    }
  }
  sealBorder();
  markAllDirty();
}

/** Keep the outer shell outside the clay so the surface always closes.
 *  A watertight mesh is the difference between an asset and a broken export. */
export function sealBorder() {
  for (let a = 0; a < DIM; a++)
    for (let b = 0; b < DIM; b++)
      for (const i of [0, DIM - 1]) {
        field[idx(i, a, b)] = CLAMP;
        field[idx(a, i, b)] = CLAMP;
        field[idx(a, b, i)] = CLAMP;
      }
}

export function markAllDirty() { dirty.fill(1); dirtySub.fill(1); }

/** A changed sample at v touches cells v-1 and v, hence the -1. Marking at
 *  sub-chunk granularity is the point: a brush that clips the corner of a
 *  16³ chunk re-extracts one 8³ piece of it, not the whole thing. */
function markDirtyRange(x0, y0, z0, x1, y1, z1) {
  const lo = v => Math.max(0, Math.floor((v - 1) / SUB));
  const hi = v => Math.min(SUBS - 1, Math.floor(v / SUB));
  for (let sz = lo(z0); sz <= hi(z1); sz++)
    for (let sy = lo(y0); sy <= hi(y1); sy++)
      for (let sx_ = lo(x0); sx_ <= hi(x1); sx_++) {
        dirtySub[sidx(sx_, sy, sz)] = 1;
        dirty[cidx((sx_ / SPC) | 0, (sy / SPC) | 0, (sz / SPC) | 0)] = 1;
      }
}

/* ── brush ───────────────────────────────────────────────────────────────── */
const smin = (a, b, k) => {
  if (k <= 1e-5) return Math.min(a, b);
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);

const scratch = new Float32Array(field.length);

export const TOOL = { ADD: 0, CARVE: 1, SMOOTH: 2 };

/**
 * Stamp a spherical brush into the field at local coordinates (metres).
 * `mat` supplies the material's feel: smoothK is adhesion, rate is stiffness.
 */
export function stamp(lx, ly, lz, radius, tool, strength = 1, mat = { smoothK: 0.9, rate: 1 }) {
  const k   = mat.smoothK * VOX * 2.2;
  const amt = mat.rate * strength;

  const toI = w => (w / WORLD + 0.5) * N;
  const pad = radius / WORLD * N + 2;
  const x0 = Math.max(1, Math.floor(toI(lx) - pad)), x1 = Math.min(DIM - 2, Math.ceil(toI(lx) + pad));
  const y0 = Math.max(1, Math.floor(toI(ly) - pad)), y1 = Math.min(DIM - 2, Math.ceil(toI(ly) + pad));
  const z0 = Math.max(1, Math.floor(toI(lz) - pad)), z1 = Math.min(DIM - 2, Math.ceil(toI(lz) + pad));
  if (x1 < x0 || y1 < y0 || z1 < z0) return false;

  if (tool === TOOL.SMOOTH) {
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) { const i = idx(x, y, z); scratch[i] = field[i]; }
  }

  for (let z = z0; z <= z1; z++) {
    const dz = sx(z) - lz;
    for (let y = y0; y <= y1; y++) {
      const dy = sx(y) - ly;
      for (let x = x0; x <= x1; x++) {
        const dx = sx(x) - lx;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz) - radius;
        if (d > VOX * 3) continue;
        const i = idx(x, y, z);
        const f = field[i];
        let out;
        if (tool === TOOL.ADD) {
          out = f + (smin(f, d, k) - f) * amt;
        } else if (tool === TOOL.CARVE) {
          out = f + (smax(f, -d, k) - f) * amt;
        } else {
          const falloff = Math.max(0, Math.min(1, -d / (radius + VOX)));
          if (falloff <= 0) continue;
          const avg = (scratch[i-1] + scratch[i+1] + scratch[i-DIM] + scratch[i+DIM]
                     + scratch[i-DIM*DIM] + scratch[i+DIM*DIM]) / 6;
          out = f + (avg - f) * falloff * 0.65 * strength;
        }
        field[i] = clamp(out);
      }
    }
  }
  markDirtyRange(x0, y0, z0, x1, y1, z1);
  return true;
}

/* ── Surface Nets ────────────────────────────────────────────────────────── */
const CORNER = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
const EDGES  = [[0,1],[1,3],[2,3],[0,2],[4,5],[5,7],[6,7],[4,6],[0,4],[1,5],[2,6],[3,7]];
const cornerVals = new Float32Array(8);

function gradient(x, y, z) {
  const gx = field[idx(Math.min(x+1, DIM-1), y, z)] - field[idx(Math.max(x-1, 0), y, z)];
  const gy = field[idx(x, Math.min(y+1, DIM-1), z)] - field[idx(x, Math.max(y-1, 0), z)];
  const gz = field[idx(x, y, Math.min(z+1, DIM-1))] - field[idx(x, y, Math.max(z-1, 0))];
  const l = Math.sqrt(gx*gx + gy*gy + gz*gz) || 1;
  return [gx/l, gy/l, gz/l];
}

/* Flat lookup tables for the hot path — no nested arrays, no destructuring. */
const EA = new Int8Array(EDGES.map(e => e[0])), EB = new Int8Array(EDGES.map(e => e[1]));
const CX = new Int8Array(CORNER.map(c => c[0])), CY = new Int8Array(CORNER.map(c => c[1])), CZ = new Int8Array(CORNER.map(c => c[2]));
const COFF = new Int32Array(CORNER.map(c => (c[2] * DIM + c[1]) * DIM + c[0]));
// The four cells sharing an edge along axis d, as offsets: QX/QY/QZ[d*4 + k].
const QX = new Int8Array(12), QY = new Int8Array(12), QZ = new Int8Array(12);
for (let d = 0; d < 3; d++) {
  const du = d === 0 ? [0,1,0] : d === 1 ? [0,0,1] : [1,0,0];
  const dv = d === 0 ? [0,0,1] : d === 1 ? [1,0,0] : [0,1,0];
  [[0,0],[-1,0],[-1,-1],[0,-1]].forEach(([su, sv], k) => {
    QX[d*4 + k] = du[0]*su + dv[0]*sv;
    QY[d*4 + k] = du[1]*su + dv[1]*sv;
    QZ[d*4 + k] = du[2]*su + dv[2]*sv;
  });
}

// Extraction scratch. A sub-chunk scans at most (SUB+1)³ cells and makes at
// most one vertex per cell.
const SMAX = (SUB + 1) ** 3;
const vmapBuf = new Int32Array(SMAX);
const posBuf  = new Float32Array(SMAX * 3);
const nrmBuf  = new Float32Array(SMAX * 3);
const idxBuf  = new Uint16Array(SMAX * 18);
const quad    = new Int32Array(4);
let extractNV = 0, extractNI = 0;

/**
 * Surface Nets over one sub-chunk, into the scratch above. The cell range is
 * extended by one past the sub-chunk so seam quads are emitted by both
 * neighbours — the duplicates are exactly coincident, so they cost a little
 * geometry and nothing visually.
 */
function extractSub(sx_, sy_, sz_) {
  const bx = sx_ * SUB, by = sy_ * SUB, bz = sz_ * SUB;
  const ex = Math.min(bx + SUB, N - 1), ey = Math.min(by + SUB, N - 1), ez = Math.min(bz + SUB, N - 1);
  const w = ex - bx + 1, h = ey - by + 1;

  vmapBuf.fill(-1, 0, w * h * (ez - bz + 1));
  let nv = 0, ni = 0;

  for (let z = bz; z <= ez; z++)
    for (let y = by; y <= ey; y++)
      for (let x = bx; x <= ex; x++) {
        const base = idx(x, y, z);
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[base + COFF[c]];
          cornerVals[c] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;

        let ax = 0, ay = 0, az = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EA[e], b = EB[e];
          const va = cornerVals[a], vb = cornerVals[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          ax += CX[a] + (CX[b] - CX[a]) * t;
          ay += CY[a] + (CY[b] - CY[a]) * t;
          az += CZ[a] + (CZ[b] - CZ[a]) * t;
          n++;
        }
        vmapBuf[((z - bz) * h + (y - by)) * w + (x - bx)] = nv;
        const o = nv * 3;
        posBuf[o] = sx(x + ax/n); posBuf[o+1] = sx(y + ay/n); posBuf[o+2] = sx(z + az/n);
        const gx = field[idx(Math.min(x+1, DIM-1), y, z)] - field[idx(Math.max(x-1, 0), y, z)];
        const gy = field[idx(x, Math.min(y+1, DIM-1), z)] - field[idx(x, Math.max(y-1, 0), z)];
        const gz = field[idx(x, y, Math.min(z+1, DIM-1))] - field[idx(x, y, Math.max(z-1, 0))];
        const gl = Math.sqrt(gx*gx + gy*gy + gz*gz) || 1;
        nrmBuf[o] = gx/gl; nrmBuf[o+1] = gy/gl; nrmBuf[o+2] = gz/gl;
        nv++;
      }

  for (let z = bz; z <= ez; z++)
    for (let y = by; y <= ey; y++)
      for (let x = bx; x <= ex; x++) {
        const inside = field[idx(x, y, z)] < 0;
        for (let d = 0; d < 3; d++) {
          const nx = x + (d === 0 ? 1 : 0), ny = y + (d === 1 ? 1 : 0), nz = z + (d === 2 ? 1 : 0);
          if (nx >= DIM || ny >= DIM || nz >= DIM) continue;
          if ((field[idx(nx, ny, nz)] < 0) === inside) continue;

          let ok = true;
          for (let k = 0; k < 4; k++) {
            const px = x + QX[d*4 + k], py = y + QY[d*4 + k], pz = z + QZ[d*4 + k];
            if (px < bx || py < by || pz < bz || px > ex || py > ey || pz > ez) { ok = false; break; }
            const vi = vmapBuf[((pz - bz) * h + (py - by)) * w + (px - bx)];
            if (vi < 0) { ok = false; break; }
            quad[k] = vi;
          }
          if (!ok) continue;
          if (inside) {
            idxBuf[ni++] = quad[0]; idxBuf[ni++] = quad[1]; idxBuf[ni++] = quad[2];
            idxBuf[ni++] = quad[0]; idxBuf[ni++] = quad[2]; idxBuf[ni++] = quad[3];
          } else {
            idxBuf[ni++] = quad[0]; idxBuf[ni++] = quad[2]; idxBuf[ni++] = quad[1];
            idxBuf[ni++] = quad[0]; idxBuf[ni++] = quad[3]; idxBuf[ni++] = quad[2];
          }
        }
      }

  extractNV = nv; extractNI = ni;
}

// Each sub-chunk's last surface, kept so an unchanged piece is copied, not re-extracted.
const subCache = Array.from({ length: SUBS ** 3 }, () =>
  ({ pos: new Float32Array(0), nrm: new Float32Array(0), idx: new Uint16Array(0), nv: 0, ni: 0 }));

function refreshSub(s, sx_, sy_, sz_) {
  extractSub(sx_, sy_, sz_);
  const c = subCache[s], nv = extractNV, ni = extractNI;
  if (c.pos.length < nv * 3) { const cap = Math.ceil(nv * 1.5) * 3; c.pos = new Float32Array(cap); c.nrm = new Float32Array(cap); }
  if (c.idx.length < ni)     c.idx = new Uint16Array(Math.ceil(ni * 1.5 / 6) * 6);
  c.pos.set(posBuf.subarray(0, nv * 3)); c.nrm.set(nrmBuf.subarray(0, nv * 3)); c.idx.set(idxBuf.subarray(0, ni));
  c.nv = nv; c.ni = ni;
  dirtySub[s] = 0;
}

// A chunk is SPC³ sub-chunks of at most (SUB+1)³ vertices each — 5,832 at the
// defaults, so 16-bit indices still suffice.
const CVMAX = SPC ** 3 * SMAX;
const outPos = new Float32Array(CVMAX * 3);
const outNrm = new Float32Array(CVMAX * 3);
const outIdx = new Uint16Array(CVMAX * 18);

/**
 * Surface of one render chunk: re-extract only its stale sub-chunks, then
 * stitch all of them into one buffer for a single draw call.
 *
 * Allocation-free: the returned arrays are views into shared scratch and are
 * overwritten by the next call, so copy them out before building another.
 */
export function buildChunk(cx, cy, cz) {
  let nv = 0, ni = 0;
  for (let k = 0; k < SPC; k++)
    for (let j = 0; j < SPC; j++)
      for (let i = 0; i < SPC; i++) {
        const sx_ = cx * SPC + i, sy_ = cy * SPC + j, sz_ = cz * SPC + k;
        const s = sidx(sx_, sy_, sz_);
        if (dirtySub[s]) refreshSub(s, sx_, sy_, sz_);
        const c = subCache[s];
        if (!c.ni) continue;
        outPos.set(c.pos.subarray(0, c.nv * 3), nv * 3);
        outNrm.set(c.nrm.subarray(0, c.nv * 3), nv * 3);
        for (let q = 0; q < c.ni; q++) outIdx[ni + q] = c.idx[q] + nv;
        nv += c.nv; ni += c.ni;
      }
  return { positions: outPos.subarray(0, nv * 3), normals: outNrm.subarray(0, nv * 3), indices: outIdx.subarray(0, ni) };
}

/**
 * Extract the whole volume as one welded mesh. Too slow for the frame loop,
 * exactly right for export: no duplicated seam triangles, so the result is a
 * closed manifold surface that a DCC tool or a slicer will accept.
 */
export function buildAll() {
  const vmap = new Int32Array(DIM * DIM * DIM).fill(-1);
  const positions = [], normals = [], indices = [];

  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[idx(x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2])];
          cornerVals[c] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;

        let ax = 0, ay = 0, az = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = cornerVals[a], vb = cornerVals[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          ax += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
          ay += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
          az += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
          n++;
        }
        vmap[idx(x, y, z)] = positions.length / 3;
        positions.push(sx(x + ax/n), sx(y + ay/n), sx(z + az/n));
        const g = gradient(x, y, z);
        normals.push(g[0], g[1], g[2]);
      }

  for (let z = 1; z < N; z++)
    for (let y = 1; y < N; y++)
      for (let x = 1; x < N; x++) {
        const inside = field[idx(x, y, z)] < 0;
        for (let d = 0; d < 3; d++) {
          const nx = x + (d === 0 ? 1 : 0), ny = y + (d === 1 ? 1 : 0), nz = z + (d === 2 ? 1 : 0);
          if ((field[idx(nx, ny, nz)] < 0) === inside) continue;
          const du = d === 0 ? [0,1,0] : d === 1 ? [0,0,1] : [1,0,0];
          const dv = d === 0 ? [0,0,1] : d === 1 ? [1,0,0] : [0,1,0];
          const q = []; let ok = true;
          for (const [su, sv] of [[0,0],[-1,0],[-1,-1],[0,-1]]) {
            const vi = vmap[idx(x + du[0]*su + dv[0]*sv, y + du[1]*su + dv[1]*sv, z + du[2]*su + dv[2]*sv)];
            if (vi < 0) { ok = false; break; }
            q.push(vi);
          }
          if (!ok) continue;
          if (inside) indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
          else        indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
        }
      }

  return { positions, normals, indices };
}

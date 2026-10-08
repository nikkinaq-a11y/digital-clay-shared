/**
 * Headless checks on the volume + surface extraction.
 * Run: npm test
 *
 * The point of these is that a broken mesh is invisible in the headset until
 * you try to export it — so verify manifoldness and orientation on the ground.
 */
import { CFG, field, dirty, idx, resetToCuboid, sealBorder, stamp,
         buildChunk, buildAll, TOOL } from '../public/clay.js';

const { N, DIM, VOX, CHUNKS } = CFG;
let failures = 0;

const ok  = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const ms = fn => { const t = process.hrtime.bigint(); const r = fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

function bbox(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], positions[i + a]);
      hi[a] = Math.max(hi[a], positions[i + a]);
    }
  return { lo, hi };
}

/** Every undirected edge used exactly twice = closed. Every directed edge used
 *  exactly once = consistently wound. Both must hold for a usable export. */
function topology({ positions, indices }) {
  const dir = new Map(), und = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      const dk = a * 1e7 + b;
      const uk = Math.min(a, b) * 1e7 + Math.max(a, b);
      dir.set(dk, (dir.get(dk) || 0) + 1);
      und.set(uk, (und.get(uk) || 0) + 1);
    }
  }
  let openEdges = 0, nonManifold = 0, badWinding = 0;
  for (const c of und.values()) { if (c === 1) openEdges++; else if (c > 2) nonManifold++; }
  for (const c of dir.values()) if (c > 1) badWinding++;
  return { openEdges, nonManifold, badWinding, tris: indices.length / 3, verts: positions.length / 3 };
}

const solidCount = () => { let n = 0; for (let i = 0; i < field.length; i++) if (field[i] < 0) n++; return n; };

console.log('\n  Digital Clay — volume + meshing checks');
console.log(`  ${N}³ cells · voxel ${(VOX * 1000).toFixed(2)} mm · ${CHUNKS ** 3} chunks\n`);

/* ── 1. the starting cuboid ──────────────────────────────────────────────── */
console.log('  Starting cuboid');
const [, tReset] = ms(() => resetToCuboid());
const [mesh0, tAll0] = ms(() => buildAll());
const bb0 = bbox(mesh0.positions);
const top0 = topology(mesh0);

ok(top0.tris > 1000, 'extracts a surface', `${top0.tris.toLocaleString()} tris, ${top0.verts.toLocaleString()} verts`);
ok(top0.openEdges === 0, 'closed — no open edges', `openEdges=${top0.openEdges}`);
ok(top0.nonManifold === 0, 'manifold — no edge shared by >2 faces', `nonManifold=${top0.nonManifold}`);
ok(top0.badWinding === 0, 'consistently wound', `dupDirected=${top0.badWinding}`);
const half = CFG.BLOCK_HALF;
const bboxErr = Math.max(...bb0.hi.map(v => Math.abs(v - half)), ...bb0.lo.map(v => Math.abs(v + half)));
ok(bboxErr < VOX, `sits at ±${(half * 100).toFixed(0)} cm as asked`,
   `max corner error ${(bboxErr * 1000).toFixed(2)} mm (< ${(VOX * 1000).toFixed(2)} mm voxel)`);

/* ── 2. brush behaviour ──────────────────────────────────────────────────── */
console.log('\n  Brush');
const solid0 = solidCount();
const mat = { smoothK: 0.9, rate: 1.0 };

const [, tStamp] = ms(() => stamp(0, half, 0, 0.022, TOOL.CARVE, 1, mat));
sealBorder();
const solidCarved = solidCount();
ok(solidCarved < solid0, 'carve removes material', `${solid0.toLocaleString()} → ${solidCarved.toLocaleString()} solid samples`);

stamp(0, -half, 0, 0.022, TOOL.ADD, 1, mat);
sealBorder();
ok(solidCount() > solidCarved, 'add deposits material', `→ ${solidCount().toLocaleString()} solid samples`);

const before = field.slice();
stamp(0, half, 0, 0.03, TOOL.SMOOTH, 1, mat);
let moved = 0;
for (let i = 0; i < field.length; i++) if (Math.abs(field[i] - before[i]) > 1e-6) moved++;
ok(moved > 0, 'smooth changes the field', `${moved.toLocaleString()} samples adjusted`);

/* ── 3. still exportable after sculpting ─────────────────────────────────── */
console.log('\n  After sculpting');
// a handful of strokes in different places, including one that cuts a hole clean through
for (let i = 0; i < 12; i++) {
  const a = i / 12 * Math.PI * 2;
  stamp(Math.cos(a) * 0.06, Math.sin(a) * 0.05, 0.04, 0.018, i % 3 === 0 ? TOOL.CARVE : TOOL.ADD, 1, mat);
}
for (let z = -0.12; z <= 0.12; z += 0.01) stamp(0.0, 0.0, z, 0.022, TOOL.CARVE, 1, mat);
sealBorder();

const [mesh1, tAll1] = ms(() => buildAll());
const top1 = topology(mesh1);
ok(top1.tris > 1000, 'still extracts a surface', `${top1.tris.toLocaleString()} tris`);
ok(top1.openEdges === 0, 'still closed after add + carve + a punched hole', `openEdges=${top1.openEdges}`);
ok(top1.nonManifold === 0, 'still manifold', `nonManifold=${top1.nonManifold}`);
ok(top1.badWinding === 0, 'still consistently wound', `dupDirected=${top1.badWinding}`);

/* ── 4. chunked display meshing agrees with the welded one ───────────────── */
console.log('\n  Chunked extraction (what renders each frame)');
let chunkTris = 0, chunkTimes = [], allPos = [];
for (let cz = 0; cz < CHUNKS; cz++)
  for (let cy = 0; cy < CHUNKS; cy++)
    for (let cx = 0; cx < CHUNKS; cx++) {
      const [c, t] = ms(() => buildChunk(cx, cy, cz));
      chunkTimes.push(t);
      chunkTris += c.indices.length / 3;
      allPos.push(...c.positions);
    }
const bbC = bbox(allPos);
const bbA = bbox(mesh1.positions);
const bbDelta = Math.max(...bbC.hi.map((v, i) => Math.abs(v - bbA.hi[i])), ...bbC.lo.map((v, i) => Math.abs(v - bbA.lo[i])));
ok(bbDelta < 1e-6, 'chunked surface occupies the same space as the welded one',
   `bbox delta ${(bbDelta * 1000).toFixed(4)} mm`);
ok(chunkTris >= top1.tris, 'chunk seams are covered (duplicates expected)',
   `${chunkTris.toLocaleString()} chunk tris vs ${top1.tris.toLocaleString()} welded — ${((chunkTris / top1.tris - 1) * 100).toFixed(1)}% seam overlap`);

/* ── 5. does it fit in a frame? ──────────────────────────────────────────── */
console.log('\n  Timing (this Mac — the headset will be slower)');
chunkTimes.sort((a, b) => a - b);
const worst4 = chunkTimes.slice(-4).reduce((a, b) => a + b, 0);
console.log(`    reset volume        ${tReset.toFixed(1)} ms`);
console.log(`    one brush stamp     ${tStamp.toFixed(3)} ms`);
console.log(`    chunk rebuild       median ${chunkTimes[chunkTimes.length >> 1].toFixed(2)} ms, worst ${chunkTimes.at(-1).toFixed(2)} ms`);
console.log(`    4 worst chunks      ${worst4.toFixed(2)} ms   (the per-frame remesh budget)`);
console.log(`    whole-volume weld   ${tAll1.toFixed(0)} ms   (export only, off the hot path)`);
ok(worst4 < 11.1, 'worst-case per-frame remesh fits a 90 Hz frame',
   `${worst4.toFixed(2)} ms of 11.1 ms`);

/* ── 5b. KNOWN LIMITATION: freehand sculpting produces non-manifold cells ── */
// Found on 2026-09-09 from a real headset session, not from these tests.
// Naive Surface Nets places exactly ONE vertex per cell. Where two separate
// sheets of surface pass through the same cell — which rough, heavily worked
// surfaces produce constantly — a single vertex cannot represent both, and the
// edges there end up shared by more than two faces. The mesh stays CLOSED, so
// it renders and exports fine; it is not a clean manifold.
console.log("\n  Freehand roughness (known limitation)");
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
resetToCuboid();
for (let i = 0; i < 400; i++) {
  const x = (rnd() - 0.5) * 0.22, y = (rnd() - 0.5) * 0.22, z = (rnd() - 0.5) * 0.22;
  const r = 0.010 + rnd() * 0.016;
  const t = rnd() < 0.55 ? TOOL.CARVE : (rnd() < 0.8 ? TOOL.ADD : TOOL.SMOOTH);
  stamp(x, y, z, r, t, 1, mat);
}
sealBorder();
const rough = topology(buildAll());
ok(rough.openEdges === 0, "stays closed even when heavily worked", `openEdges=${rough.openEdges}`);
const ratio = rough.nonManifold / rough.tris;
ok(ratio < 0.01, "non-manifold edges stay under 1% of triangles",
   `${rough.nonManifold} of ${rough.tris.toLocaleString()} tris = ${(ratio*100).toFixed(2)}%`);
console.log("    ↳ this is a real defect, not a passing grade — see README, Known limits.");

/* ── 6. the OBJ a headset would send ─────────────────────────────────────── */
console.log('\n  Export payload');
const lines = [];
for (let i = 0; i < mesh1.positions.length; i += 3)
  lines.push(`v ${mesh1.positions[i].toFixed(5)} ${mesh1.positions[i+1].toFixed(5)} ${mesh1.positions[i+2].toFixed(5)}`);
for (let i = 0; i < mesh1.indices.length; i += 3)
  lines.push(`f ${mesh1.indices[i]+1} ${mesh1.indices[i+1]+1} ${mesh1.indices[i+2]+1}`);
const objBytes = lines.join('\n').length;
ok(objBytes > 0 && objBytes < 40e6, 'OBJ is a sane size', `${(objBytes / 1024 / 1024).toFixed(2)} MB`);

console.log(`\n  ${failures === 0 ? 'All checks passed.' : failures + ' CHECK(S) FAILED.'}\n`);
process.exit(failures === 0 ? 0 : 1);

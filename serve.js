#!/usr/bin/env node
/**
 * Digital Clay — dev server.
 *
 * Serves ./public and accepts POST /export, writing the sculpture straight
 * into ./exports on this machine. Runs plain HTTP because the headset reaches
 * it through `adb reverse` as http://localhost:8080 — localhost is a secure
 * context, which is what WebXR requires. No certificates, no warnings.
 */
import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT    = Number(process.env.PORT || 8080);
const ROOT    = path.join(__dirname, 'public');
const EXPORTS = path.join(__dirname, 'exports');
const FRAMES  = path.join(__dirname, 'exports', 'frames');

/* Marker detection, Mac side — see docs/OBJECT-ID-IMPLEMENTATION.md.
   The native build POSTs passthrough camera frames here and this process runs
   OpenCV on them, because the Mac is where OpenCV and a file browser already
   are and the headset is not where you want to iterate on detector constants. */
const DETECTOR      = path.join(__dirname, 'scripts', 'detect_marker.py');
const MARKER_LAYOUT = path.join(__dirname, 'scripts', 'marker-layout.json');
const PYTHON        = process.env.DETECT_PYTHON || 'python3';
const MARKER_LENGTH = process.env.MARKER_LENGTH || '0.040';
/* Detection has a hard deadline: a pose derived from a head position the user
   has already left is worse than no pose. The Kotlin side gives up at 2 s. */
const DETECT_TIMEOUT_MS = 1500;

fs.mkdirSync(EXPORTS, { recursive: true });
fs.mkdirSync(FRAMES,  { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml',
};

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ── marker detection ─────────────────────────────────────────────────────
   Two endpoints, matching the two phases in the implementation notes.

   POST /frame   a JPEG, written to exports/frames for a human to look at.
                 Phase 1: confirm the passthrough frame is right-side-up, from
                 the camera you expect, and usably exposed indoors. Nothing
                 downstream is worth building until that is true.

   POST /detect  a raw 8-bit luma plane, piped to OpenCV, marker pose back as
                 JSON. Phase 2A.

   Both take the frame's geometry and calibration as X- headers so the body
   stays a bare byte block — see DetectionClient.kt. */

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      // A 1280x1280 luma plane is 1.6 MB. Anything far past that is a bug or a
      // stray client, and buffering it would be the server's problem, not its
      // sender's.
      if (total > limit) { reject(new Error(`body over ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let detectorWarned = false;

/** Turn a spawn failure into something that says what to actually do about it. */
function explainPythonFailure(err, stderr) {
  if (err && err.code === 'ENOENT') {
    return {
      reason: `python interpreter '${PYTHON}' not found`,
      hint: 'install Python 3, or set DETECT_PYTHON to its path',
    };
  }
  // macOS ships a python3 stub that is not Python at all until the Xcode
  // licence has been accepted; it exits 69 with this message. Worth naming
  // explicitly because "python3 exists and fails" is otherwise a confusing
  // state to debug.
  if (/xcodebuild -license|Xcode license/i.test(stderr || '')) {
    return {
      reason: 'macOS python3 is the Xcode stub and is unusable',
      hint: 'sudo xcodebuild -license  — or install a real Python and set DETECT_PYTHON',
    };
  }
  return { reason: (err && err.message) || 'detector failed', detail: (stderr || '').trim().slice(0, 400) };
}

function runDetector(headers, body) {
  return new Promise(resolve => {
    const args = [
      DETECTOR,
      '--width',  String(Number(headers['x-width'])  || 0),
      '--height', String(Number(headers['x-height']) || 0),
      '--stride', String(Number(headers['x-row-stride']) || 0),
      '--intrinsics', String(headers['x-intrinsics'] || ''),
      '--distortion', String(headers['x-distortion'] || ''),
      '--marker-length', MARKER_LENGTH,
    ];
    if (fs.existsSync(MARKER_LAYOUT)) args.push('--layout', MARKER_LAYOUT);
    if (process.env.DETECT_DEBUG) args.push('--debug-dir', FRAMES);

    let child;
    try {
      child = spawn(PYTHON, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ found: false, ...explainPythonFailure(e, '') });
      return;
    }

    let out = '', err = '', done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ found: false, reason: `detector exceeded ${DETECT_TIMEOUT_MS}ms` });
    }, DETECT_TIMEOUT_MS);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); finish({ found: false, ...explainPythonFailure(e, err) }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (err.trim()) console.log(`    detector stderr: ${err.trim().slice(0, 300)}`);
      if (code !== 0 && !out.trim()) {
        finish({ found: false, ...explainPythonFailure({ code }, err) });
        return;
      }
      try {
        finish(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        finish({ found: false, reason: 'detector produced no JSON', detail: out.slice(0, 300) });
      }
    });

    // EPIPE if the child died before reading the frame — already handled above.
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

/* ── live reload ──────────────────────────────────────────────────────────
   The headset polls this over the same adb bridge. When a file under public/
   changes, every connected page is told. Saves taking the headset off. */
const liveClients = new Set();
let reloadTimer = null;

fs.watch(ROOT, { recursive: true }, (_evt, file) => {
  if (!file || file.startsWith(".") || file.endsWith("~")) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (liveClients.size) console.log(`  ↻ ${file} changed — notified ${liveClients.size} page(s)`);
    for (const c of liveClients) { try { c.write("data: reload\n\n"); } catch {} }
  }, 120);
});

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Material');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const url = new URL(req.url, 'http://localhost');

  /* ---- sculpture drop-off ------------------------------------------- */
  if (req.method === 'POST' && url.pathname === '/export') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const material = (req.headers['x-material'] || 'clay')
        .toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const file = `clay-${stamp()}-${material}.obj`;
      fs.writeFile(path.join(EXPORTS, file), body, err => {
        if (err) {
          console.error('  ✗ export failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const verts = (body.toString().match(/^v /gm) || []).length;
        const faces = (body.toString().match(/^f /gm) || []).length;
        console.log(`  ✓ ${file}  —  ${verts.toLocaleString()} verts, ${faces.toLocaleString()} tris, ${(body.length/1024).toFixed(0)} KB`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ file, bytes: body.length, verts, faces }));
      });
    });
    return;
  }

  /* ---- passthrough frame, for eyeballing (Phase 1) -------------------- */
  if (req.method === 'POST' && url.pathname === '/frame') {
    readBody(req).then(body => {
      const eye = String(req.headers['x-eye'] || 'unknown').toLowerCase();
      const file = `frame-${stamp()}-${eye}.jpg`;
      fs.writeFile(path.join(FRAMES, file), body, err => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        console.log(`  ✓ ${file}  —  ${(body.length / 1024).toFixed(0)} KB   ${path.join(FRAMES, file)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ file, bytes: body.length }));
      });
    }).catch(e => {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  /* ---- marker detection (Phase 2A) ------------------------------------ */
  if (req.method === 'POST' && url.pathname === '/detect') {
    const t0 = Date.now();
    readBody(req).then(async body => {
      const result = await runDetector(req.headers, body);
      const ms = Date.now() - t0;

      if (result.found) {
        const t = result.tvec || [];
        console.log(`  ● marker ${result.id} (${result.markers} seen)  ` +
          `${t.map(v => v.toFixed(3)).join(', ')} m  ` +
          `err ${Number(result.reprojection_error).toFixed(2)}px  ${ms}ms`);
      } else if (!detectorWarned && result.hint) {
        // Setup problems are printed once, loudly. Repeating them at 5 Hz would
        // bury everything else in the terminal.
        detectorWarned = true;
        console.log(`\n  ⚠  detector unavailable: ${result.reason}`);
        console.log(`     ${result.hint}\n`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, ms }));
    }).catch(e => {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false, reason: e.message }));
    });
    return;
  }

  /* ---- detector health ------------------------------------------------ */
  if (url.pathname === '/detect/status') {
    runDetector({ 'x-width': '0', 'x-height': '0' }, Buffer.alloc(0)).then(r => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        python: PYTHON,
        detector: DETECTOR,
        layout: fs.existsSync(MARKER_LAYOUT) ? MARKER_LAYOUT : null,
        markerLength: Number(MARKER_LENGTH),
        // A "short frame" reply means Python and OpenCV both loaded and the
        // script got as far as validating input, which is the whole health check.
        ready: /short frame|intrinsics/i.test(r.reason || ''),
        probe: r,
      }, null, 2));
    });
    return;
  }

  /* ---- live-reload stream -------------------------------------------- */
  if (url.pathname === "/live") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("retry: 2000\n\n");
    liveClients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
    req.on("close", () => { clearInterval(ping); liveClients.delete(res); });
    return;
  }

  /* ---- static files -------------------------------------------------- */
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — another copy is probably still running.\n  Stop it with:  pkill -f "node serve.js"\n  Or pick another: PORT=8081 ./start.sh\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('');
  console.log('  Digital Clay — dev server');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  headset   http://localhost:${PORT}      (via adb reverse)`);
  console.log(`  this Mac  http://localhost:${PORT}`);
  lan.forEach(a => console.log(`  LAN       http://${a}:${PORT}          (no WebXR — not a secure origin)`));
  console.log(`  exports   ${EXPORTS}`);
  console.log('');
  console.log('  Waiting for sculptures…');
});

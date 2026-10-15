# Digital Clay — Project Notes

Hand-tracked SDF clay sculpting for Meta Quest 3, built as a WebXR app. You start
with a cuboid of clay in passthrough, push the material around with bare hands,
swap what it's made of, and export the result as an OBJ.

**Platform:** Meta Quest 3 (Horizon OS / Android 14) for the headset, macOS
(Apple Silicon) for development.

> **How to read this document.** It began as a status log on 9 September 2026 and
> has been edited for the team. The design reasoning (§2–§4) and the known defect
> (§6) still hold. Anything that reads like a measurement (§5) was re-run when
> this version was written; where the code has moved on since the log, the
> section says so. `git log` and the code are the source of truth.

---

## 1. Where things stand

| | |
|---|---|
| Sculpting in the headset | Working — confirmed on device, 9 Sept 2026 |
| Hand tracking | Working — WebXR hand input, no Meta SDK |
| Passthrough (mixed reality) | Working |
| Materials | Working — 2 in the current build (Soft clay, Stiff clay), they change look *and* feel |
| Export | Working — OBJ posted to the dev server and written to `exports/` |
| Live reload to the headset | Working — over the adb bridge |
| Feel tuning from the URL | Implemented (§4); needs on-device testing |
| Installable APK | Blocked — needs a public HTTPS host (§8) |
| Mesh quality | Known defect — non-manifold cells on freehand surfaces (§6) |

---

## 2. How it got here

**Research (7 Sept).** Surveyed existing VR sculptors, the academic work on VR
clay, the isosurface literature, Quest 3 performance budgets and hand-tracking
accuracy measurements. Conclusion: buildable, and the hard part is not the
geometry but hand tracking degrading in exactly the pose two-handed sculpting
requires.

The most useful finding was a negative result. *Virtual Materiality* (CHI PLAY
'21) built the most physically honest voxel clay of anything surveyed —
mass-conserving, with real bulging — and in their study with eight artists it
**still wasn't preferred over industry software**. Fidelity of simulation is not
the same as quality of tool. That set the priorities: control and predictability
first, physics later.

**WebXR rather than Unity.** On a Mac this is not a compromise: Quest Link (the
live editor preview) is Windows-only, so a Unity loop here means building an APK
for every change. WebXR gives a two-second edit-reload loop, and the feel
questions this project needs to answer take dozens of iterations an hour.

**On device (9 Sept).** Developer Mode enabled, headset authorized over USB, page
pushed to the headset, sculpted, exported. Live reload added so code changes
reach the headset without taking it off.

---

## 3. Architecture

```
hand joints → One Euro filter → SDF stamp → dirty chunks → Surface Nets → mesh
```

**The clay is a signed distance field**, not a mesh and not a physics
simulation. A 64³ grid stores, at each point, the distance to the nearest
surface — negative inside the clay, positive outside, zero exactly on the skin.
Across a 30 cm volume that's a **4.69 mm** voxel.

This choice drives everything else:

- **The starting cuboid is three lines** of box-SDF maths.
- **Topology is free.** Split a limb, merge two blobs, punch a hole — the field
  doesn't care. A mesh-based sculptor would have to repair itself constantly.
- **Add, carve and smooth are one loop** with different arithmetic. A brush is a
  sphere SDF combined into the field with a smooth minimum (add) or smooth
  maximum of the negation (carve).

**Only what you touched gets rebuilt.** The volume is split into 64 chunks of
16³. A stroke marks the chunks it overlapped, and each frame spends a fixed
**3 ms** re-extracting them, finishing the rest next frame. The budget is
time-based rather than a chunk count because the headset's JavaScript runs
several times slower than a Mac's.

**Surface Nets, not Marching Cubes.** Marching Cubes cannot represent sharp
edges — it slices corners off, which is a strange first impression when the user
is looking at the cube you just handed them. Surface Nets places one vertex per
sign-changing cell: fewer triangles, comparable speed, simpler code. (Its
limitation is §6.)

**Display and export use different paths.** Display chunks are extended by one
cell so seams are covered by both neighbours, duplicating about 1% of triangles —
invisible, and it avoids cracks. Export instead runs `buildAll()` once over the
whole volume, producing a single welded mesh with no duplicates.

**Where the code is.** `public/clay.js` holds the volume, brush and surface
extraction and has no three.js or DOM dependency, so it is testable headlessly
and could port to a compute shader. `public/index.html` holds the scene, XR
session, hand input, poke UI and export. `serve.js` is the dev server.

---

## 4. Interaction design

Every choice here traces back to a measurement. Quest 3 hand tracking averages
about **1.73 cm** of positional error under good conditions, with error and
jitter **lowest at the knuckle and highest at the fingertip**, and it degrades
badly under hand-over-hand occlusion — which is exactly what two-handed clay
work looks like.

So:

- **Asymmetric hands.** Right pinch sculpts; left pinch grabs and turns the
  block like a potter's wheel. Keeps the hands out of the same volume.
- **One Euro filtering** — steady when the hand moves slowly (fine detail), low
  lag when it moves fast (broad strokes). A fixed low-pass gives you mush.
- **Pinch hysteresis** — enter at 22 mm, release at 34 mm, so a marginal pinch
  can't chatter mid-stroke.
- **Jump rejection** — a joint that teleports more than 14 cm in one frame
  breaks the stroke rather than gouging the sculpture.
- **Poke buttons, not gestures.** Physical buttons you press with a fingertip
  are far more reliable than gesture recognition when tracking is noisy.
- **Undo is core, not polish.** With ~1.7 cm of uncertainty you *will* make
  strokes you didn't intend. Undo holds 8 steps.
- **Strokes are resampled along their path**, so a fast sweep leaves a continuous
  cut rather than a row of beads.

The `L✓ R✓` readout in the corner shows which hands the headset can currently
see. If it flickers during use, that's the occlusion problem showing up.

### Tuning bench

Feel parameters can be overridden from the URL, so changing one is a reload
rather than an edit:

| Parameter | Default | What it does |
|---|---|---|
| `mc` | 1.5 | One Euro `minCutoff` — smoothing when the hand is slow |
| `beta` | 15 | One Euro `beta` — how fast smoothing relaxes as the hand speeds up |
| `dc` | 2.0 | One Euro derivative cutoff |
| `hz` | 90 | Target display refresh rate (the Quest Browser defaults to 72 unless asked) |
| `probe` | off | `probe=1` shows a raw, unfiltered fingertip marker, to see what the filter is doing |
| `hands` | `mask` | `mask`, `show` (tinted, to check the fit) or `off` |

Example: `http://localhost:8080/?beta=20&mc=1.2&hz=120`. The defaults came out of
the lag-reduction work; **confirm them on a headset before relying on them**, and
treat them as a starting point.

---

## 5. What's verified

`npm test` runs 18 checks, all passing as of this writing:

| Check | Result |
|---|---|
| Starting cuboid extracts a surface | 18,252 triangles, 9,128 verts |
| Cuboid sits at ±9 cm as specified | 0.00 mm corner error |
| Mesh is closed (no open edges) | ✓ |
| Manifold and consistently wound | ✓ for geometric strokes |
| Survives add + carve + a punched hole | ✓ still closed |
| Chunked vs welded extraction agree | bbox delta 0.0000 mm |
| One brush stamp | ~0.43 ms |
| Chunk rebuild | median ~0.1 ms, worst ~1.4 ms |
| Worst-case per-frame remesh | 3.74 ms of an 11.1 ms (90 Hz) frame |
| Whole-volume weld (export only) | ~18 ms |

Timings are from a Mac. The headset is slower, which is why the remesh budget is
a time slice. The tests do not exercise the headset, WebXR or hand tracking —
those were checked by hand on 9 Sept.

---

## 6. Known defect: non-manifold cells

Found from the first real headset session, not from the tests.

An exported sculpture from that session (15,374 verts / 30,776 tris) is
**closed** — no holes — but has **29 non-manifold edges**, edges shared by more
than two faces.

**Cause.** Naive Surface Nets places exactly *one* vertex per cell. Where two
separate sheets of surface pass through the same cell, one vertex cannot
represent both, and the triangles around it fan incorrectly. Rough, heavily
worked surfaces produce this configuration constantly.

**Why the tests missed it.** They sculpted with tidy geometric strokes — a ring
of blobs, a drilled hole. Testing what real freehand work looks like — 400 small
overlapping strokes — reproduced it immediately (103 non-manifold edges in 62,608
triangles, 0.16%). That case is now a permanent regression test, which reports
the ratio rather than pretending it's clean.

**Impact.** Low for viewing, rendering, and importing into most DCC tools — the
mesh is closed and looks correct. It would matter for 3D printing, boolean
operations, or anything requiring a strict manifold.

**Fixes, in increasing order of effort:**
1. Run a cleanup pass in Blender/MeshLab after export — zero code.
2. Add a post-process weld-and-repair step to `buildAll()`.
3. Move to **Manifold Dual Contouring**, which emits multiple vertices per cell
   where the surface requires it. The proper fix, and a significant rewrite.

---

## 7. The toolchain

`tools/` is about **750 MB** and is not in git. `./setup.sh` checks for it and
tells you what's missing. The scripts assume macOS on Apple Silicon.

| Component | Location | Why |
|---|---|---|
| adb + platform-tools | `tools/platform-tools/` | Talk to the headset over USB |
| JDK 17.0.11+9 | `tools/jdk/` | Android's build tools are Java. **Must be 17** — Bubblewrap pins it |
| Android SDK | `tools/android-sdk/` | build-tools 34.0.0, platform-tools, android-34 |
| three.js r169 | `public/vendor/` | Rendering. Vendored so the headset needs no internet |
| Bubblewrap CLI | `node_modules/` | Meta's fork, `@meta-quest/bubblewrap-cli` |
| Signing key | `signing/android.keystore` | Not in git. Lose it and the app can never be updated. Ask Nikki if you need to build a signed APK |

**To rebuild the toolchain from scratch** (if `tools/` is missing):

```bash
# adb
curl -Lo /tmp/pt.zip https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
unzip -q /tmp/pt.zip -d tools/

# JDK 17 (the exact version Bubblewrap expects)
curl -Lo /tmp/jdk.tar.gz "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.11%2B9/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.11_9.tar.gz"
mkdir -p tools/jdk && tar -xzf /tmp/jdk.tar.gz -C tools/jdk

# Android command-line tools
curl -Lo /tmp/asdk.zip https://dl.google.com/android/repository/commandlinetools-mac-6609375_latest.zip
mkdir -p tools/android-sdk && unzip -q /tmp/asdk.zip -d tools/android-sdk

export JAVA_HOME="$PWD/tools/jdk/jdk-17.0.11+9/Contents/Home"
yes | tools/android-sdk/tools/bin/sdkmanager --sdk_root="$PWD/tools/android-sdk" --licenses
tools/android-sdk/tools/bin/sdkmanager --sdk_root="$PWD/tools/android-sdk" \
  "build-tools;34.0.0" "platforms;android-34" "platform-tools"

./setup.sh
```

**Moving the project.** Everything uses relative paths except Bubblewrap's global
config at `~/.bubblewrap/config.json`, which holds absolute tool paths. Run
**`./setup.sh`** after moving or cloning and it rewrites itself; `build-apk.sh`
also detects a stale config and repairs it.

---

## 8. Turning it into an installed app

The browser is the development loop. To get an icon in the headset's library, the
app is packaged as a **PWA inside a Trusted Web Activity** — an APK that is a
full-screen window onto a hosted website.

The packaging scripts are written and `npx bubblewrap doctor` reports the
toolchain valid. **One thing blocks it: a public HTTPS address.** A TWA points at
a hosted site; the files can't be bundled inside the APK.

A trap worth knowing: **Digital Asset Links is only ever read from the origin
root**, `https://host/.well-known/assetlinks.json`. A GitHub Pages *project* site
(`you.github.io/repo/`) cannot serve that. You need a whole origin — a
`<name>.github.io` user site, or Netlify / Cloudflare Pages. Meta's docs are
blunt: an immersive PWA does not launch if this verification fails.
`scripts/prepare-apk.mjs` warns if you give it a URL with a path.

Then:

```bash
node scripts/prepare-apk.mjs https://your-site/   # writes twa-manifest.json + assetlinks.json
# republish public/ so assetlinks.json is live at the origin root
./build-apk.sh                                    # Gradle compiles and signs
npm run headset:install
```

**The Gradle build has never been run** — it needs a real URL. Expect the first
run to take several minutes and appear stuck. It isn't.

---

## 9. What's next

In rough order of what each buys you:

1. **Rest the block on a real table** via WebXR `plane-detection`. When the
   clay's surface coincides with a physical tabletop, your hand gets genuine
   force feedback from a real object — the closest thing to haptics available
   without hardware, better tracking posture, and less arm fatigue.
2. **Two-handed grab** for free rotation and scale. Currently the left hand
   translates freely but only spins around Y.
3. **Contact audio** scaled by stroke velocity. The cheapest perceived-materiality
   win available — worth more than another 10 ms of physics.
4. **Fix the manifold defect** (§6) if export quality starts to matter.
5. **Host it and build the APK** (§8).
6. **Move to GPU compute** — WebGPU, or a Unity port. Only when the CPU becomes
   the limit; `public/clay.js` was deliberately written free of three.js and the
   DOM so it ports cleanly.

**Open questions for the team:**

- **Scale.** Is this a 30 cm object on a table or something room-scale? Voxel
  count is fixed, so world size and detail trade directly against each other.
- **Watertight?** If 3D printing is ever in scope, §6 stops being cosmetic.
- **Texture painting?** Per-voxel colour roughly triples volume memory and
  changes the export format. Decide before increasing resolution, not after.

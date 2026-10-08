# Digital Clay — Quest 3 prototype

A hand-tracked SDF sculpting spike. You start with a cuboid of clay floating in
passthrough, pinch to push material around, and press EXPORT to drop an OBJ onto
this Mac.

**Working on device as of 9 September 2026.** Full write-up in
[docs/PROGRESS.md](docs/PROGRESS.md).

This is **Phase 1–2 of the build plan**, taken as far as WebXR allows: it proves
the interaction and the geometry pipeline without a Unity install. The
production path is still Unity + compute shaders — see the caveats at the bottom.

---

## Run it

```bash
cd /path/to/DigitalClay
./setup.sh     # first time, or after moving the folder
./start.sh
```

Then, in the headset, open the **Meta Quest Browser** and go to
`http://localhost:8080` → **Enter passthrough**.

`localhost` is doing real work there. WebXR refuses to run outside a secure
context, and `adb reverse` makes the Mac's server appear to the headset as
localhost — which counts as secure. Typing the Mac's LAN IP instead gives you a
plain-HTTP origin and the Enter button will stay dark.

You can also just open `http://localhost:8080` on the Mac. You get a desktop
preview of the block — drag to turn it — which is the fastest way to check a
change without putting the headset on.

### First-time headset setup

Only you can do this part:

1. **Meta Horizon phone app** → your Quest 3 → *Headset settings* → **Developer Mode → ON**.
   This needs a verified developer *organisation* at `developers.meta.com`, not
   just an account — creating one asks for 2FA or a card on file.
2. **Reboot the headset.**
3. Plug in with a USB-C cable that carries **data** (many charging cables don't).
4. Put the headset on and accept **Allow USB debugging** — tick *Always allow*.
5. Re-run `./start.sh`; it should print `✓ bridged`.

Also make sure **Settings → Movement tracking → Hand tracking** is on in the
headset, and set *Hand tracking frequency* to **High** if it's offered.

---

## What is where

```
DigitalClay/
├── README.md              you are here — how to run it
├── docs/PROGRESS.md       full write-up: architecture, findings, next steps
├── setup.sh               run after moving the folder
├── start.sh               bridge the headset + serve + open the page
├── build-apk.sh           package as an installable APK
├── serve.js               dev server, export endpoint, live reload
├── public/                the app itself
│   ├── index.html         scene, XR session, hand input, poke UI
│   ├── clay.js            volume, brush, Surface Nets (no three.js, no DOM)
│   ├── sw.js              service worker
│   └── vendor/            three.js r169
├── scripts/               APK preparation
├── test/                  headless geometry checks — npm test
├── media/                 headset recordings
├── exports/               sculptures you export
├── signing/               APK signing key — BACK THIS UP
└── tools/                 adb, JDK 17, Android SDK (~750 MB, not in git)
```

### Moving this folder

Everything uses relative paths except Bubblewrap's global config at
`~/.bubblewrap/config.json`, which stores absolute tool paths. After moving or
copying the project, run:

```bash
./setup.sh
```

It repoints that config, fixes permissions, and installs npm dependencies if
needed. `build-apk.sh` also detects a stale config and repairs it on its own.
This has been tested by moving the whole folder and confirming tests, bubblewrap
and the server all still work.

---

## Testing on the headset

The app runs **inside the headset**, in the Quest Browser — the Chromium-based
browser that ships with Horizon OS, sitting in your app library next to
everything else. WebXR is a browser standard, so a web page there can ask to go
immersive and take over the display, with real passthrough and real hand
tracking. This Mac only serves the file; nothing about the tracking is simulated.

`./start.sh` pushes the URL to the headset for you (`adb shell am start`), so you
should not have to type an address on a virtual keyboard. If that fails, open
**Browser** in the headset and type `localhost:8080`.

The page first appears as a flat window floating in your space. Press **Enter
passthrough** and it goes immersive. Press the **Meta button** to drop back out.

**Hand tracking must be on:** headset *Settings → Movement tracking → Hand
tracking*. Turn on *Auto Switch* too, so putting the controllers down switches to
hands automatically. No browser flags are needed — WebXR hand tracking is enabled
by default in the Quest Browser.

**Debugging.** With the headset bridged, open Chrome on this Mac at
`chrome://inspect` → *Devices*. The headset tab is listed; click **inspect** for
full DevTools against the live session — console, breakpoints, network. This is
the most useful thing to have open while tuning tracking behaviour.

The status readout top-right shows frames per second, triangle count, remesh
milliseconds, current tool and material, and `L✓ R✓` for which hands the headset
can currently see. Watch that last one: if it flickers to `L· R·` while you
sculpt, tracking is dropping out and the filter settings need work.

---

## Making it a real installed app (APK)

The browser loop above is for iterating. This turns the same code into an app
with its own icon that launches straight into passthrough.

**Everything on this Mac is already done.** Installed and verified:

| | |
|---|---|
| JDK 17.0.11 | `tools/jdk/` — Android's build tools are Java |
| Android SDK | `tools/android-sdk/` — build-tools 34.0.0, platform-tools, android-34 |
| Bubblewrap CLI | Meta's fork, `@meta-quest/bubblewrap-cli` |
| Signing key | `signing/android.keystore` — **back this up** |
| PWA manifest + service worker | `public/manifest.webmanifest`, `public/sw.js` |
| App icons | `public/icons/` |

`npx bubblewrap doctor` reports the toolchain is valid.

### The one thing left: a web address

A Trusted Web Activity is a window onto a *hosted* website — the files can't be
bundled inside the APK. So the app needs to live at an HTTPS URL first.

**It must be the root of an origin.** Digital Asset Links is only ever read from
`https://<host>/.well-known/assetlinks.json`, so a GitHub Pages *project* site
(`you.github.io/repo/`) will not work — you can't put a file at that origin's
root. Use one of:

- a **`<name>.github.io`** user site repo
- **Netlify** or **Cloudflare Pages** — both hand you your own subdomain free

Publish the contents of `public/` there.

### Then

```bash
node scripts/prepare-apk.mjs https://your-site/    # writes twa-manifest.json + assetlinks.json
# re-publish public/ so assetlinks.json is live at the origin root
./build-apk.sh                                     # Gradle compiles and signs
./tools/platform-tools/adb install -r app-release-signed.apk
```

`prepare-apk.mjs` reads the SHA-256 fingerprint out of your keystore and writes
both halves of the handshake: the APK claims it represents your site, and
`assetlinks.json` on your site names the exact key allowed to make that claim.
`build-apk.sh` checks that file is actually live before building, because a
missing one fails *silently at launch* rather than at build time.

The first Gradle run downloads its own dependencies and takes several minutes.
It is not stuck.

### Not yet verified

The Gradle build itself has never been run — it needs a real hosted URL, so it
stays untested until you have one. Everything upstream of it is confirmed
working.

---

## What I can push, and what always needs your hand

Once Developer Mode is on and the headset is plugged in, most of the loop is
remote. The exception is worth knowing up front.

| Action | Remote? | How |
|---|---|---|
| Change the code and have the headset pick it up | **Yes** | Live reload, below |
| Open the app in the headset browser | **Yes** | `npm run headset:open` |
| Read console errors and stack traces | **Yes** | `npm run headset:log`, or Chrome `chrome://inspect` |
| Install an APK | **Yes** | `npm run headset:install` |
| Launch an installed app | **Yes** | `adb shell am start -n <package>/<activity>` |
| **Press "Enter passthrough"** | **No** | You. Every time. |

That last row is not a tooling gap — WebXR deliberately requires a real user
gesture to start an immersive session, so a page can never grab your display on
its own. No amount of adb changes it. Everything *else* is automatable.

### Live reload

`serve.js` watches `public/` and holds an event stream open to the headset over
the same adb bridge. Save a file and the page hears about it immediately.

- **Not in a session** — the page reloads itself. Nothing to do.
- **Mid-session** — reloading would end your XR session and you'd have to press
  Enter again, so instead the **RELOAD** button on the floating panel lights
  amber and a message flashes. One poke when you're ready.

So the realistic loop is: press Enter once, sculpt, and poke RELOAD whenever you
want the newest code. The headset stays on your head.

The service worker is deliberately **network-first** for this reason — cache-first
would happily serve you yesterday's code while you wondered why your edit did
nothing.

### Headset commands

```bash
npm run headset          # is it connected?
npm run headset:bridge   # adb reverse, so localhost:8080 reaches this Mac
npm run headset:open     # launch the browser straight at the page
npm run headset:log      # stream browser console output to this terminal
npm run headset:shot     # grab a screenshot (best effort — may not capture the immersive view)
npm run headset:install  # install the built APK
```

`./start.sh` already does bridge and open for you.

---

## Using it

| | |
|---|---|
| **Right pinch** (thumb + index) | Sculpt with the current tool |
| **Left pinch** | Grab the block — move it, and swipe sideways to turn it |
| **Poke** the floating panel | TOOL · MATERIAL · UNDO · EXPORT · RELOAD |
| **Controllers** | Trigger does the same thing, if hands are being uncooperative |

Tools cycle **Add → Carve → Smooth**. Materials cycle **Wet stoneware → Oil
plasticine → Warm wax → Plaster**, which changes both the look and the feel —
`smoothK` is how readily material fuses to itself, `rate` is how much it resists
a single stroke. Plaster is stiff and barely blends; wet stoneware takes
everything.

EXPORT posts the mesh to the server, which writes it to `exports/` on this Mac
with a timestamp and the material name. Watch the terminal — it prints vertex and
triangle counts on each save.

---

## How it works

```
hand joints → One Euro filter → SDF stamp → dirty chunks → Surface Nets → mesh
```

- **`public/clay.js`** — the volume, the brush, and the surface extraction. No
  three.js, no DOM, so it can be tested headlessly. This is the file that
  eventually becomes a compute shader.
- **`public/index.html`** — scene, XR session, hand input, poke UI, export.
- **`serve.js`** — static server plus `POST /export`.
- **`test/clay.test.mjs`** — the checks below.

The clay is a 64³ signed distance field (4.69 mm voxels across a 30 cm volume),
negative inside. Brushes are sphere SDFs combined with smooth min/max, so add,
carve and smooth are one loop with different maths. The volume is split into 64
chunks of 16³; a stroke marks only the chunks it touched, and each frame spends
a fixed **3 ms** re-extracting them and finishes the rest next frame.

Display chunks are extended by one cell so seams are covered by both neighbours,
which duplicates about 0.6% of the triangles. Export doesn't use them — it runs
`buildAll()` over the whole volume once, producing a single welded mesh.

### Verified before you put it on

```
npm test
```

All 18 checks pass on this machine:

- the starting cuboid extracts to 18,252 triangles, sitting at ±9 cm with
  **0.00 mm** corner error
- the mesh is **closed** in every case tested, including after add, carve,
  smooth, and a hole punched clean through the block
- it is manifold for geometric strokes, but **not** for real freehand work —
  see Known limits
- chunked and welded extraction occupy the same space to within 0.0000 mm
- one brush stamp: **0.44 ms**; median chunk rebuild **0.28 ms**, worst **2.12 ms**
- whole-volume weld for export: **~18 ms**, off the hot path

Those timings are from the Mac. The headset's JS runs several times slower, which
is exactly why the remesh budget is a time slice rather than a chunk count.

---

## Known limits of this spike

- **Non-manifold cells on freehand surfaces.** Found from the first real headset
  session. Exported meshes are closed, but rough sculpting produces edges shared
  by more than two faces — about 0.16% of triangles. Harmless for viewing and
  most DCC import; a problem for 3D printing or booleans. Cause and three
  possible fixes in [docs/PROGRESS.md §6](docs/PROGRESS.md).

- **It's JavaScript on the CPU.** The brief's architecture puts the field and the
  extraction on the GPU. Expect this to feel good but not fast, and expect the
  ceiling to be well below what Unity + compute would give you.
- **Turntable rotation only.** The left hand translates freely but spins the
  block around Y from sideways motion. Full two-handed rotate/scale is the
  obvious next addition.
- **No MRUK plane detection**, so the block floats rather than resting on a real
  table. The table-anchored version — where the physical tabletop provides real
  haptic feedback — is the idea most worth building next, and WebXR's
  `plane-detection` can do a first pass of it.
- **Undo holds 8 steps**, each a full 1.1 MB copy of the field.
- **Export is OBJ only.** glTF is a better target; OBJ was chosen here because it
  is fifty lines and has no dependencies.

## Next

In rough order of what each buys you:

1. Rest the block on a real table via WebXR `plane-detection` — real haptics, better tracking posture, less arm fatigue.
2. Two-handed grab for free rotate and scale.
3. Contact audio scaled by stroke velocity. Cheapest perceived-materiality win available.
4. Move the field and Surface Nets to WebGPU compute, or start the Unity port.

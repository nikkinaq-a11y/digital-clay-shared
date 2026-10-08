#!/usr/bin/env python3
"""
Digital Clay — marker detection, Mac side.

Reads one raw 8-bit luma frame from stdin, finds the fiducial marker on the clay
block's base, and prints the marker's 6-DoF pose as JSON on stdout.

This is the compute half of the tether described in
docs/OBJECT-ID-IMPLEMENTATION.md: the headset captures and displays, the Mac
runs OpenCV. It is invoked by serve.js per detection request, at a few hertz,
over `adb reverse`.

Input
    stdin      width*height (or stride*height) bytes of 8-bit luma, no header
    argv       --width --height --stride --intrinsics fx,fy,cx,cy,skew
               --distortion k1,k2,k3,p1,p2   (Android order; reordered below)
               --marker-length metres        --dict 4X4_50
               --layout path/to/marker-layout.json   (optional, multi-marker)

Output (stdout, one line of JSON)
    {"found": true, "id": 7, "rvec": [...], "tvec": [...],
     "reprojection_error": 0.31, "corners": [[x,y],...], "markers": 4}
    {"found": false, "reason": "no markers detected"}

Everything it prints on stderr is diagnostic and is surfaced by serve.js.

## Why the pose comes from here and not from the headset

Nothing about ArUco needs a Mac. What needs a Mac is *iterating* on it: marker
size, dictionary, exposure, which corner refinement, whether the base plate is
too glossy under a desk lamp. Each of those is a one-line change here versus a
Gradle build, an APK install and putting the headset back on. The on-device port
in §5 of the notes is a real step, and it should happen after these constants
have stopped moving, not before.
"""

import argparse
import json
import os
import sys

MIN_OPENCV = (4, 7)


def fail(reason, **extra):
    """Every exit path is a JSON line, so the Kotlin side never has to guess."""
    out = {"found": False, "reason": reason}
    out.update(extra)
    print(json.dumps(out))
    sys.exit(0)


def parse_floats(s, n, name):
    if not s:
        return None
    parts = [p for p in s.replace(" ", "").split(",") if p]
    try:
        vals = [float(p) for p in parts]
    except ValueError:
        fail(f"{name} is not a list of numbers: {s!r}")
    if len(vals) < n:
        return None
    return vals[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--stride", type=int, default=0)
    ap.add_argument("--intrinsics", default="")
    ap.add_argument("--distortion", default="")
    ap.add_argument("--marker-length", type=float, default=0.04)
    ap.add_argument("--dict", default="4X4_50")
    ap.add_argument("--layout", default="")
    ap.add_argument("--debug-dir", default="")
    args = ap.parse_args()

    try:
        import numpy as np
        import cv2
    except ImportError as e:
        fail(
            "opencv/numpy not installed on the Mac",
            hint="python3 -m pip install opencv-contrib-python numpy",
            detail=str(e),
        )

    if tuple(int(x) for x in cv2.__version__.split(".")[:2]) < MIN_OPENCV:
        fail(
            f"opencv {cv2.__version__} is too old for the ArUco API used here",
            hint="python3 -m pip install -U opencv-contrib-python",
        )

    w, h = args.width, args.height
    stride = args.stride or w

    raw = sys.stdin.buffer.read()
    expected = stride * h
    if len(raw) < expected:
        fail(f"short frame: got {len(raw)} bytes, expected {expected} "
             f"({stride} stride x {h} rows)")

    # The Y plane arrives with the camera's row stride, which is not the image
    # width. Reshaping to (h, w) directly would shear the picture into diagonal
    # garbage — markers would simply never be found, with no error to explain it.
    gray = np.frombuffer(raw[:expected], dtype=np.uint8).reshape(h, stride)[:, :w]
    gray = np.ascontiguousarray(gray)

    # ── camera model ────────────────────────────────────────────────────────
    intr = parse_floats(args.intrinsics, 5, "intrinsics")
    if not intr or intr[0] <= 0 or intr[1] <= 0:
        fail("no usable camera intrinsics — the headset reported none",
             hint="calibrate once with a checkerboard and pass them in, "
                  "or check LENS_INTRINSIC_CALIBRATION in the PCA log line")
    fx, fy, cx, cy, skew = intr
    K = np.array([[fx, skew, cx],
                  [0.0, fy,   cy],
                  [0.0, 0.0,  1.0]], dtype=np.float64)

    # Android reports LENS_DISTORTION as [k1, k2, k3, p1, p2].
    # OpenCV wants                        [k1, k2, p1, p2, k3].
    # Passing Android's order straight through puts the tangential terms in the
    # radial slots. It does not throw and it does not look obviously wrong — it
    # biases the pose by a few millimetres that grow toward the frame edges,
    # which reads as "tracking is a bit off near the edge of view" rather than
    # as a bug. Hence this reorder, spelled out rather than done inline.
    dist_android = parse_floats(args.distortion, 5, "distortion")
    if dist_android:
        k1, k2, k3, p1, p2 = dist_android
        dist = np.array([k1, k2, p1, p2, k3], dtype=np.float64)
    else:
        dist = np.zeros(5, dtype=np.float64)

    # ── detect ──────────────────────────────────────────────────────────────
    dict_name = "DICT_" + args.dict
    if not hasattr(cv2.aruco, dict_name):
        fail(f"unknown dictionary {args.dict}")
    aruco_dict = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dict_name))

    params = cv2.aruco.DetectorParameters()
    # Sub-pixel corner refinement. The pose of a small marker is far more
    # sensitive to corner accuracy than to anything else in this pipeline, and
    # the passthrough cameras are low-contrast indoors; without this the pose
    # jitters by centimetres at arm's length.
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX

    detector = cv2.aruco.ArucoDetector(aruco_dict, params)
    corners, ids, _ = detector.detectMarkers(gray)

    if ids is None or len(ids) == 0:
        fail("no markers detected", markers=0)

    ids = ids.flatten()

    if args.debug_dir:
        try:
            os.makedirs(args.debug_dir, exist_ok=True)
            vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            cv2.aruco.drawDetectedMarkers(vis, corners, ids.reshape(-1, 1))
            cv2.imwrite(os.path.join(args.debug_dir, "last-detection.png"), vis)
        except Exception as e:  # diagnostics must never break detection
            print(f"debug write failed: {e}", file=sys.stderr)

    # ── build the 3D/2D correspondences ─────────────────────────────────────
    #
    # A single marker gives four coplanar points, which is the minimum for a
    # pose and the worst case for stability: the planar ambiguity means two
    # different orientations reproject almost identically, and the solver flips
    # between them. Several markers on one rigid base plate fix that outright,
    # because the corners are no longer a single small square.
    #
    # The layout file is therefore the recommended setup, not a nicety. It also
    # solves the other problem with putting a marker on clay: clay deforms, and
    # a marker stuck to the part being sculpted stops being planar and gets
    # covered in slip. The markers belong on a rigid base the block sits on.
    layout = None
    if args.layout:
        try:
            with open(args.layout) as f:
                layout = json.load(f)
        except FileNotFoundError:
            layout = None
        except (OSError, json.JSONDecodeError) as e:
            fail(f"could not read layout {args.layout}: {e}")

    half = args.marker_length / 2.0
    # Marker-local corner order matches OpenCV's detector output:
    # top-left, top-right, bottom-right, bottom-left, z out of the marker.
    base_corners = np.array([
        [-half,  half, 0.0],
        [ half,  half, 0.0],
        [ half, -half, 0.0],
        [-half, -half, 0.0],
    ], dtype=np.float64)

    obj_pts, img_pts, used = [], [], []

    if layout and "markers" in layout:
        placements = {int(m["id"]): m for m in layout["markers"]}
        for mid, quad in zip(ids, corners):
            place = placements.get(int(mid))
            if place is None:
                continue
            size = float(place.get("size", args.marker_length))
            hs = size / 2.0
            local = np.array([
                [-hs,  hs, 0.0], [hs,  hs, 0.0],
                [ hs, -hs, 0.0], [-hs, -hs, 0.0],
            ], dtype=np.float64)
            origin = np.array(place["position"], dtype=np.float64)
            # Optional in-plane rotation of this tile on the base, degrees.
            theta = np.deg2rad(float(place.get("rotation", 0.0)))
            c, s = np.cos(theta), np.sin(theta)
            R = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
            obj_pts.append((local @ R.T) + origin)
            img_pts.append(quad.reshape(4, 2))
            used.append(int(mid))
    else:
        # No layout: use the lowest id present, deterministically. Picking
        # whichever the detector happened to list first would make the anchor
        # jump between markers as they come in and out of view.
        order = int(np.argmin(ids))
        obj_pts.append(base_corners)
        img_pts.append(corners[order].reshape(4, 2))
        used.append(int(ids[order]))

    if not obj_pts:
        fail("markers found but none are in the layout",
             markers=len(ids), seen=[int(i) for i in ids])

    obj = np.concatenate(obj_pts).astype(np.float64)
    img = np.concatenate(img_pts).astype(np.float64)

    # IPPE_SQUARE is the right solver for exactly four coplanar points; for a
    # multi-marker board the points are no longer a single square, so the
    # general iterative solver applies.
    flags = cv2.SOLVEPNP_IPPE_SQUARE if len(obj) == 4 else cv2.SOLVEPNP_ITERATIVE
    ok, rvec, tvec = cv2.solvePnP(obj, img, K, dist, flags=flags)
    if not ok:
        fail("solvePnP failed", markers=len(ids))

    # Refine, then measure. The reprojection error is the quality gate the
    # Kotlin PoseFilter rejects on, so it has to describe the pose actually
    # being returned.
    rvec, tvec = cv2.solvePnPRefineLM(obj, img, K, dist, rvec, tvec)
    proj, _ = cv2.projectPoints(obj, rvec, tvec, K, dist)
    err = float(np.mean(np.linalg.norm(proj.reshape(-1, 2) - img, axis=1)))

    print(json.dumps({
        "found": True,
        "id": used[0],
        "markers": len(used),
        "ids": used,
        "rvec": [float(v) for v in rvec.flatten()],
        "tvec": [float(v) for v in tvec.flatten()],
        "reprojection_error": err,
        "corners": [[float(x), float(y)] for x, y in img],
    }))


if __name__ == "__main__":
    main()

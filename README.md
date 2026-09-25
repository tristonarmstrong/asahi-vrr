# asahi-vrr

Adaptive Sync/ProMotion investigation for the Apple M1 Pro internal panel on
Fedora Asahi Remix.

This is a personal record, not an upstream submission.

## What is here

- [`PROGRESS.md`](PROGRESS.md) — the full write-up: the three driver fixes, the
  synthetic EDID, the mutter experiment, and the measurements.
- [`asahi-vrr.patch`](asahi-vrr.patch) — the drm/apple driver changes against
  `chadmed/linux` branch `dcp/vrr` base `8a808006a`, including temporary debug
  instrumentation.
- [`mutter-vrr.patch`](mutter-vrr.patch) — the mutter 50.5 changes that wire the
  panel's minimum refresh rate into the frame-clock idle target.

## Headline

The driver advertises variable refresh to the compositor, applies it without
breaking page flips, and supplies a conformant synthetic EDID advertising the
panel's 24–120 Hz range. A patched mutter reads that range and idles at 24 Hz
for fullscreen content. The plain desktop does not use mutter's VRR path, so the
patch does not change it.

## Hardware and software

- MacBookPro18,3 (14-inch M1 Pro, device tree `j314`), internal eDP panel
  3024×1964 @ 120 Hz.
- Kernel base `8a808006a` (7.0.11) from `chadmed/linux` branch `dcp/vrr`.
- DCP firmware compatibility version 13.5.
- GNOME 50.5 / mutter 50.5 on Fedora Asahi Remix 44.

## Applying the patches

From a clean checkout of `chadmed/linux` at `dcp/vrr`:

```
git apply asahi-vrr.patch
```

From a mutter 50.5 source tree:

```
patch -p1 < mutter-vrr.patch
```

# asahi-vrr

Adaptive Sync/ProMotion investigation for the Apple M1 Pro internal panel on
Fedora Asahi Remix.

This is a personal record, not an upstream submission.

## What is here

- [`PROGRESS.md`](PROGRESS.md) — full write-up: the three driver fixes, the
  measurements, and the mutter limitation that remains.
- [`asahi-vrr.patch`](asahi-vrr.patch) — the drm/apple driver changes as a
  patch against `chadmed/linux` branch `dcp/vrr` base `8a808006a`, including
  temporary debug instrumentation.

## Headline

The driver now advertises variable refresh to the compositor, applies it
without breaking page flips, and supplies a synthetic EDID so userspace can read
the panel's refresh range. The panel already throttles itself to roughly
24–30 Hz at idle. The remaining gap is a hardcoded 30 Hz floor in mutter's
frame clock, which needs a mutter change.

## Hardware and software

- MacBookPro18,3 (14-inch M1 Pro, device tree `j314`), internal eDP panel
  3024×1964 @ 120 Hz.
- Kernel base `8a808006a` (7.0.11) from `chadmed/linux` branch `dcp/vrr`.
- DCP firmware compatibility version 13.5.
- GNOME 50.5 / mutter 50.5 on Fedora Asahi Remix 44.

## Applying the patch

From a clean checkout of `chadmed/linux` at `dcp/vrr`:

```
git apply asahi-vrr.patch
```

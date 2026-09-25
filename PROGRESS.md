# Variable refresh on the Apple M1 Pro internal panel: three fixes, one mutter limitation

Bottom line: the driver now exposes variable refresh to userspace and applies it
without breaking page flips, and the panel already throttles itself to roughly
24–30 Hz when the desktop is idle. The remaining gap is a hardcoded 30 Hz floor
inside mutter, not the kernel. Fixing it requires a one-line-class change to
mutter, which upstream has not made as of GNOME 50.5.

Test hardware: MacBookPro18,3 (14-inch M1 Pro, device tree `j314`), internal eDP
panel at 3024×1964 @ 120 Hz. Kernel tree: a clone of `AsahiLinux/linux`, branch
`dcp/vrr`, base `8a808006a` (7.0.11), plus local work. DCP firmware compatibility
version 13.5.

## What we set out to do

Apple calls this panel's feature ProMotion. On macOS the display drops to a low
refresh rate when little changes and rises to 120 Hz under motion. We wanted the
same on Fedora Asahi Remix.

The starting point was chadmed's open PR [AsahiLinux/linux#477](https://github.com/AsahiLinux/linux/pull/477),
"drm: apple: Adaptive Sync/ProMotion". Its review thread contained the key
skepticism from jannau: *"How did you verify this does anything at all on
MacBook Pro internal displays? I would expect that this does nothing without
EDID with adaptive sync data."* That comment turned out to be correct, and
finding out why produced most of the work below.

## Fix 1: advertise VRR capable to the compositor

mutter only offers variable refresh for an output whose DRM connector reports
`vrr_capable`. The driver set that property at connector creation, before the
DCP had parsed any display modes, so `dcp_has_vrr_mode()` always returned false
and the property stayed at 0.

The connector now advertises `vrr_capable` once modes are available, from
`dcpep_process_chunks()` and from `dcp_hotplug()`. After this change mutter
exposes `+vrr` variants of every mode:

```
3024x1964@120.000+vrr     refresh-rate-mode: variable
```

## Fix 2: apply adaptive sync without a forced modeset

The PR left this in `dcp_crtc_atomic_check()`:

```c
// if (dcp->vrr_enabled != crtc_state->vrr_enabled) {
//     crtc_state->mode_changed = true;
// }
```

Re-enabling it looked correct: a VRR toggle changes the CRTC's output timing, so
it should be a modeset. But mutter toggles `VRR_ENABLED` through a **page-flip**
atomic commit, not a modeset. A page-flip that requires a modeset is rejected,
and the kernel log showed why nothing happened:

```
gnome-shell: Page flip failed: drmModeAtomicCommit: Invalid argument
```

The fix removes the forced `mode_changed` and applies the Adaptive Sync
parameter live from the CRTC flush path in `dcp_apply_vrr_flush()`. It sends the
`IOMFBPARAM_ADAPTIVE_SYNC` parameter only when the requested state differs from
the current one, and it never turns the commit into a modeset. After this change
mutter's fullscreen toggle produces a clean sequence with no page-flip failures:

```
atomic_check: VRR requested 0 -> 1 (applied in flush)
adaptive_sync: sending minRR 1572864 mediaTargetRate 0 fractional 0
```

`1572864` is `24 << 16`, the panel's minimum VRR rate. The firmware confirms it
received the request:

```
FramebufferDCP.cpp:5931: IOMFBParameter_adaptive_sync Req minRR = 0x180000
```

## Fix 3: a synthetic EDID so userspace can read the refresh range

This is the fix jannau's review comment was pointing at.

The internal panel has no EDID. `dcp_start()` skips the DCPAV service that
fetches EDID for panel-type outputs:

```c
if (unstable_edid && !dcp_has_panel(dcp)) {
```

mutter reads the panel's minimum refresh rate from EDID. In
`meta_output_info_get_min_refresh_rate()` it requires `output_info->edid_info`
and returns false without one; the min rate comes only from the EDID Display
Range Limits descriptor. No EDID means no minimum, and mutter then falls back to
a hardcoded value.

The driver now builds a minimal 128-byte EDID for the internal panel with a
Display Range Limits descriptor for 24–120 Hz. The kernel exposes it as the
connector's EDID, and mutter parses it. The vendor string in mutter's DisplayConfig
D-Bus output changes from `unknown` to `APP`, and the raw EDID at
`/sys/class/drm/card2-eDP-1/edid` carries bytes `0x18` (24) and `0x78` (120) at
the range-limits offsets.

## What the measurements actually show

We measured the true present interval using the timestamp the driver attaches to
each page-flip event, which is the value mutter's frame clock consumes. The
panel follows the submitted content rate in every configuration:

| content framerate | 120 Hz +VRR | 120 Hz fixed | 60 Hz fixed |
|-------------------|-------------|--------------|-------------|
| 30 fps            | 32 ms       | 32 ms        | —           |
| 60 fps            | 17 ms       | 17 ms        | —           |
| 90 fps            | 11 ms       | 12 ms        | 18 ms       |
| 120 fps           | 9 ms        | 9 ms         | —           |

Two conclusions:

1. A fixed mode is a real ceiling. On the 60 Hz mode, 90 fps content is clamped
   to about 56 Hz. The panel is not free-running.
2. Below the mode's rate, the panel follows content on its own. 30 fps content
   presents at 30 Hz even on the 120 Hz fixed mode.

The second point matters for the original goal. At idle the desktop presents at
about 24–30 Hz regardless of mode or VRR:

| idle configuration | mean present interval |
|--------------------|-----------------------|
| 120 Hz fixed       | ~25 Hz                |
| 60 Hz fixed        | ~24 Hz                |
| 48 Hz fixed        | ~31 Hz                |
| 120 Hz +VRR        | ~27 Hz                |

A 60 Hz fixed mode idling at 24 Hz is not possible for a panel that scans at a
fixed rate. The DCP presents only when content changes and holds the frame
otherwise. The display already does most of what ProMotion does.

Toggling `VRR_ENABLED`, setting or clearing `minRR`, and disabling the swap
timestamps all produced the same present interval. On this panel those controls
have no measurable effect on pacing.

## The remaining gap is in mutter

The idle cadence is close to the target but not clean. The present intervals
quantize to multiples of 8.33 ms (the 120 Hz grid) and jitter between 8 and
50 ms. They do not settle on a steady 41.6 ms, the panel's 24 Hz minimum.

The cause is a hardcoded constant. mutter's frame clock throttles the idle
target to `maximum_refresh_interval_us`, and that field is set once at
construction from:

```c
#define MINIMUM_REFRESH_RATE 30.f
```

`clutter-frame-clock.c` line 48 defines it and line 2188 uses it; no setter
exists, and the value is still hardcoded in mutter's `main` branch. mutter does
compute a real `max_refresh_interval_us` from the output's minimum refresh rate
in `meta-kms-crtc.c`, but it uses that only for KMS commit deadline scheduling,
not for the frame-clock throttle target. The two paths are disconnected.

With the synthetic EDID in place, mutter has the correct 24 Hz minimum but
still throttles to a 30 Hz target that does not align with the panel's 8.33 ms
grid. That misalignment is the jitter.

The fix is small and belongs in mutter:

1. Add a setter for `ClutterFrameClock`'s maximum refresh interval.
2. Set it from the output's minimum refresh rate when VRR is active, replacing
   the hardcoded 30 Hz floor.

Fedora ships `mutter-50.5-1.fc44.src`, and the source repositories are enabled,
so a patched build is feasible.

## State of the work

The driver changes are committed and cannot be lost:

- Branch `dcp/vrr`, commit `de54e7411` "drm: apple: apply VRR live in flush path
  instead of forced modeset".
- Safety mirror branch `vrr-mutter-work-20260924`.

The commit contains the three fixes above plus temporary debug instrumentation
(`apple_ts_mode`, `apple_ts_log`, present-flip and swap logging) used to gather
the measurements. That instrumentation should be removed before the work goes
upstream.

Fast iteration loop for the driver, used throughout:

```
cd /home/tristonarmstrong/kernel-vrr/linux
source ~/.bashrc
make -j8 modules
sudo install -m 644 drivers/gpu/drm/apple/appledrm.ko \
  /usr/lib/modules/7.0.11+/kernel/drivers/gpu/drm/apple/appledrm.ko
sudo depmod -a -b / 7.0.11+
sudo dracut --kver 7.0.11+ --force
sudo reboot
```

Enable the trace after boot with:

```
echo 1 | sudo tee /sys/module/appledrm/parameters/apple_ts_log
```

## Findings worth reporting upstream

1. The Adaptive Sync parameter is inert on the internal panel. Sending `minRR`
   changes nothing measurable in present timing. This supports jannau's
   skepticism and suggests the timestamps, not the parameter, carry whatever
   effect the PR intended.
2. The internal panel presents at the content rate by itself, with no VRR
   enabled. Any claim that the PR "enables" variable refresh on this hardware
   should be tested against a fixed-mode control, which we did not see in the
   thread.
3. The page-flip failure from a forced `mode_changed` is a real bug for any
   compositor that toggles `VRR_ENABLED` through a flip commit. This is worth
   fixing regardless of the panel's response.
4. Userspace cannot learn the panels' refresh range without EDID. A synthetic
   EDID with a Display Range Limits descriptor is a workable kernel-side fix.

## Next step

Build patched mutter 50.5 with the frame-clock maximum-refresh-interval setter
wired to the output minimum, and re-measure the idle cadence. If it settles at a
clean 41.6 ms, the full ProMotion behavior is in place.

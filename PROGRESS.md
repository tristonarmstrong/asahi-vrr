# Variable refresh on the Apple M1 Pro internal panel: driver fixes and a mutter experiment

Bottom line: the kernel driver now exposes variable refresh to userspace,
applies it without breaking page flips, and supplies a conformant synthetic EDID
that advertises the panel's 24–120 Hz range. A patched mutter reads that range
and sets its idle frame-clock target to 24 Hz. In fullscreen content the display
then idles near 24 Hz. On the plain desktop the patch has little effect, because
mutter only uses the variable-refresh frame-clock path when a fullscreen window
is present.

Test hardware: MacBookPro18,3 (14-inch M1 Pro, device tree `j314`), internal eDP
panel at 3024×1964 @ 120 Hz. Kernel tree: a clone of `AsahiLinux/linux`, branch
`dcp/vrr`, base `8a808006a` (7.0.11), plus local work. DCP firmware compatibility
version 13.5. mutter and GNOME 50.5 on Fedora Asahi Remix 44.

This is a personal investigation, not an upstream submission.

## What we set out to do

Apple calls this panel's feature ProMotion. On macOS the display drops to a low
refresh rate when little changes and rises to 120 Hz under motion. The goal was
the same on Fedora Asahi Remix, plus a display that does not refresh at 120 Hz
when the desktop is idle.

The starting point was chadmed's open PR [AsahiLinux/linux#477](https://github.com/AsahiLinux/linux/pull/477),
"drm: apple: Adaptive Sync/ProMotion". Its review thread contained the key
skepticism from jannau: *"How did you verify this does anything at all on
MacBook Pro internal displays? I would expect that this does nothing without
EDID with adaptive sync data."* That comment was correct, and following it
produced most of the work below.

## Fix 1: advertise VRR capable to the compositor

mutter only offers variable refresh for an output whose DRM connector reports
`vrr_capable`. The driver set that property at connector creation, before DCP
had parsed any display modes, so `dcp_has_vrr_mode()` always returned false and
the property stayed at 0.

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
it should be a modeset. But mutter toggles `VRR_ENABLED` through a page-flip
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

## Fix 3: a conformant synthetic EDID for the internal panel

This is the fix jannau's review comment pointed at.

The internal panel has no EDID. `dcp_start()` skips the DCPAV service that
fetches EDID for panel-type outputs:

```c
if (unstable_edid && !dcp_has_panel(dcp)) {
```

mutter reads the panel's minimum refresh rate from EDID. In
`meta_output_info_get_min_refresh_rate()` it requires `output_info->edid_info`
and otherwise returns false; the minimum comes only from an EDID Display Range
Limits descriptor. No EDID means no minimum, and mutter falls back to a
hardcoded value.

The driver now builds a conformant EDID 1.4 base block for the internal panel:

- descriptor 1: a detailed timing descriptor for the preferred mode, which base
  EDID requires to appear first;
- descriptor 2: a Display Range Limits descriptor advertising the parsed VRR
  range (24–120 Hz);
- descriptors 3–4: dummy descriptors.

Getting this right took three iterations. The first attempt put the vertical
rate bytes at descriptor offsets 7/8 (the horizontal fields), so the minimum read
as 0. The second left the horizontal rates and max dotclock at 0, which
libdisplay-info rejects as reserved values. The third is conformant:

```
di-edid-decode: EDID conformity: PASS
Monitor ranges (GTF): 24-120 Hz V, 30-200 kHz H, max dotclock 800 MHz
```

mutter now reads the minimum and reports it:

```
VRRDEBUG: output eDP-1 mode 120.0Hz edid_min=24 -> min_refresh_rate=24.0
VRRDEBUG: frame clock eDP-1 min_refresh_rate=24.000 maximum_refresh_interval_us=41667
```

## The mutter experiment

mutter hardcodes its VRR idle floor. In `clutter-frame-clock.c`:

```c
#define MINIMUM_REFRESH_RATE 30.f          /* line 48 */
...
frame_clock->maximum_refresh_interval_us =
  (int64_t) (0.5 + G_USEC_PER_SEC / MINIMUM_REFRESH_RATE);   /* line 2188 */
```

`maximum_refresh_interval_us` is set once at construction and has no setter. The
same 30 Hz default appears in `meta-kms-crtc.c`. mutter computes a real
`max_refresh_interval_us` from the output's minimum refresh rate, but uses it
only for KMS commit deadline scheduling, not for the frame-clock throttle target.

The patch adds a setter and wires it to the output's EDID minimum:

- `clutter-frame-clock.c/.h`: `clutter_frame_clock_set_min_refresh_rate()`
  replaces the hardcoded floor at runtime.
- `clutter-stage-view.c/.h`: a `min-refresh-rate` property and
  `clutter_stage_view_set_min_refresh_rate()`.
- `meta-renderer-native.c`: reads the output's EDID minimum (24) and passes it to
  the view.

The patched build is deployed to the system by replacing the two libraries, with
the originals backed up. After the change the frame clock reports
`maximum_refresh_interval_us=41667`, the correct 24 Hz target.

## Measurements

Present intervals come from the timestamp the driver attaches to each page-flip
event, which is the value mutter's frame clock consumes.

### Content rate is followed in every mode

| content framerate | 120 Hz +VRR | 120 Hz fixed | 60 Hz fixed |
|-------------------|-------------|--------------|-------------|
| 30 fps            | 32 ms       | 32 ms        | —           |
| 60 fps            | 17 ms       | 17 ms        | —           |
| 90 fps            | 11 ms       | 12 ms        | 18 ms       |
| 120 fps           | 9 ms        | 9 ms         | —           |

A fixed mode is a ceiling: on the 60 Hz mode, 90 fps content is clamped to about
56 Hz. Below the mode rate, the panel follows content on its own. Toggling
`VRR_ENABLED`, setting or clearing `minRR`, and disabling the swap timestamps
all produced the same present intervals, so on this panel those controls have no
measurable effect on pacing.

### Idle behavior depends on which frame-clock path is active

mutter only selects the variable-refresh frame-clock path when a fullscreen
window is present. In `meta-onscreen-native.c`:

```c
if (meta_output_is_vrr_enabled (onscreen_native->output))
  vrr_enabled = onscreen_native->vrr_allowed;
```

`vrr_allowed` is set only when a fullscreen window actor exists. On the plain
desktop `vrr_allowed` is false, the frame clock stays in FIXED mode, and the
minimum-rate change is not consulted. This is why the patch changed idle
behavior only in fullscreen:

- Plain desktop, VRR on or off: ~24–30 Hz with jitter; the patch makes little
  difference because FIXED mode governs.
- Static fullscreen window, VRR on: presents only about once per second, with the
  frames that do present landing at ~24 Hz and slower. This is the intended
  power-saving behavior.

A 60 Hz fixed mode idling near 24 Hz shows the panel/DCP is demand-driven: it
presents when content changes and holds the frame otherwise.

## State of the work

Kernel changes are committed on branch `dcp/vrr`:

- `de54e7411` "drm: apple: apply VRR live in flush path instead of forced
  modeset" — fixes 1 and 2, plus temporary debug instrumentation.
- `c0d90ea98` "drm: apple: synthesize a valid EDID for the internal panel" —
  fix 3.
- Safety mirror branch `vrr-mutter-work-20260924`.

The debug instrumentation (`apple_ts_mode`, `apple_ts_log`, present-flip and
swap logging) is temporary and should be removed before any upstream use.

Mutter patch and build live at `/home/tristonarmstrong/mutter-vrr/`:
`mutter-vrr.patch`, the patched source tree, and `deploy.sh`. The distro
libraries are backed up under `/home/tristonarmstrong/mutter-backup/`, and
`revert-vrr-mutter.sh` restores them.

Driver build loop:

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

## Findings

1. The Adaptive Sync parameter is inert on the internal panel. Sending `minRR`
   changes nothing measurable in present timing; the timestamps carry whatever
   effect the PR intended, and on this panel even they did not change pacing.
2. The internal panel presents at the content rate by itself, with no VRR
   enabled. A fixed-mode control should accompany any claim that the PR "enables"
   variable refresh on this hardware.
3. The page-flip failure from a forced `mode_changed` is a real bug for any
   compositor that toggles `VRR_ENABLED` through a flip commit.
4. Userspace cannot learn the panel's refresh range without EDID. A conformant
   synthetic EDID with a Display Range Limits descriptor is a workable
   kernel-side fix.
5. mutter applies variable refresh only to fullscreen content. An idle desktop
   never uses the VRR frame-clock path, so no VRR-related patch can throttle it
   below what FIXED-mode idle handling already does.

## Next step

If lower desktop idle power is the goal, the lever is FIXED-mode idle handling,
not the VRR floor. If a stutter-free fullscreen experience is the goal, the
current driver plus the mutter patch already get there, and the remaining work is
removing the temporary instrumentation and deciding whether to keep the mutter
patch private.

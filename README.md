# asahi-vrr

Variable refresh rate (Apple "ProMotion") on the internal panel of an M1 Pro
MacBook Pro under Fedora Asahi Remix, end to end:

1. **kernel** — the `appledrm` driver advertises VRR capability, applies Adaptive
   Sync without a forced modeset, and synthesizes a conformant EDID for the
   internal panel so userspace can learn its 24–120 Hz range.
2. **mutter** — a patch exposing the panel's minimum refresh rate to the frame
   clock, so mutter's VRR idle floor is 24 Hz instead of the hardcoded 30 Hz.
3. **gnome-extension** — a GNOME Shell extension that displays the display's live
   refresh rate in the top bar, measured from presented frames, with the VRR
   range read from EDID.

See [`VRR-PROGRESS.md`](VRR-PROGRESS.md) for the full write-up, measurements, and
caveats. This is a personal investigation, not an upstream submission.

## Layout

```
kernel/            git-format-patch series against chadmed/linux dcp/vrr
mutter/            mutter 50.5 patch + deploy script
gnome-extension/   GNOME Shell 45-50 extension (vrr-refreshrate@local)
VRR-PROGRESS.md    lab notes: what was tried, what worked, what did not
```

## Kernel

Base: a clone of `chadmed/linux` (the fork behind
[AsahiLinux/linux#477](https://github.com/AsahiLinux/linux/pull/477)) branch
`dcp/vrr` at `8a808006a` ("NOUPSTREAM: drm: apple: Hide VRR behind a module
parameter"), which already contains chadmed's Adaptive Sync bring-up.

The three commits in `kernel/000*.patch` are the local work on top of that base:

| Patch | What it does |
| --- | --- |
| `0001` | Apply VRR live in the CRTC flush path instead of forcing a modeset, and advertise `vrr_capable` once modes are known. |
| `0002` | Synthesize a conformant EDID 1.4 base block for the internal panel, including a Display Range Limits descriptor advertising 24–120 Hz. |
| `0003` | Remove the temporary VRR bring-up debug scaffolding. |

`kernel/macsmc-power-bcf0-width.patch` is unrelated to VRR: it handles the
`BCF0` SMC key being 1 byte on newer firmware (macOS 15.4+, iBoot "27") and 4
bytes on older firmware. It is a plain diff, not a `git am` mailbox:

```sh
git apply /path/to/asahi-vrr/kernel/macsmc-power-bcf0-width.patch
```

Apply on top of a `dcp/vrr` checkout:

```sh
cd /path/to/linux          # chadmed/linux branch dcp/vrr at 8a808006a
git am /path/to/asahi-vrr/kernel/000*.patch
```

The base hides VRR behind a module parameter, so the patched driver stays in
its default (VRR off) state unless you opt in at boot:

```sh
sudo grubby --update-kernel=/boot/vmlinuz-<release> --args="appledrm.force_vrr=1"
```

`kernel/install-vrr-kernel.sh` does not add that argument for you; it prints the
GRUB step after installing. Verify with `modinfo appledrm | grep force_vrr`.

Build and install alongside the stock Fedora kernel with
`kernel/install-vrr-kernel.sh` (run as root). It installs modules, DTBs, the
image, an initramfs, and a GRUB entry, leaving the default boot entry unchanged.
It expects the built kernel tree at `$VRR_KERNEL_SRC` (default
`$HOME/kernel-vrr/linux`).

## Mutter

`mutter/mutter-vrr.patch` is against mutter 50.5. It adds
`clutter_frame_clock_set_min_refresh_rate()`, a `min-refresh-rate` property on
`ClutterStageView`, and wires `meta-renderer-native.c` to pass the output's EDID
minimum to the view.

```sh
cd /path/to/mutter-50.5
patch -p1 < /path/to/asahi-vrr/mutter/mutter-vrr.patch
# build, then
sudo ./deploy.sh           # installs the two patched libraries, after backing up
```

> The patch reads the floor from `MetaOutputInfo.edid_info->min_vert_rate_hz`.
> On the synthetic panel EDID this is populated, so mutter reports 24 Hz. If the
> property reads 0 on a given setup, the GNOME extension independently parses the
> EDID range-limits descriptor instead and still shows 24 Hz.

## GNOME extension

See [`gnome-extension/README.md`](gnome-extension/README.md). Install:

```sh
cp -r gnome-extension ~/.local/share/gnome-shell/extensions/vrr-refreshrate@local
glib-compile-schemas ~/.local/share/gnome-shell/extensions/vrr-refreshrate@local/schemas/
# log out and back in
gnome-extensions enable vrr-refreshrate@local
```

## Hardware and versions

MacBookPro18,3 (14-inch M1 Pro, device tree `j314`), internal eDP panel at
3024×1964 @ 120 Hz. DCP firmware compatibility version 13.5. Kernel 7.0.11+.
mutter and GNOME Shell 50.5 on Fedora Asahi Remix 44.

## Caveats

- The Adaptive Sync parameter (`minRR`/`mediaTargetRate`) is inert on this
  panel; present timing follows the content by itself. See `VRR-PROGRESS.md`.
- mutter only uses the variable-refresh frame-clock path when a fullscreen window
  is present, so on a plain desktop the VRR floor mostly does not apply.
- The GNOME extension's live-rate reading is derived from presented-frame
  intervals, not from a hardware-reported rate.

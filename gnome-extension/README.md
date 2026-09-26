# VRR Refresh Rate

A GNOME Shell extension that shows the display's **live refresh rate** in the top
bar, updating in real time as a variable refresh rate (VRR) panel raises and
lowers its rate.

```
120 Hz
```

Clicking the indicator opens a menu with:

- current measured rate,
- the display's VRR range (floor–maximum),
- session peak,
- a rolling history sparkline, with the VRR floor drawn as a baseline,
- **Show decimals** toggle,
- **Settings…**.

## How it works

Mutter does not expose the display's live refresh rate through any public API
(`Clutter.FrameClock.get_refresh_rate()` returns the *nominal* rate and the frame
clock itself is `(skip)` in GIR). So the extension measures the rate itself:

1. It connects to `Clutter.Stage::after-paint`, which fires once per frame Mutter
   actually presents, per monitor.
2. It records the timestamp of each presented frame, per `ClutterStageView`.
3. Every poll interval it computes the **median inter-frame interval** over a
   rolling window and converts it to Hz.

Under VRR the panel's refresh rate follows the compositor's presentation cadence,
so the measured interval is the panel's current rate. The median is used rather
than a mean so a single late frame does not skew the reading.

### Idle behavior

On a static desktop nothing is being presented, so there is no meaningful live
rate. The extension detects this (frame intervals longer than the VRR floor
permits) and shows `-- Hz` rather than pretending the nominal maximum is the
measured rate. If the panel's VRR floor is known, the resting value is shown
instead.

## VRR floor

The VRR floor is resolved per display, in this order:

1. the `min-refresh-rate` property on `ClutterStageView`, if non-zero. That
   property is **not** part of upstream Mutter; it is added by a local patch
   (`mutter-vrr.patch`).
2. the monitor's EDID **Display Range Limits** descriptor (tag `0xfd`), read
   directly from `/sys/class/drm/<connector>/edid`.

Step 2 exists because the current `mutter-vrr.patch` sources the floor from
`edid_info->min_vert_rate_hz`, which Mutter does not populate from that
descriptor. Most laptop eDP panels (including the one this was developed on)
advertise their VRR range only there, so the property reads 0 and the extension
falls back to parsing the EDID itself. On that panel it recovers **24 Hz** from
the EDID's `24–120` range.

On stock Mutter with no patch, step 1 never fires and step 2 does all the work,
so the floor is still available. If neither yields a value, the range line shows
`floor unknown` and the idle value falls back to a dash. The floor source is
shown in the menu, e.g. `VRR range: 24–120 Hz  (edid:card2-eDP-1)`.

## Requirements

- GNOME Shell 45–50.
- Mutter 45–50. The live-rate measurement works on stock Mutter.
- A monitor that supports VRR, with VRR enabled in GNOME Settings > Displays,
  for the rate to actually vary.

## Install

```sh
cp -r vrr-refreshrate@local ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/vrr-refreshrate@local/schemas/
```

Then log out and back in (GNOME Shell only scans for extensions at startup) and
enable it:

```sh
gnome-extensions enable vrr-refreshrate@local
```

## Settings

Open via the indicator's **Settings…** item, or:

```sh
gnome-extensions prefs vrr-refreshrate@local
```

| Setting | Default | Description |
| --- | --- | --- |
| Update interval | 250 ms | How often the top bar label is recalculated. |
| Averaging window | 800 ms | Frames within this window are used to compute the rate. |
| Show decimals | off | Show two decimal places. |
| Show a rate when idle | on | Show the VRR floor when the output is not updating continuously. |
| Monitored display | Primary | Primary display, or whichever display updates most. |
| Panel position | Right | Left / center / right of the top bar. |
| Debug logging | off | Log measured values to the journal. |

## Debugging

Enable **Debug logging** in preferences, or run the shell with
`VRR_REFRESH_DEBUG=1`, then:

```sh
journalctl --user -b -f | grep vrr-refreshrate
```

Sample output:

```
[vrr-refreshrate] new view nominal=120.0 min=0 geometry=0,0 3024x1964
[vrr-refreshrate] update: hz=119.94 clamped=119.94 gaps=30 medGap=8.34ms maxGap=8.41ms nominal=120.0 min=0
[vrr-refreshrate] update: idle (gaps=20 maxGap=64.6ms limit=41.7ms) -> 0.0
```

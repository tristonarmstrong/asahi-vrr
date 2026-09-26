import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Mtk from 'gi://Mtk';
import cairo from 'gi://cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HISTORY_POINTS = 120;
const RECENT_GAP_COUNT = 30;
const DEFAULT_FLOOR_HZ = 30;

let debugEnabled = false;

function logDebug(message) {
    if (debugEnabled)
        console.log(`[vrr-refreshrate] ${message}`);
}

function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/*
 * Parse a monitor's vertical refresh range from the EDID Display Range Limits
 * descriptor (tag 0xfd) in the base block. Returns {min, max} in Hz, or null if
 * the descriptor is absent or unpopulated.
 *
 * This matters because mutter does not read this descriptor into its
 * MetaOutputInfo, so the current mutter-vrr patch reports min-refresh-rate 0 on
 * panels that only advertise their VRR range here (which is most laptop eDP
 * panels, including this one: it advertises 24-120 Hz).
 */
function edidRefreshRange(edid) {
    if (!edid || edid.length < 128)
        return null;

    for (let i = 0; i < 4; i++) {
        const off = 54 + i * 18;
        const desc = edid.subarray(off, off + 18);
        if (desc[0] !== 0x00 || desc[1] !== 0x00 || desc[2] !== 0x00)
            continue;
        if (desc[3] !== 0xfd)
            continue;
        const min = desc[5];
        const max = desc[6];
        if (min > 0 && max > min)
            return {min, max};
    }
    return null;
}

function readEdid(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || bytes.length < 128)
            return null;
        return bytes;
    } catch (e) {
        logDebug(`could not read EDID ${path}: ${e.message}`);
        return null;
    }
}

/*
 * Every DRM connector the kernel exposes, as {name, edidPath}. EDID is world
 * readable, so this needs no privileges.
 */
function drmConnectors() {
    const connectors = [];
    const dir = Gio.File.new_for_path('/sys/class/drm');
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        logDebug(`cannot enumerate /sys/class/drm: ${e.message}`);
        return connectors;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        // Connectors are named card<N>-<TYPE>-<index>; skip cards and render nodes.
        if (!/^card\d+-\w/.test(name))
            continue;
        connectors.push({
            name,
            edidPath: `/sys/class/drm/${name}/edid`,
        });
    }
    return connectors;
}

function latin1(bytes) {
    let out = '';
    for (const b of bytes)
        out += String.fromCharCode(b);
    return out;
}

function parseEdidIdentity(edid) {
    // Descriptor tag 0xfc is the monitor name, 0xff the serial string.
    let name = '';
    let serial = '';
    for (let i = 0; i < 4; i++) {
        const desc = edid.subarray(54 + i * 18, 54 + (i + 1) * 18);
        if (desc[0] !== 0x00 || desc[1] !== 0x00 || desc[2] !== 0x00)
            continue;
        const text = latin1(desc.subarray(5, 18)).replace(/\s+$/, '');
        if (desc[3] === 0xfc)
            name = text;
        else if (desc[3] === 0xff)
            serial = text;
    }
    return {name, serial};
}

/*
 * ClutterStageView does not expose its DRM connector, so match the view's
 * monitor to a connector:
 *   1. by EDID monitor name (and serial, when both sides have one),
 *   2. otherwise, if exactly one connector advertises a VRR range, use it.
 * Returns {connector, range} or null.
 */
function connectorForMonitor(monitor, connectors) {
    const entries = [];
    for (const c of connectors) {
        const edid = readEdid(c.edidPath);
        if (!edid)
            continue;
        const range = edidRefreshRange(edid);
        if (!range)
            continue;
        entries.push({connector: c, range, identity: parseEdidIdentity(edid)});
    }

    const wantName = (monitor?.product ?? '').trim().toLowerCase();
    const wantSerial = (monitor?.serial ?? '').trim().toLowerCase();
    if (wantName) {
        for (const e of entries) {
            if (e.identity.name.toLowerCase() !== wantName)
                continue;
            if (wantSerial && e.identity.serial &&
                e.identity.serial.toLowerCase() !== wantSerial)
                continue;
            return {connector: e.connector, range: e.range};
        }
    }

    if (entries.length === 1)
        return {connector: entries[0].connector, range: entries[0].range};

    return null;
}

/*
 * Resolve the nominal rate and VRR floor for a view.
 *
 * nominal comes from ClutterStageView.refresh_rate. The floor is taken, in
 * order of preference, from:
 *   1. the min-refresh-rate property (mutter-vrr patch), when non-zero,
 *   2. the EDID Display Range Limits descriptor of the matching connector.
 *
 * mutter does not read that descriptor into MetaOutputInfo, so the patch
 * reports 0 on panels (most laptop eDP panels) that only advertise their range
 * there; parsing EDID ourselves recovers the true floor.
 */
function viewRates(view) {
    let nominal = 0;
    try {
        nominal = view.get_refresh_rate();
    } catch (e) {
        nominal = 0;
    }
    if (!(nominal > 1))
        nominal = 60;

    let min = 0;
    try {
        min = view.get_property('min-refresh-rate');
    } catch (e) {
        logDebug(`min-refresh-rate property unavailable: ${e.message}`);
    }
    if (!(min > 1) || min >= nominal)
        min = 0;

    return {nominal, min};
}

function viewGeometry(view) {
    try {
        const rect = new Mtk.Rectangle({x: 0, y: 0, width: 0, height: 0});
        view.get_layout(rect);
        if (rect.width > 0 && rect.height > 0)
            return rect;
    } catch (e) {
        // ignore
    }
    return null;
}

function sameMonitor(rect, monitor) {
    if (!rect || !monitor)
        return false;
    const tol = 2;
    return Math.abs(rect.x - monitor.x) <= tol &&
        Math.abs(rect.y - monitor.y) <= tol &&
        Math.abs(rect.width - monitor.width) <= tol &&
        Math.abs(rect.height - monitor.height) <= tol;
}

/*
 * GObject type names are process-global. A single module import per session is
 * the norm, but register defensively in case this module is ever re-imported.
 */
let uniqueSuffix = 0;

const Sparkline = GObject.registerClass(
{$gtypeName: `Sparkline${++uniqueSuffix}`},
class Sparkline extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'vrr-sparkline',
            x_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._values = [];
        this._min = 0;
        this._max = 60;
        this.connect('repaint', area => this._onRepaint(area));
    }

    setValues(values, min, max) {
        this._values = values;
        this._min = min;
        this._max = Math.max(max, min + 1);
        this.queue_repaint();
    }

    _onRepaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const values = this._values;
        const min = this._min;
        const range = this._max - min;

        const yFor = value => {
            const t = Math.min(Math.max((value - min) / range, 0), 1);
            return height - t * height;
        };

        cr.setSourceRGBA(1, 1, 1, 0.06);
        cr.rectangle(0, 0, width, height);
        cr.fill();

        if (values.length < 2) {
            cr.$dispose();
            return;
        }

        // VRR floor line.
        cr.setLineWidth(1);
        cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.moveTo(0, yFor(min));
        cr.lineTo(width, yFor(min));
        cr.stroke();

        const stepX = width / (HISTORY_POINTS - 1);
        const offset = HISTORY_POINTS - values.length;

        cr.setLineWidth(1.5);
        cr.setSourceRGBA(0.30, 0.75, 0.94, 0.95);
        for (let i = 0; i < values.length; i++) {
            const x = (offset + i) * stepX;
            const y = yFor(values[i]);
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.stroke();
        cr.$dispose();
    }
});

const VrrIndicator = GObject.registerClass(
{$gtypeName: `VrrIndicator${++uniqueSuffix}`},
class VrrIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'VRR Refresh Rate', false);
        this._ext = ext;
        this._history = [];
        this._peak = 0;

        this._label = new St.Label({
            text: '-- Hz',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'vrr-refresh-label',
        });
        this.add_child(this._label);

        this._rateItem = new PopupMenu.PopupMenuItem('--', {reactive: false});
        this.menu.addMenuItem(this._rateItem);

        this._rangeItem = new PopupMenu.PopupMenuItem('--', {reactive: false});
        this.menu.addMenuItem(this._rangeItem);

        this._peakItem = new PopupMenu.PopupMenuItem('--', {reactive: false});
        this.menu.addMenuItem(this._peakItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sparkline = new Sparkline();
        this._sparkline.set_height(48);
        const graphBox = new St.BoxLayout({
            style_class: 'vrr-graph-box',
            x_expand: true,
        });
        graphBox.add_child(this._sparkline);
        const graphItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        graphItem.add_child(graphBox);
        this.menu.addMenuItem(graphItem);

        this._decimalsItem = new PopupMenu.PopupSwitchMenuItem(
            'Show decimals',
            this._ext.getSettings().get_boolean('show-decimals'));
        this._decimalsItem.connect('toggled', item => {
            this._ext.getSettings().set_boolean('show-decimals', item.state);
        });
        this.menu.addMenuItem(this._decimalsItem);

        this._resetItem = new PopupMenu.PopupMenuItem('Reset peak / history');
        this._resetItem.connect('activate', () => {
            this._peak = 0;
            this._history = [];
            this._sparkline.setValues([], 0, 1);
        });
        this.menu.addMenuItem(this._resetItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('Settings\u2026');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _format(hz) {
        const decimals = this._ext.getSettings().get_boolean('show-decimals');
        if (!(hz > 0))
            return '-- Hz';
        return decimals ? `${hz.toFixed(2)} Hz` : `${Math.round(hz)} Hz`;
    }

    setReading(hz, {idle = false, pending = false, nominal = 0, min = 0, floorSource = null} = {}) {
        const text = this._format(hz);
        if (this._label.text !== text)
            this._label.text = text;
        if (idle)
            this._label.add_style_pseudo_class('idle');
        else
            this._label.remove_style_pseudo_class('idle');

        if (hz > 0 && !idle) {
            this._peak = Math.max(this._peak, hz);
            this._history.push(hz);
            while (this._history.length > HISTORY_POINTS)
                this._history.shift();
            const scaleMin = min > 1 ? min : 0;
            const scaleMax = Math.max(this._peak, nominal, scaleMin + 1);
            this._sparkline.setValues([...this._history], scaleMin, scaleMax);
        }

        // The menu is usually closed; only touch those labels while it is open
        // so we don't queue needless relayouts every poll.
        if (!this.menu.isOpen)
            return;

        if (!idle)
            this._rateItem.label.text = `Current: ${this._format(hz)}`;
        else if (pending)
            this._rateItem.label.text = 'Waiting for the first frame\u2026';
        else if (min > 1)
            this._rateItem.label.text = `Idle \u2014 resting at floor ${this._format(min)}`;
        else
            this._rateItem.label.text = 'Idle \u2014 output not updating continuously';

        let range;
        if (min > 1) {
            range = `${Math.round(min)}\u2013${Math.round(nominal)} Hz`;
            if (floorSource)
                range += `  (${floorSource})`;
        } else {
            range = `${Math.round(nominal)} Hz (floor unknown)`;
        }
        this._rangeItem.label.text = `VRR range: ${range}`;
        this._peakItem.label.text = `Peak: ${this._format(this._peak)}`;
    }

    destroy() {
        this._sparkline?.destroy();
        this._sparkline = null;
        super.destroy();
    }
});

export default class VrrRefreshRateExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        debugEnabled = GLib.getenv('VRR_REFRESH_DEBUG') !== null ||
            this._settings.get_boolean('debug');
        logDebug('enable()');

        this._views = new Map(); // view -> {samples, last, nominal, min, floorSource}
        this._connectors = null; // lazily enumerated DRM connectors
        this._windowUs = 800 * 1000;
        this._pollMs = 250;
        this._position = 'right';

        this._indicator = new VrrIndicator(this);
        this._applyPosition();

        this._paintsId = global.stage.connect('after-paint',
            (_stage, view) => this._onPaint(view));

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._pollMs, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });

        this._settingsId = this._settings.connect('changed', () => this._applySettings());
        this._applySettings();
    }

    disable() {
        debugEnabled = false;
        if (this._paintsId) {
            global.stage.disconnect(this._paintsId);
            this._paintsId = 0;
        }
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._views = null;
        this._settings = null;
    }

    _applySettings() {
        debugEnabled = GLib.getenv('VRR_REFRESH_DEBUG') !== null ||
            this._settings.get_boolean('debug');
        this._windowUs = this._settings.get_int('averaging-window-ms') * 1000;
        const pollMs = this._settings.get_int('update-interval-ms');
        if (pollMs !== this._pollMs) {
            this._pollMs = pollMs;
            if (this._pollId)
                GLib.source_remove(this._pollId);
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._pollMs, () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
        }

        const position = this._settings.get_string('panel-position');
        if (position !== this._position) {
            this._position = position;
            this._applyPosition();
        }
    }

    _applyPosition() {
        if (this._indicator)
            this._indicator.destroy();
        this._indicator = new VrrIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, this._position);
    }

    /*
     * The DRM connector backing a stage view. Their layouts cover the same
     * monitor, so reuse sameMonitor() against the layout manager's monitor list.
     */
    _connectorForView(view) {
        this._connectors ??= drmConnectors();
        const rect = viewGeometry(view);
        const monitor = Main.layoutManager.monitors.find(m => sameMonitor(rect, m)) ??
            (sameMonitor(rect, Main.layoutManager.primaryMonitor)
                ? Main.layoutManager.primaryMonitor
                : null);
        return connectorForMonitor(monitor, this._connectors);
    }

    _onPaint(view) {
        const now = GLib.get_monotonic_time();
        let entry = this._views.get(view);
        if (!entry) {
            const {nominal, min: propMin} = viewRates(view);

            // Prefer the mutter patch's property; otherwise recover the floor
            // from the monitor's EDID range-limits descriptor.
            let min = propMin;
            let source = propMin > 1 ? 'mutter' : null;
            if (min <= 1) {
                const match = this._connectorForView(view);
                if (match && match.range.min < nominal) {
                    min = match.range.min;
                    source = `edid:${match.connector.name}`;
                }
            }

            entry = {samples: [], last: 0, nominal, min, floorSource: source};
            this._views.set(view, entry);
            if (debugEnabled) {
                const rect = viewGeometry(view);
                logDebug(`new view nominal=${nominal} min=${min} ` +
                    `floor=${source ?? 'unknown'} ` +
                    `geometry=${rect ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : '?'}`);
            }
        }
        entry.last = now;
        entry.samples.push(now);
        const cutoff = now - this._windowUs;
        while (entry.samples.length > 1 && entry.samples[0] < cutoff)
            entry.samples.shift();
    }

    _pickView() {
        const mode = this._settings.get_string('monitor-mode');
        if (mode === 'primary') {
            const monitor = Main.layoutManager.primaryMonitor;
            for (const [view] of this._views) {
                if (sameMonitor(viewGeometry(view), monitor))
                    return view;
            }
        }

        let best = null;
        let bestTime = -Infinity;
        for (const [view, entry] of this._views) {
            if (entry.last > bestTime) {
                bestTime = entry.last;
                best = view;
            }
        }
        return best;
    }

    /*
     * A frame interval longer than this means the compositor is not driving the
     * output continuously (nothing changed on screen, or only sporadic damage),
     * so the instantaneous rate is not a meaningful "current refresh rate" and
     * we report the output as idle/resting instead. Under VRR the frame clock
     * never schedules an interval longer than 1 / floor, so a continuously
     * updating output always stays under this limit.
     */
    _gapLimitUs(min) {
        const floor = min > 1 ? min : DEFAULT_FLOOR_HZ;
        return (1e6 / floor) * 1.25;
    }

    _update() {
        if (!this._indicator)
            return;

        const now = GLib.get_monotonic_time();
        const view = this._pickView();
        if (view === null) {
            // No frame has been observed on any view yet (e.g. just enabled).
            logDebug('update: no view seen yet');
            this._indicator.setReading(0, {idle: true, pending: true, nominal: 0, min: 0});
            return;
        }

        const entry = this._views.get(view);
        const {nominal, min, floorSource} = entry;
        const gapLimit = this._gapLimitUs(min);

        const samples = entry.samples;
        const gaps = [];
        for (let i = 1; i < samples.length; i++)
            gaps.push(samples[i] - samples[i - 1]);
        const recent = gaps.slice(-RECENT_GAP_COUNT);

        let maxGap = 0;
        for (const gap of recent)
            maxGap = Math.max(maxGap, gap);

        const active = recent.length >= 3 &&
            now - entry.last <= gapLimit &&
            maxGap <= gapLimit;

        if (!active) {
            // Nothing is being driven continuously, so there is no live rate to
            // report. Only show a resting value if a VRR floor is actually
            // known; otherwise show a dash rather than dressing up the nominal
            // maximum as if it were the measured rate.
            const showIdle = this._settings.get_boolean('show-idle-rate');
            const resting = showIdle && min > 1 ? min : 0;
            this._indicator.setReading(resting, {idle: true, nominal, min, floorSource});
            logDebug(`update: idle (gaps=${recent.length} maxGap=${(maxGap / 1000).toFixed(1)}ms ` +
                `limit=${(gapLimit / 1000).toFixed(1)}ms) -> ${resting.toFixed(1)}`);
            return;
        }

        const medGap = median(recent);
        const hz = medGap > 0 ? 1e6 / medGap : nominal;

        // The instantaneous interval is quantised to the panel's refresh
        // period, so a short run of frames can read slightly high or low. Only
        // report values inside the panel's supported range.
        const clamped = Math.min(Math.max(hz, min > 1 ? min : 0), nominal * 1.05);

        this._indicator.setReading(clamped, {idle: false, nominal, min, floorSource});
        logDebug(`update: hz=${hz.toFixed(2)} clamped=${clamped.toFixed(2)} gaps=${recent.length} ` +
            `medGap=${(medGap / 1000).toFixed(2)}ms maxGap=${(maxGap / 1000).toFixed(2)}ms ` +
            `nominal=${nominal} min=${min}`);
    }
}

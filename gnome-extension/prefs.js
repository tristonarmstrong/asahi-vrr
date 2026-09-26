import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MONITOR_MODES = ['primary', 'active'];
const PANEL_POSITIONS = ['left', 'center', 'right'];

export default class VrrRefreshRatePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'VRR Refresh Rate',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const sampling = new Adw.PreferencesGroup({
            title: 'Sampling',
            description: 'How the live refresh rate is measured and shown.',
        });
        page.add(sampling);

        const intervalRow = new Adw.SpinRow({
            title: 'Update interval',
            subtitle: 'How often the top bar label is recalculated (milliseconds)',
            adjustment: new Gtk.Adjustment({
                lower: 100, upper: 2000, step_increment: 50, page_increment: 100,
            }),
        });
        settings.bind('update-interval-ms', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        sampling.add(intervalRow);

        const windowRow = new Adw.SpinRow({
            title: 'Averaging window',
            subtitle: 'Frames presented within this window are used to compute the rate (milliseconds)',
            adjustment: new Gtk.Adjustment({
                lower: 200, upper: 3000, step_increment: 100, page_increment: 200,
            }),
        });
        settings.bind('averaging-window-ms', windowRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        sampling.add(windowRow);

        const decimalsRow = new Adw.SwitchRow({
            title: 'Show decimals',
            subtitle: 'Display the rate with two decimal places',
        });
        settings.bind('show-decimals', decimalsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        sampling.add(decimalsRow);

        const idleRow = new Adw.SwitchRow({
            title: 'Show a rate when idle',
            subtitle: 'When the output is not updating continuously, show the VRR floor (or nominal rate) instead of a placeholder',
        });
        settings.bind('show-idle-rate', idleRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        sampling.add(idleRow);

        const display = new Adw.PreferencesGroup({title: 'Display'});
        page.add(display);

        const monitorRow = new Adw.ComboRow({
            title: 'Monitored display',
            model: Gtk.StringList.new(['Primary display', 'Most active display']),
        });
        monitorRow.selected = Math.max(0,
            MONITOR_MODES.indexOf(settings.get_string('monitor-mode')));
        monitorRow.connect('notify::selected', () => {
            settings.set_string('monitor-mode', MONITOR_MODES[monitorRow.selected]);
        });
        display.add(monitorRow);

        const positionRow = new Adw.ComboRow({
            title: 'Panel position',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
        });
        positionRow.selected = Math.max(0,
            PANEL_POSITIONS.indexOf(settings.get_string('panel-position')));
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', PANEL_POSITIONS[positionRow.selected]);
        });
        display.add(positionRow);
    }
}

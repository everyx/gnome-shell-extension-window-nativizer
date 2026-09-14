#!/usr/bin/env python3
"""
Window Nativizer E2E Test Client
Creates a non-CSD GTK4 window and executes a deterministic sequence of operations:
1. Window map (set_decorated(False))
2. Multi-step dynamic resizing (enlarge, shrink, extreme aspect ratios)
3. Window maximize & unmaximize
4. Window close & cleanup
"""

import sys
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

app = Gtk.Application(application_id='org.test.windownativizer.e2e')

def on_activate(app):
    win = Gtk.ApplicationWindow(application=app)
    win.set_title("Window Nativizer E2E Client")
    win.set_decorated(False)

    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    box.set_margin_top(20)
    box.set_margin_bottom(20)
    box.set_margin_start(20)
    box.set_margin_end(20)
    box.set_size_request(400, 300)

    label = Gtk.Label(label="E2E Non-CSD Test Window")
    box.append(label)
    win.set_child(box)
    win.present()

    steps = [
        # (delay_ms, action, description)
        (500, lambda: box.set_size_request(520, 380), "Resize to 520x380"),
        (700, lambda: box.set_size_request(650, 460), "Resize to 650x460"),
        (900, lambda: box.set_size_request(360, 260), "Resize to 360x260 (shrink)"),
        (1100, lambda: box.set_size_request(700, 500), "Resize to 700x500"),
        (1300, lambda: box.set_size_request(480, 360), "Resize to 480x360"),
        (1600, lambda: win.maximize(), "Maximize window"),
        (1900, lambda: win.unmaximize(), "Unmaximize window"),
        (2200, lambda: win.close(), "Close window"),
    ]

    for delay, action, desc in steps:
        def make_cb(act, d):
            def cb():
                label.set_text(d)
                act()
                return GLib.SOURCE_REMOVE
            return cb
        GLib.timeout_add(delay, make_cb(action, desc))

app.connect('activate', on_activate)
exit_code = app.run(None)
sys.exit(exit_code)

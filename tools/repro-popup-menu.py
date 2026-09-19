#!/usr/bin/env python3
"""
tools/repro-popup-menu.py
Minimal GTK test harness for Issue #13 to reproduce and verify popup/dropdown menu lifecycle under Window Nativizer.
"""

import argparse
import sys
import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk, GLib

def main():
    parser = argparse.ArgumentParser(description="Issue #13 Popup Menu Test Harness")
    parser.add_argument("--auto", action="store_true", help="Automatically open menu and exit after timeout")
    parser.add_argument("--timeout", type=int, default=1500, help="Timeout in ms before exit in auto mode")
    args = parser.parse_args()

    win = Gtk.Window(title="Issue #13 Popup Menu Test")
    win.set_default_size(400, 300)

    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

    menubar = Gtk.MenuBar()
    file_item = Gtk.MenuItem(label="File")
    file_menu = Gtk.Menu()
    file_item.set_submenu(file_menu)

    for label in ["New", "Open", "Save", "Quit"]:
        mi = Gtk.MenuItem(label=label)
        if label == "Quit":
            mi.connect("activate", Gtk.main_quit)
        file_menu.append(mi)
    menubar.append(file_item)
    box.pack_start(menubar, False, False, 0)

    label = Gtk.Label(label="Click 'File' to open menu. Menu should stay open and not glitch.")
    label.set_hexpand(True)
    label.set_vexpand(True)
    box.pack_start(label, True, True, 0)

    win.add(box)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()

    if args.auto:
        def open_menu():
            file_menu.popup_at_widget(
                file_item,
                Gdk.Gravity.SOUTH_WEST,
                Gdk.Gravity.NORTH_WEST,
                None
            )
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(300, open_menu)
        GLib.timeout_add(args.timeout, Gtk.main_quit)

    Gtk.main()

if __name__ == "__main__":
    main()

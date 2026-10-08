#!/usr/bin/env python3
"""
Minimal GTK3 CSD probe client for Window Nativizer E2E testing.
Creates a standard GTK3 client window with client-side decorations (CSD),
a header bar, and Adwaita background color (#f6f5f4).
"""
import sys
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

def main():
    provider = Gtk.CssProvider()
    provider.load_from_data(b"""
        window, window.background, box {
            background-color: #f6f5f4;
        }
    """)
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )

    win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
    win.set_title("GTK3 CSD Probe")
    hb = Gtk.HeaderBar()
    hb.set_title("GTK3 CSD Probe")
    hb.set_show_close_button(True)
    win.set_titlebar(hb)

    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    box.set_size_request(600, 450)
    win.add(box)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    Gtk.main()

if __name__ == '__main__':
    main()

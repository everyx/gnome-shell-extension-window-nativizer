#!/usr/bin/env python3
"""
Full-screen white backdrop for Window Nativizer screenshots.
"""
import sys
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk

CSS = """
window.backdrop-window {
    background-color: #ffffff;
}
"""

app = Gtk.Application(application_id='dev.windownativizer.backdrop')

def on_activate(app):
    provider = Gtk.CssProvider()
    provider.load_from_string(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )

    win = Gtk.ApplicationWindow(application=app)
    win.set_title("Window Nativizer Backdrop")
    win.set_decorated(False)
    win.add_css_class("backdrop-window")
    win.set_default_size(1920, 1080)
    win.present()

if __name__ == '__main__':
    app.connect('activate', on_activate)
    sys.exit(app.run(None))

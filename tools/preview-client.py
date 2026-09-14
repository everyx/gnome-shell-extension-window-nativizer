#!/usr/bin/env python3
"""
Window Nativizer Preview Client
Renders a clean, solid-color undecorated window in GTK4
for generating the assets/preview.webp comparison screenshot.
"""

import sys
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk

CSS = """
window.solid-preview-window {
    background-color: #eaecf0;
    border: none;
}
"""

app = Gtk.Application(application_id='dev.windownativizer.preview')

def on_activate(app):
    provider = Gtk.CssProvider()
    provider.load_from_string(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )

    win = Gtk.ApplicationWindow(application=app)
    win.set_title("Window Nativizer Preview Subject")
    win.set_decorated(False)
    win.add_css_class("solid-preview-window")
    win.set_default_size(210, 276)

    box = Gtk.Box()
    box.set_size_request(210, 276)
    win.set_child(box)
    win.present()

if __name__ == '__main__':
    app.connect('activate', on_activate)
    exit_code = app.run(None)
    sys.exit(exit_code)

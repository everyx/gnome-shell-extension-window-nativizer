#!/usr/bin/env python3
"""
Window Nativizer Performance Benchmark Client
Runs an undecorated GTK4 window in idle or dynamic resize stress mode.
"""

import math
import os
import argparse
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

def main():
    parser = argparse.ArgumentParser(description="Performance benchmark client window")
    parser.add_argument("--stress", action="store_true", help="Run continuous dynamic resize stress test")
    parser.add_argument("--steps", type=int, default=150, help="Number of resize steps")
    args = parser.parse_args()

    app = Gtk.Application(application_id='dev.windownativizer.perf')

    def on_activate(app):
        win = Gtk.ApplicationWindow(application=app)
        win.set_title("Window Nativizer Perf Target")
        win.set_decorated(False)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.set_size_request(500, 350)
        win.set_child(box)
        win.present()

        print(f"READY_PID={os.getpid()}", flush=True)

        if args.stress:
            def run_stress():
                step = 0
                total_steps = args.steps

                def on_tick():
                    nonlocal step
                    if step >= total_steps:
                        print("STRESS_DONE", flush=True)
                        return GLib.SOURCE_REMOVE
                    t = step * 0.1
                    w = int(450 + math.sin(t) * 150)
                    h = int(320 + math.cos(t) * 100)
                    box.set_size_request(w, h)
                    win.set_default_size(w, h)
                    step += 1
                    return GLib.SOURCE_CONTINUE

                GLib.timeout_add(16, on_tick)
                return GLib.SOURCE_REMOVE

            GLib.timeout_add(200, run_stress)

    app.connect('activate', on_activate)
    app.run(None)

if __name__ == "__main__":
    main()

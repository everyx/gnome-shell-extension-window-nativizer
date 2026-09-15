#!/usr/bin/env python3
"""
generate-preview.py - Automates generating assets/preview.webp comparison image
at 2x HiDPI scaling using a clean solid-color window and benchmark screenshot pipeline.

Usage:
    python3 tools/generate-preview.py
"""

import os
import time
import struct
import subprocess
from PIL import Image, ImageDraw, ImageFont
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = "/tmp/window-nativizer-dev"
PID_FILE = os.path.join(STATE_DIR, "shell.pid")
PREVIEW_OUTPUT = os.path.join(ROOT, "assets", "preview.webp")
CLIENT_SCRIPT = os.path.join(ROOT, "tools", "preview-client.py")
BACKDROP_SCRIPT = os.path.join(ROOT, "tools", "backdrop.py")
TMP_SHOT = os.path.join(STATE_DIR, "shot_preview_raw.png")


def ensure_session():
    if not os.path.exists(PID_FILE):
        print(">> Starting nested shell via dev.sh...")
        subprocess.check_call([os.path.join(ROOT, "tools", "dev.sh"), "shell"])
        time.sleep(2.0)
    pid = open(PID_FILE).read().strip()
    raw_env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    bus = [x.decode() for x in raw_env if x.startswith(b"DBUS_SESSION_BUS_ADDRESS=")][0].split("=", 1)[1]
    return dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)


def set_monitor_scale_2x(env):
    cmd = [
        "gdbus", "call", "--session", "--dest", "org.gnome.Mutter.DisplayConfig",
        "--object-path", "/org/gnome/Mutter/DisplayConfig",
        "--method", "org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig",
        "2", "1", '[(0, 0, 2.0, uint32 0, true, [("Meta-0", "1920x1080@60.000", @a{sv} {})])]', '@a{sv} {}'
    ]
    try:
        subprocess.check_call(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
    except Exception as e:
        print(f">> Warning: could not set 2x scale: {e}")


def eval_js(code, env):
    cmd = [
        "gdbus", "call", "--session", "--dest", "org.gnome.Shell",
        "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", code
    ]
    return subprocess.check_output(cmd, env=env).decode()


def hide_overview_and_banners(env):
    cmd = [
        "gdbus", "call", "--session", "--dest", "org.gnome.Shell",
        "--object-path", "/org/gnome/Shell", "--method", "org.freedesktop.DBus.Properties.Set",
        "org.gnome.Shell", "OverviewActive", "<false>"
    ]
    subprocess.call(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    eval_js('Main.messageTray?._banner?.destroy(); Main.panel?.hide();', env)


def set_extension_state(enabled, env):
    subcmd = "enable" if enabled else "disable"
    subprocess.check_call(
        ["gnome-extensions", subcmd, "window-nativizer@everyx.github.io"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    time.sleep(0.8)


def take_screenshot(target_path, env):
    if os.path.exists(target_path):
        os.remove(target_path)
    hide_overview_and_banners(env)
    time.sleep(0.4)
    js = f"""
    const Shell = imports.gi.Shell;
    const Gio = imports.gi.Gio;
    const s = new Shell.Screenshot();
    const file = Gio.File.new_for_path("{target_path}");
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    s.screenshot(false, stream).then(() => {{ stream.close(null); }});
    "shot";
    """
    eval_js(js, env)
    for _ in range(30):
        if os.path.exists(target_path) and os.path.getsize(target_path) > 1000:
            break
        time.sleep(0.2)
def load_xcursor(names=("top_left_corner", "nw-resize"), target_size=48):
    """Load native Adwaita cursor bitmap and hotspot at target size."""
    if isinstance(names, str):
        names = [names]
    cursor_path = None
    for name in names:
        p = f"/usr/share/icons/Adwaita/cursors/{name}"
        if os.path.exists(p):
            cursor_path = p
            break
    if not cursor_path:
        return None, 0, 0
    with open(cursor_path, "rb") as f:
        data = f.read()
    if len(data) < 16 or data[:4] != b"Xcur":
        return None, 0, 0
    header_len, version, ntoc = struct.unpack("<III", data[4:16])
    best_img = None
    min_diff = 999
    best_hot = (0, 0)
    for i in range(ntoc):
        entry_offset = 16 + i * 12
        chunk_type, subtype, pos = struct.unpack("<III", data[entry_offset:entry_offset + 12])
        if chunk_type == 0xfffd0002:  # XCURSOR_IMAGE_TYPE
            c_hdr, c_type, c_sub, c_ver, w, h, xhot, yhot, delay = struct.unpack("<IIIIIIIII", data[pos:pos + 36])
            diff = abs(w - target_size)
            if diff < min_diff:
                min_diff = diff
                raw_pixels = data[pos + 36:pos + 36 + w * h * 4]
                best_img = Image.frombytes("RGBA", (w, h), raw_pixels, "raw", "BGRA")
                best_hot = (xhot, yhot)
    return best_img, best_hot[0], best_hot[1]


def main():
    print("================================================================")
    print(" Generating assets/preview.webp (2x HiDPI Solid Window)")
    print("================================================================")
    env = ensure_session()

    print(">> Setting virtual monitor scale to 2.0x...")
    set_monitor_scale_2x(env)

    # Suppress notifications and lock screens
    for key, val in [
        ("show-banners", "false"),
        ("show-in-lock-screen", "false")
    ]:
        subprocess.call(["gsettings", "set", "org.gnome.desktop.notifications", key, val], env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Set solid white background in gsettings
    for key, val in [
        ("picture-uri", "''"),
        ("picture-uri-dark", "''"),
        ("primary-color", "'#ffffff'"),
        ("secondary-color", "'#ffffff'"),
        ("color-shading-type", "'solid'")
    ]:
        subprocess.call(["gsettings", "set", "org.gnome.desktop.background", key, val], env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Clean up lingering processes
    subprocess.call(["pkill", "-9", "-f", "preview-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.call(["pkill", "-9", "-f", "backdrop.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.call(["pkill", "-9", "-f", "probe-window.js"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)

    # 1. Launch backdrop window
    print(">> Launching full-screen white backdrop...")
    subprocess.Popen([
        os.path.join(ROOT, "tools", "dev.sh"), "app", "python3", BACKDROP_SCRIPT
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    eval_js('const b = global.display.get_tab_list(0, null).find(w => w.get_title().includes("Backdrop")); if (b) { b.move_resize_frame(false, 0, 0, 960, 540); }', env)
    time.sleep(0.5)

    # 2. Launch solid preview client
    print(">> Launching solid preview client...")
    subprocess.Popen([
        os.path.join(ROOT, "tools", "dev.sh"), "app", "python3", CLIENT_SCRIPT
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)

    # Position client centrally at (375, 140) logical pixels, far from panel and edges
    eval_js('const win = global.display.get_tab_list(0, null).find(w => w.get_title().includes("Preview Subject")); if (win) { win.move_resize_frame(false, 375, 140, 210, 276); win.activate(global.get_current_time()); }', env)
    time.sleep(0.8)

    # 3. Capture BEFORE (extension disabled)
    print(">> Disabling extension and capturing BEFORE state...")
    set_extension_state(False, env)
    hide_overview_and_banners(env)
    take_screenshot(TMP_SHOT, env)
    shot_before = Image.open(TMP_SHOT).convert("RGB")
    arr_before = np.array(shot_before)

    # Detect window physical bounds (window color is #eaecf0 ~235, backdrop is 255)
    mask = (arr_before[:, :, 0] < 248) & (arr_before[:, :, 1] < 248) & (arr_before[:, :, 2] < 248)
    y_idx, x_idx = np.where(mask)
    if len(x_idx) == 0:
        raise RuntimeError("Could not locate solid preview window in screenshot")

    min_x, max_x = int(x_idx.min()), int(x_idx.max())
    min_y, max_y = int(y_idx.min()), int(y_idx.max())
    ww = max_x - min_x + 1
    wh = max_y - min_y + 1
    print(f">> Detected physical window bounds: X: {min_x}..{max_x} (w={ww}), Y: {min_y}..{max_y} (h={wh})")

    left_win = shot_before.crop((min_x, min_y, max_x + 1, max_y + 1))

    # 4. Capture AFTER (extension enabled)
    print(">> Enabling extension and capturing AFTER state...")
    set_extension_state(True, env)
    hide_overview_and_banners(env)
    take_screenshot(TMP_SHOT, env)
    shot_after = Image.open(TMP_SHOT).convert("RGB")

    # Crop with 64px physical padding to fully encapsulate 56px shadow
    pad = 64
    right_crop = shot_after.crop((min_x - pad, min_y - pad, max_x + 1 + pad, max_y + 1 + pad))

    # 5. Clean up processes
    subprocess.call(["pkill", "-9", "-f", "preview-client.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.call(["pkill", "-9", "-f", "backdrop.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 6. Compose 2x canvas (1000 x 720)
    print(">> Composing 1000x720 HiDPI comparison canvas...")
    CANVAS_W, CANVAS_H = 1000, 720
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), (255, 255, 255))

    left_x = 42
    left_y = 120
    canvas.paste(left_win, (left_x, left_y))

    right_x = 530
    right_y = 120
    canvas.paste(right_crop, (right_x - pad, right_y - pad))

    # Composite native resize cursor on AFTER window top-left corner
    cursor_img, xhot, yhot = load_xcursor(["top_left_corner", "nw-resize"], target_size=48)
    if cursor_img:
        canvas_rgba = canvas.convert("RGBA")
        canvas_rgba.alpha_composite(cursor_img, (right_x - xhot, right_y - yhot))
        canvas = canvas_rgba.convert("RGB")

    # 7. Render headers (2x font size = 46)
    draw = ImageDraw.Draw(canvas)
    font_path = "/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf"
    if not os.path.exists(font_path):
        font_path = "/usr/share/fonts/noto/NotoSans-Bold.ttf"
    font = ImageFont.truetype(font_path, 46)
    green_color = (1, 195, 118)  # Original brand emerald green

    center_left = left_x + ww // 2
    center_right = right_x + ww // 2

    bbox_b = font.getbbox("BEFORE")
    w_b = bbox_b[2] - bbox_b[0]
    draw.text((center_left - w_b // 2, 38), "BEFORE", fill=green_color, font=font)

    bbox_a = font.getbbox("AFTER")
    w_a = bbox_a[2] - bbox_a[0]
    draw.text((center_right - w_a // 2, 38), "AFTER", fill=green_color, font=font)

    # 8. Save
    os.makedirs(os.path.dirname(PREVIEW_OUTPUT), exist_ok=True)
    canvas.save(PREVIEW_OUTPUT, "WEBP", quality=95)
    print(f">> Successfully saved: {PREVIEW_OUTPUT} ({os.path.getsize(PREVIEW_OUTPUT)} bytes)")

    # Stop nested shell cleanly
    subprocess.call([os.path.join(ROOT, "tools", "dev.sh"), "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(">> [OK] 2x Preview generation complete.")


if __name__ == '__main__':
    main()

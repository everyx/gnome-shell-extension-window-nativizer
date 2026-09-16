![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml/badge.svg)](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml)
![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue.svg)
![License](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)

**Seamlessly nativize non-native applications into the GNOME desktop.**

Brings authentic Adwaita rounded corners, GPU-baked shadows, and a GTK-standard 12px resize border to non-conforming windows (Electron, Chromium, GTK3, Qt, Wine, etc.).

<img src="assets/preview.webp" alt="Before and after: a square window next to the same window with rounded corners and a shadow" width="500">

---

## Key Features

### 🎯 Authentic Libadwaita Styling
Non-native apps often feel out of place on a modern GNOME desktop. Window Nativizer brings them in line with official styling:
- **15px standard corners** with subtle inner outline highlights
- **Multi-layer Gaussian shadows** tailored for light and dark themes
- Curves and metrics compiled directly from upstream GNOME sources

### 🪟 12px GTK-Standard Resize Margins
Undecorated Wayland windows (such as VS Code, Chrome, and Discord) often provide a frustratingly thin 0~1px edge, making them hard to grab with a mouse.
- **Invisible 12px outer grab area**: Effortless, natural edge resizing
- **24px corner reach priority**: Smooth diagonal resizing
- Edge clicks pass cleanly through to underlying windows when disabled

### ⚡ Smooth GPU Shaders
- **Pre-baked 8-slice shadow meshes**: Zero CSS re-layout overhead at runtime
- **Direct pipeline hook**: Corners stay locked to the window during live resize without lag
- **Low resource footprint**: Lightweight GPU execution with minimal memory usage

### 🛡️ Smart & Non-Invasive
- **Leaves native apps alone**: Automatically skips Libadwaita, Libhandy, and Firefox
- **No double shadows**: Identifies existing compositor shadows and supplements only what is missing
- **State-aware**: Automatically removes decorations when windows are maximized, fullscreen, or snap-tiled

### 🔍 Crisp Text Protection
Fractional display scaling (125%, 150%) often causes font blurriness in traditional corner extensions due to offscreen framebuffer limitations.
- **Prioritize Crisp Text**: An optional toggle that bypasses corner clipping on scaled displays to keep text razor-sharp
- **Tracking upstream Mutter**: Preparing for zero-compromise direct rendering once upstream Mutter [!5179](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5179) lands

---

## Comparison: Window Nativizer vs. Rounded Window Corners

| Feature | Rounded Window Corners (Reborn) | Window Nativizer |
| :--- | :--- | :--- |
| **Primary Goal** | Desktop theming & custom aesthetics | GNOME / Adwaita native consistency |
| **Target Scope** | Rounds all windows (opt-out / blacklist) | Decorates non-native windows only; leaves native apps untouched |
| **Corner Radius** | User-configurable (e.g. 12px, 16px, 20px) | Fixed 15px matching official Libadwaita |
| **Window Resizing** | Retains application's declared border | Adds invisible 12px GTK grab margin |
| **Shadow Pipeline** | St.Bin CSS layout tree | GPU-baked texture mesh |

---

## Window Rules

Window Nativizer automatically handles most applications, but you can customize or override rules per window:

| Mode | Corners | Shadow | Typical Use Case |
| :--- | :---: | :---: | :--- |
| **Both** | Extension | Extension | Default. Third-party apps missing GNOME styling |
| **Neither** | Client | Client | Windows that already carry matching native decorations |
| **Corners only** | Extension | Client | Windows with existing compositor shadows (common on X11) |
| **Shadow only** | Client | Extension | Windows that round their own body but lack drop shadows |

To fix a misbehaving window, open **Preferences** and click **Pick Window** to generate a rule with one click.

[Learn more about the rule model →](docs/rule-model.md)

---

## Installation

### Requirements
- GNOME Shell 50 (Wayland or X11)

### From Release (Recommended)
Download `window-nativizer@everyx.github.io.shell-extension.zip` from [GitHub Releases](https://github.com/everyx/gnome-shell-extension-window-nativizer/releases):

```sh
gnome-extensions install --force window-nativizer@everyx.github.io.shell-extension.zip
```

### From Source
```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd gnome-shell-extension-window-nativizer
pnpm install
pnpm run install-ext
```

### Enable
Log out and back in (on X11, press `Alt+F2` and run `r`), then enable:
```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

---

## Architecture & Documentation

For low-level implementation details, design decisions, and benchmarks:
- [Decoration & Shader Architecture](docs/decoration-model.md) — GPU meshes, pipeline hooks, and memory budgets
- [Pixel Alignment & Accuracy](docs/decoration-alignment.md) — Upstream Libadwaita curve matching and regression tests
- [Rule System](docs/rule-model.md) — Process heuristics, window types, and rule precedence
- [Development & Testing Guide](docs/development.md) — Environment setup and test suite execution

---

## License

Licensed under **GPL-2.0-or-later**.
- Metrics and styling generated from [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita), shadows derived from [GTK4](https://gitlab.gnome.org/GNOME/gtk), window behaviors aligned with [Mutter](https://gitlab.gnome.org/GNOME/mutter).
- Related project reference: [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners).

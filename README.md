![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml/badge.svg)](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml)
![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue.svg)
![License](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)

**Seamlessly nativize non-native applications into the GNOME desktop.**

Brings **pixel-perfect GNOME rounded corners, GPU-baked shadows, and a GTK-aligned 12px resize band** to all non-Adwaita windows (Electron, Chromium, GTK3, Qt, Wine, WPS, etc.).

> 🤖 **Note**: This is an LLM-assisted (vibe coding) project, personally tested and verified in real-world daily use, and strictly backed by automated upstream parity tests.

<img src="assets/preview.webp" alt="Before and after: a square window next to the same window with rounded corners and a shadow" width="500">

---

## Why Window Nativizer?

Window Nativizer is not an indiscriminate "window cropper". It is a desktop nativization layer engineered against **GNOME and Libadwaita upstream standards as its sole reference**.

### 🎯 Pixel-Exact Libadwaita Alignment (Pixel-Exact Truth)
Zero eyeball tuning. Corner radius (15px), inner outline highlight (18/255 intensity), and multi-layer Gaussian shadow curves are directly compiled from official `libadwaita` SCSS and GTK source code via automated generators. Automated pixel regression tests enforce a 100% 4-way symmetric profile with ≤5/255 mean deviation, converging monotonically to zero within 4 pixels.

### 🪟 Real 12px GTK Native Resize Band (Interaction Truth)
The soul of native GNOME windows lies not only in their appearance, but in their **interactivity**. Undecorated third-party apps (such as Electron and web apps) on Wayland often declare 0~1px resize margins, making them notoriously frustrating to grab with a mouse. Window Nativizer faithfully implements GTK4's `gtkwindow.c` resize logic—featuring 12px outer resize bands and 24px corner reach priority—enabling effortless, natural drag-resizing for any window.

### ⚡ Sub-Millisecond Performance Budgets
- **GPU 8-Slice Shadow Meshes**: Baked once per style into a texture and rendered as 8 Cogl quads, eliminating runtime CSS styling overhead.
- **Pipeline-Hooked Live Corners**: GLSL shaders hook directly into Clutter's current frame allocation pipeline (`vfunc_paint_target`). Corners stay perfectly rounded throughout continuous dynamic window resizing with zero lag.
- **Strict Regression Budgets**: Guarded by automated CPU/memory performance benchmarks using warm-up and counterbalanced AB-BA sampling, guaranteeing dynamic resize CPU overhead stays within strict targets (<0.8ms per resize event) with a <2MB per-window PSS memory budget.

> **Benchmark Environment**: Tested on Arch Linux (Kernel 7.2), GNOME Shell 50.4 (Wayland), 11th Gen Intel® Core™ i5-11300H @ 3.10GHz (4 cores / 8 threads), 32 GB RAM, Intel® Iris® Xe Graphics. Measured via `tools/benchmark-perf.py` in an automated headless session (150 dynamic resizes @ 60 FPS, 3 counterbalanced AB-BA rounds with warm-up; real hardware timings may vary).

### 🛡️ Surgical & Non-Invasive
- **Leaves Native Apps Alone**: Probes process library mappings (`/proc/<pid>/maps`) and strictly skips apps that already draw native Adwaita corners (Libadwaita, Libhandy, and Gecko/Firefox).
- **No Double Shadows**: Intelligently identifies Mutter compositor and X11 native shadows, supplementing only what is missing.
- **Context-Aware States**: Automatically suppresses decorations for maximized and fullscreen windows; cleanly drops seam shadows on snap-tiled windows.

### 🔍 Fractional-Scale Crisp Text Protection
Under 125% or 150% fractional scaling, traditional corner-rounding extensions cause blurry and fuzzy text across the entire window. This occurs because Mutter's underlying `ClutterOffscreenEffect` loses framebuffer pixel phase when scaling.

Window Nativizer takes a pragmatic and transparent approach:
- **Today (Zero-Compromise Readability)**: With **Prioritize Crisp Text** enabled, the extension automatically skips offscreen corner clipping on fractional scaling displays, keeping native razor-sharp text alongside GPU-baked shadows.
- **Upstream Root-Cause Tracking**: We actively track and align with GNOME/Mutter's upstream fix ([!5179](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5179) / [Issue #6](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/6)). Once this lands in upstream Mutter, Window Nativizer will automatically enable pixel-aligned direct rendering, allowing fractional-scale users to enjoy native rounded corners with 100% sharp text without trade-offs.

---

## Architecture & Scope: Window Nativizer vs. Rounded Window Corners

Both extensions aim to improve the Linux desktop experience, but they pursue fundamentally different design goals and scopes:

| Dimension | Rounded Window Corners (Reborn) | Window Nativizer (This Project) |
| :--- | :--- | :--- |
| **Primary Focus** | **Desktop Theming & Customization**<br/>Enables a user-configurable corner radius across all windows for a custom desktop aesthetic | **GNOME Native Fidelity & Compatibility**<br/>Strictly supplements missing Adwaita appearance and interaction standards |
| **Target Windows** | **Universal Styling**<br/>Applies custom styling broadly across windows, with opt-out settings and blacklists | **Selective Nativization**<br/>Only decorates windows lacking Adwaita styling; native libadwaita/libhandy/Gecko apps are untouched |
| **Corner Radius** | **User-Configurable**<br/>Allows setting arbitrary custom corner radii (e.g. 16px, 20px) | **Upstream Adwaita Spec**<br/>Pixel-aligned 15px radius and inner highlight directly compiled from libadwaita source |
| **Window Resize Band** | **Retains Client Border**<br/>Relies on the client application's own declared window border | **GTK-Aligned 12px Resize Band**<br/>Transcribes GTK4 priority algorithms to restore easy mouse grabbing on borderless windows |
| **Shadow Architecture** | **St.Bin CSS Pipeline**<br/>Creates an `St.Bin` shadow pipeline with Clutter effect clipping | **GPU 8-Slice Baked Mesh**<br/>Submits pre-baked texture quads directly to the GPU pipeline without CSS layout overhead |

---

## Rule System

For specialized window configurations, the system independently manages **Corners** and **Shadow** decision axes for each window kind:

| Rule State | Corners | Shadow | Typical Use Case |
| :--- | :---: | :---: | :--- |
| **Both** | Extension | Extension | Default. For regular windows missing Adwaita styling. |
| **Neither** | Client | Client | For windows already carrying their own matching decorations. |
| **Corners only** | Extension | Client | Common on X11: Mutter already casts native shadows; only bottom corners needed. |
| **Shadow only** | Client | Extension | For windows rounding their own body but lacking external shadow margins. |

To correct a misdetected application, simply click **Pick Window** in the Preferences to generate the proper rule automatically.

> **Note on internally decorated windows**: When an application paints decorations or borders inside its own surface without declaring an external margin (common in certain CEF/Electron and Qt applications), the compositor cannot detect the inner border from the outside. These windows can be handled by picking them once to create a matching rule.

[Learn more about the rule model →](docs/rule-model.md)

## Resize Band Setting

If you prefer window edges to allow clicks to pass through to underlying windows, you can disable **Widen the Resize Band** in Preferences.

---

## Installation

### Requirements
- GNOME Shell 50 (Wayland or X11)

### Install from Release (Recommended)

Download the latest `window-nativizer@everyx.github.io.shell-extension.zip` from [GitHub Releases](https://github.com/everyx/gnome-shell-extension-window-nativizer/releases), then install it using the GNOME CLI:

```sh
gnome-extensions install --force window-nativizer@everyx.github.io.shell-extension.zip
```

### Install from Source

```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd gnome-shell-extension-window-nativizer
pnpm install
pnpm run install-ext
```

Enable the extension, then log out and back in (on X11, press Alt+F2 and run `r`):
```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

### Uninstall
```sh
gnome-extensions disable window-nativizer@everyx.github.io
gnome-extensions uninstall window-nativizer@everyx.github.io
```

---

## Development & Engineering Standards

Running `pnpm install` configures Git hooks via `.githooks/` to enforce full verification before every commit:
- `pnpm run lint`: ESLint code quality
- `pnpm test`: 217 GJS + Jasmine unit test specifications
- `pnpm run check-style`: Upstream code generation consistency (verifies strict parity with Libadwaita / GTK / Mutter upstream sources)
- `ego-lint`: GNOME official extension reviewer compliance (232 checks)
- `pnpm run benchmark:perf`: CPU and memory footprint regression budgets

For architecture and design models, see [docs/decoration-model.md](docs/decoration-model.md). For setup and nested testing instructions, see [docs/development.md](docs/development.md).

---

## Credits & License

- Licensed under **GPL-2.0-or-later**.
- Visual metrics generated from [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita); shadow shader derived from [GTK4](https://gitlab.gnome.org/GNOME/gtk); window behaviors align with [Mutter](https://gitlab.gnome.org/GNOME/mutter).
- Related project reference: [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners).

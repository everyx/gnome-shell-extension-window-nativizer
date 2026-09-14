![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

A GNOME Shell extension. Native rounded corners and shadows, only where missing — so every window looks native to GNOME.

![Before/after: a square window next to the same window with rounded corners and a drop shadow](assets/preview.webp)

## Features

- **Adds what is missing, and unifies the rest.**
  - **Shadow — read from the window, not guessed.** Only added where nothing is painted: a window that declares its own shadow margin, an X11 window with a system title bar, and a bare X11 window whose shadow Mutter paints keep theirs. The one reading that can be wrong is a client drawing its own shadow *without* declaring one.
  - **Corners — rounded to GNOME's 15px**, whether the toolkit rounded them itself or not, unless the window already draws the Adwaita look (libadwaita, [QAdwaitaDecorations](#less-work-for-us-let-the-toolkit-draw-it)) — those are left alone. [Why →](docs/decoration-model.md)
  - Shadow and corners are independent axes.
- **Never double-decorates.**
  - Two shadows → darker and misaligned, so the shadow axis has one owner: a window that painted its own gets ours instead of keeping it — never in addition.
  - The corner clip lands on the window body, not on the ring around it: a client's shadow out there is erased only when we are replacing the corners it was painted for.
  - Unsure → skip. A false skip costs one rule; a wrong decoration is a visual bug. [Why →](docs/decoration-model.md)
- **Hand-fixable.** Wrong guess → pick the window once, and the rule is set the other way (Decorate, Leave alone, Corners only, Shadow only). [Rules →](docs/rule-model.md)
- **Matches GNOME.** Corners, shadow and outline track a native window in every state: focused, backdrop, tiled, maximized, fullscreen, high contrast. Values from libadwaita.

## Installation

GNOME Shell 50, Wayland or X11. 45–49 should work but is untested — [help confirm it](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/8).

```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd gnome-shell-extension-window-nativizer
pnpm install
pnpm run install-ext
```

Enable, then re-login (X11: Alt+F2, `r`):

```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

Not on extensions.gnome.org yet.

## Performance

- **No idle cost.** Static windows: no JavaScript, no extra redraws.
- **Baked shadows.** One shared texture per style instead of a per-frame blur; resizing only moves texture coordinates. Numbers: [docs/decoration-model.md](docs/decoration-model.md).
- **Drops out when maximized.** Maximized, fullscreen, snap-tiled: shadow and offscreen clip skipped. `pnpm run benchmark:perf` checks the budgets.
- **One offscreen buffer per cornered window** (~8 MB at 1920×1080), re-rendered whenever that window paints.

### Less work for us: let the toolkit draw it

Windows that already draw GNOME's rounded corners themselves are left alone, which skips that offscreen buffer. The probe sees that from the libraries a process maps, so GTK4 apps and Qt apps with an Adwaita decoration plugin are recognised without any setup:

- **GTK4 apps** — anything that links libadwaita is recognised and left alone. A GTK3 theme such as [adw-gtk3](https://github.com/lassekongo83/adw-gtk3) cannot join them: GTK3's decoration node does not cover the bottom of the window, so a themed GTK3 program can never have four rounded corners. Those windows are taken over by the extension instead — corners and shadow both. [Why →](docs/decoration-model.md)
- **Qt apps** — [QAdwaitaDecorations](https://github.com/FedoraQt/QAdwaitaDecorations), a Qt Wayland decoration plugin that mimics libadwaita. Install it and a Qt window is skipped. It rounds a little tighter than libadwaita (12px against 15px), so a Qt window keeps that 12px rather than being unified to 15px: you trade one small difference on screen for one less offscreen buffer.

The Qt plugin is the only optional piece. Anything the probe does not recognise — including GTK3 apps under adw-gtk3 — is decorated by the extension, which costs one offscreen buffer per window.

## Troubleshooting

- **Missing corners or shadow** → pick the window; it will be set to **Decorate**.
- **Decorated when it shouldn't be** → pick the window; it will be set to **Leave alone**.
- **Only one axis is wrong** → set the rule to **Corners only** or **Shadow only** in the dropdown.
- **Soft text on a fractional scale** → enable **Prioritize crisp text** (trades corners for sharpness).

Rules come from the pick button in the preferences, and apply per window kind, not per app.

## Development

- **Commit = CI.** `pnpm install` sets `core.hooksPath` to `.githooks/`.
- **Docs.** [docs/development.md](docs/development.md).

## Credits

- Values generated from [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita); shadow shader from [GTK4](https://gitlab.gnome.org/GNOME/gtk); window behaviour follows [Mutter](https://gitlab.gnome.org/GNOME/mutter).
- Related: [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners).

## License

GPL-2.0-or-later

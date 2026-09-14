![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

A GNOME Shell extension that rounds window corners to GNOME's radius and adds a shadow only where no compositor, frame or client draws one. Windows that already look native keep their own corners; the shadow still follows what the window declares.

![Before and after: a square window next to the same window with rounded corners and a shadow](assets/preview.webp)

## What it does

After the extension is enabled, normal windows, dialogs and utility windows that do not already draw the Adwaita look get GNOME's rounded corners and a matching shadow. Maximized and fullscreen windows, and window types such as menus and docks, are left unchanged.

A **rule** covers one window kind — an application's window with the same client type, window type, parent and resize behaviour — not every window of an application. Each rule holds one of four states. The two decoration axes are independent, but the interface always sets both at once.

| State | Corners | Shadow |
|---|---|---|
| Both | extension | extension |
| Neither | client | client |
| Corners only | extension | client |
| Shadow only | client | extension |

To correct a wrong guess, pick the window once with the button in the preferences. The rule is set to the state that fixes what the window currently shows. [Rules →](docs/rule-model.md)

## The resize band

Native GNOME windows can be resized by dragging the 12 pixels around them. A window whose own resize border is narrower gets the same band from the extension, so it can be grabbed the way a native window can. It is measured from the window body, not from the visible shadow, and maximized, fullscreen and tiled windows have none.

This band is the only part of a window the extension takes part in hit testing: inside it, a click starts a resize instead of reaching whatever is behind the window. Turn off **Widen the Resize Band** in the preferences if you would rather those clicks go through.

## Windows it leaves alone

- **Windows that already draw the Adwaita look.** The extension decides this from the libraries a process maps: libadwaita, libhandy, or Qt's Adwaita decoration plugin. It does not read the GTK theme, because GTK3 cannot round the bottom of a window. [Why →](docs/decoration-model.md)
- **Maximized and fullscreen windows.** They are flush with the screen edge, where a rounded corner or a shadow would be wrong.
- **Window types other than normal windows, dialogs and utility windows**, such as menus and docks.
- **Snap-tiled windows with a matched neighbour.** Only the shadow the extension would draw is dropped; a shadow the client painted stays.

## When to use which state

- **Both** is the default: the extension draws both axes. Use it for a window that keeps square corners or is missing a shadow.
- **Neither** is for a window the extension should not touch, for example one that already carries its own decoration of the same kind.
- **Corners only** and **Shadow only** correct a single axis.
- On X11, Mutter paints a shadow outside the window that the extension cannot clear. On such a window **Both** adds a second shadow; use **Corners only** there.
- On a fractional-scale monitor, text can look soft because the rounded corners need an offscreen pass. Enable **Prioritize Crisp Text** to drop the corners and keep the shadow.
- Do not enable the extension together with another extension or theme that rounds corners and draws shadows; the same window would be decorated twice.

## Install

Requires GNOME Shell 50, on Wayland or X11.

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

## Development

`pnpm install` points git at `.githooks/`, so every commit runs the checks: `pnpm run lint`, `pnpm test`, `pnpm run check-style` and `pnpm run ego-lint`. [docs/development.md](docs/development.md) has the setup and how to measure the decoration in a nested session.

The decisions the code makes are recorded in [docs/decoration-model.md](docs/decoration-model.md) and [docs/rule-model.md](docs/rule-model.md).

## Credits

- Values are generated from [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita); the shadow shader comes from [GTK4](https://gitlab.gnome.org/GNOME/gtk); window behaviour follows [Mutter](https://gitlab.gnome.org/GNOME/mutter).
- Related: [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners).

## License

GPL-2.0-or-later

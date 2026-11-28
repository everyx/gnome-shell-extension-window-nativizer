# The system half of this repository's CI, built once instead of installed on every run.
#
# `Install packaging tools` was measured at 84s, 72s and 723s across three runs: the variance is the
# network, not the work, and it is the single longest step in the pipeline. Everything the jobs need
# lives here instead, including jasmine-gjs, which the unit tests used to clone and compile on every
# run.
#
# Arch, not Ubuntu, because the session suite has to run against a shell the extension supports:
# `src/metadata.json` declares 50 and 51, and a distro release image ships whatever shell it shipped
# (24.04 has 46, which loads the extension into OUT_OF_DATE and never activates it). A rolling base
# tracks the shell a contributor develops against, and the tag below pins one snapshot of it.
#
# The three things a headless session needs from a container were established by running this suite
# in the old image, and two of them are still the job's setup: a runtime directory for the Wayland
# socket, and a writable `/tmp/.X11-unix`.

FROM archlinux:base-20261122.0.629543

# Keyring first: a snapshot image carries the keyring of the day it was built, and a stale one makes
# every later package fail its signature check. Then one transaction, `-Syu` rather than `-Sy`,
# because a partially upgraded Arch is the classic way to get a broken one.
#
# gnome-shell brings `gnome-extensions`, which `pnpm run build` packs with, and the shell the session
# suite drives. gnome-calculator is the suite's libadwaita reference client. gjs runs the unit tests,
# python-gobject and python-pillow back the pixel checks, gtk3/gtk4/libadwaita provide the typelibs
# those checks and the probe clients load, xorg-xwayland exercises the X11 path, mesa gives the
# session a software renderer, dbus and dconf give it a bus and a settings backend, and
# glib2/gettext provide glib-compile-schemas and msgfmt. github-cli (`gh`) uploads the release asset:
# the hosted runner preinstalls it, a container does not.
RUN pacman -Sy --noconfirm archlinux-keyring \
    && pacman -Syu --noconfirm --needed \
        ca-certificates \
        curl \
        dbus \
        dconf \
        gdk-pixbuf2 \
        gettext \
        git \
        github-cli \
        gjs \
        glib2 \
        gnome-calculator \
        gnome-shell \
        gtk3 \
        gtk4 \
        libadwaita \
        mesa \
        meson \
        ninja \
        python-gobject \
        python-pillow \
        ttf-dejavu \
        xorg-xwayland \
        zip \
    && rm -rf /var/cache/pacman/pkg/*

# Pinned, not `master`: the test runner is part of the toolchain, so a change to it should be a
# commit in this file that someone reviews, not something a re-run silently picks up.
ARG JASMINE_GJS_SHA=856465dddbd92e82e574891e1ebc79e17d7b708a

RUN git clone https://github.com/ptomato/jasmine-gjs.git /tmp/jasmine-gjs \
    && git -C /tmp/jasmine-gjs checkout "${JASMINE_GJS_SHA}" \
    && meson setup /tmp/jasmine-gjs/build /tmp/jasmine-gjs --prefix=/usr \
    && ninja -C /tmp/jasmine-gjs/build install \
    && rm -rf /tmp/jasmine-gjs

# A machine id, which dbus needs before it will authenticate a client: without it GTK reports
# "Unable to acquire session bus: Cannot spawn a message bus without a machine-id" and the window
# never maps. The symlink is where dbus looks first on this distribution.
RUN mkdir -p /var/lib/dbus \
    && dbus-uuidgen > /etc/machine-id \
    && ln -sf /etc/machine-id /var/lib/dbus/machine-id

# Xwayland's socket directory, owned by root and writable by everyone before the runner user exists:
# mutter aborts the whole session when it cannot create its socket there, and a user cannot chmod a
# root-owned directory back.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# GitHub's runner uid, so actions/checkout can write the workspace it mounts, and a job that runs as
# root cannot leave files the next run has to sudo over.
RUN useradd --create-home --uid 1001 runner

USER runner
WORKDIR /home/runner

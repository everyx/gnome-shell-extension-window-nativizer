# The system half of this repository's CI, built once instead of installed on every run.
#
# `Install packaging tools` was measured at 84s, 72s and 723s across three runs: the variance is the
# network, not the work, and it is the single longest step in the pipeline. Everything the jobs need
# lives here instead, including jasmine-gjs, which the unit tests used to clone and compile on every
# run.
#
# The base is pinned to the Ubuntu release `ubuntu-latest` currently points at. That also walls off
# the announced switch of `ubuntu-latest` to 26.04 in November 2026: a toolchain change should be a
# commit here, not something that happens to the pipeline one morning.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# gnome-shell brings `gnome-extensions`, which is what `pnpm run build` packs with; gjs runs the
# unit tests; glib-compile-schemas and msgfmt come from libglib2.0-dev-bin and gettext. `gh` uploads
# the release asset: the hosted runner preinstalls it, a container does not.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gettext \
        gh \
        git \
        gir1.2-graphene-1.0 \
        gjs \
        gnome-shell \
        libglib2.0-dev-bin \
        meson \
        ninja-build \
        zip \
    && rm -rf /var/lib/apt/lists/*

# Pinned, not `master`: the test runner is part of the toolchain, so a change to it should be a
# commit in this file that someone reviews, not something a re-run silently picks up.
ARG JASMINE_GJS_SHA=856465dddbd92e82e574891e1ebc79e17d7b708a

RUN git clone https://github.com/ptomato/jasmine-gjs.git /tmp/jasmine-gjs \
    && git -C /tmp/jasmine-gjs checkout "${JASMINE_GJS_SHA}" \
    && meson setup /tmp/jasmine-gjs/build /tmp/jasmine-gjs --prefix=/usr \
    && ninja -C /tmp/jasmine-gjs/build install \
    && rm -rf /tmp/jasmine-gjs

# GitHub's runner uid, so actions/checkout can write the workspace it mounts, and a job that runs as
# root cannot leave files the next run has to sudo over.
RUN useradd --create-home --uid 1001 runner

USER runner
WORKDIR /home/runner

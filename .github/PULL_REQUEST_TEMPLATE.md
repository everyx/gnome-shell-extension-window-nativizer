<!--
Four sections, in this order. A reviewer reads them top to bottom and should not have to open the diff
to know what the change claims and how it was checked. Delete the ones that do not apply and say why
in one line rather than leaving an empty heading.
-->

## What changed

<!-- What the user of the extension can now observe. Not the file list: the behaviour, the number that
moved, or the bug that no longer happens. -->

## The test that fails without this change

<!-- The check that would go red if the change were reverted, and its failure output pasted verbatim.
`pnpm test` name, a new spec, a `check:*` leg, or a command whose observation only passes with this
change. "Should be fine" is not a test; if nothing fails without it, say so here and why. -->

## How verified

<!-- The commands you ran and what they printed, in the order you ran them. Include the check chain
legs this change can break (see docs/development.md), and any live observation: the pixel profile, the
nested-session run, the timing. Claims here are expected to be re-runnable by the reviewer. -->

## Irreversible or shared state touched

<!-- "none" by default. Otherwise name it: a release, a deploy, a force-push to a shared branch, a
write to the developer's own session or dconf. See "What an agent must not do" in
docs/development.md - that list is what a reviewer checks this section against. -->

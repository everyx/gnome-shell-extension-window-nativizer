# Report format, with a worked example

The report is a working artifact for one release. Keep it at `.audit/pre-release-<version>.md`
(gitignored, like the other `STATE_DIR` artifacts) unless the release is contested - then it goes in
the pull request, because a reviewer who cannot follow the evidence pointers has to trust the resume.

## Columns

| column | rule |
|---|---|
| `id` | stable within one release: `D<n>` document, `C<n>` comment, `R<n>` README or store copy |
| `location` | `path:line` of the sentence, not of the file |
| `claim` | one sentence, in the words the document uses, that evidence could refute |
| `kind` | `behaviour` / `upstream` / `reference` / `number` / `external` |
| `evidence` | a pointer or a command. `—` when nothing decided it |
| `verdict` | `holds` / `rotted` / `unverifiable` |
| `action` | `none` / `fix prose` / `make mechanical` / `delete claim` |

## What a filled-in report looked like on this repository

This is the audit that produced the `pre-commit` budget reminder, reconstructed from the actual
session that found it.

```markdown
## Verdict
ship with notes - two developer-facing claims rotted, both corrected in this release.

## Assertions
| id | location | claim | kind | evidence | verdict | action |
|----|----------|-------|------|----------|---------|--------|
| D1 | docs/development.md:26 | `check:volume` gates the commit | behaviour | `.githooks/pre-commit:28` runs five legs, not this one | rotted | fix prose |
| D2 | docs/decoration-model.md:156 | probe verdicts are cached at `$XDG_CACHE_HOME/window-nativizer/corner-probe.json` | reference | `src/platform/probeCache.js:6` builds the path from the uuid | rotted | fix prose |
| D3 | docs/development.md:196 | a kind's revalidation happens once per session | behaviour | deleted with the negative cache in `e7e7881` | rotted | delete claim |
| C1 | src/platform/window.js:178 | Mutter abstains from a shadow on an ARGB32 buffer | upstream | `vendor/mutter/src/compositor/meta-window-actor.c:412` | holds | none |
| R1 | README.md:66 | only the window's edge transparency is read | behaviour | `src/lib/cornerProbe.js:70-78` stops a read once our clip is on | holds | none |

## Coverage
3 documents + 2 comment files examined; 5 candidates; 4 verified against a pointer or a command;
0 unverifiable. The rest of `docs/` was out of scope: no changed line names it.
```

## Two habits that keep the table honest

- **A pointer beats a prose summary.** `src/lib/cornerProbe.js:70-78` resolves for anyone; "the probe
  checks the clip first" does not.
- **`unverifiable` is written down, not skipped.** It is the row that later becomes either a pointer
  or a deletion; an audit that hides it reports a false clean bill.

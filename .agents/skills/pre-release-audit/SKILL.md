---
name: pre-release-audit
description: Audit what a release claims before it ships - the docs and comments the outgoing diff touches - and report which of their assertions no longer hold. Use before tagging, publishing to extensions.gnome.org, or merging a release-please pull request.
---

# Pre-release audit

A release is the moment this repository's prose meets a reader who cannot check it against the code.
So the audit runs on the diff that is about to ship, not on the repository: what changed decides what
is worth re-reading, and everything else is somebody else's release.

It reports. It does not fix: an audit that edits while it reads cannot be reviewed, and the reader
cannot tell which claim was checked from which claim was corrected.

## What counts as an assertion

A sentence that something can refute: behaviour, a default, a file that exists, a command that runs,
a number, an upstream fact. Each one needs exactly one of:

- a pointer (`src/lib/cornerProbe.js:70`, `vendor/mutter/src/compositor/meta-shadow-factory.c:212`)
- a command whose output decides it
- a URL, for what this repository does not own

Not assertions, and out of scope however wrong they read: rationale ("we chose X because Y"),
trade-offs, tone, structure, length, whether a paragraph is pleasant.

## Procedure

1. **Bound the scope from the diff.** `git diff --name-only <last-tag>..HEAD` (or the release pull
   request's head against `master`). In scope: the documents and comments on changed lines, plus any
   document a changed file is named in. Out of scope: everything else - and say so in the report
   rather than quietly widening it.
2. **List candidates** per file: the sentences whose subject is something in the diff.
3. **Collect evidence** for each candidate. For a claim about behaviour, read the code path, and if
   the claim is about an operation - a command, an install, a setting - run it. Reading the code and
   inferring the outcome is not evidence for an operation.
4. **Judge** each candidate: `holds`, `rotted`, or `unverifiable`. `unverifiable` is a finding, not a
   shrug: it means the sentence cannot be kept honest by anyone, and its action is to gain a pointer
   or leave.
5. **Report** in the shape below, with one verdict for the whole release.
6. **File, do not fix.** Rotted claims become their own pull request, one per document.

## Report shape

Three parts, none optional. The template and a worked example are in
[references/report.md](references/report.md).

```markdown
## Verdict
ship | ship with notes | hold - and the reason in one sentence

## Assertions
| id | location | claim | kind | evidence | verdict | action |

## Coverage
files examined / candidates / verified / unverifiable - a report that verified three sentences and
says "all hold" is telling you it looked at three sentences
```

- **hold** when a claim a *user* can see is rotted and cannot be corrected before the release:
  the extensions.gnome.org description, a README statement, an install instruction.
- **ship with notes** when only developer-facing prose is rotted.

## Escalation

The point of an audit is to make itself less necessary. Per kind of rot:

| occurrence | action |
|---|---|
| first | correct the prose, keep the claim |
| second | make it mechanical - a `gen-*-mjs --check`, a spec, a budget line - and delete the human check |
| third, and unmechanisable | delete the claim: prose nobody can verify is prose that will rot again |

## Verify the audit itself

A report that finds nothing is indistinguishable from a report that looked at nothing. Before
trusting one, plant a known-rotten sentence in a file in scope (for example, describe
`check:volume` as a blocking hook), run the audit, and require it to be reported. If it is not, the
run is void - fix the audit, not the release.

## Not this skill

- Rewriting prose, or judging whether it is good. `docs/development.md` owns the writing rules and
  `tools/check-style.sh` owns the mechanical ones.
- Auditing code correctness: `pnpm run check` owns that, and it fails on its own.
- Widening scope beyond the outgoing diff, or auditing on a schedule. Rot that is not in this release
  is caught when someone changes the thing it describes.

#!/usr/bin/env bash
#
# Runs the EGO reviewer's linter over src/ and compares what it finds against the accepted set in
# tools/ego-lint-baseline.txt. A finding that is not in the baseline, or one that now appears more
# often than the baseline says, fails. A baseline entry that no longer appears fails too: a baseline
# that keeps entries nobody can reproduce is a lie, and the next reader has no way to tell.
#
# The gate exists because the tool's own verdict treats warnings as commentary - "may pass with
# comments" exits 0 - so a tree can gain findings run after run without anything going red. That is
# how two Object.freeze() warnings were merged without notice.
#
# Usage:
#   tools/ego-lint.sh            check against the baseline
#   tools/ego-lint.sh --update   rewrite the baseline from this run, print the difference
#   tools/ego-lint.sh --prime    fetch the tool if it is missing, then stop (run from `prepare`)
#
# The tool is a pinned checkout of https://github.com/ZviBaratz/gnome-extension-reviewer, resolved
# from $EGO_LINT_DIR, then from $EGO_LINT's directory, then from a cache clone. A machine that can
# reach none of them skips loudly instead of blocking the commit.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PIN="$(tr -d '[:space:]' < tools/ego-lint.version)"
BASELINE="tools/ego-lint-baseline.txt"

# fd 3 is the hook's live channel: run-checks redirects a check's output into a log it deletes on
# success, so a skip written to stdout would never be seen.
say() {
    if [ -e /dev/fd/3 ]; then
        printf '[lint:ego] %s\n' "$*" >&3
    else
        printf '[lint:ego] %s\n' "$*"
    fi
}

fail() {
    say "$*"
    exit 1
}

# An empty set still prints one blank line through printf, and comm would read that as a finding
# with no rule, so every producer of these lists goes through here.
lines() { printf '%s\n' "$1" | grep -v '^$' || true; }

cache_dir() {
    printf '%s/window-nativizer/ego-lint/%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}" "${PIN}"
}

tool_dir() {
    if [ -n "${EGO_LINT_DIR:-}" ]; then
        printf '%s\n' "${EGO_LINT_DIR}"
    elif [ -n "${EGO_LINT:-}" ]; then
        # A path to the wrapper inside a checkout, so its directory is the checkout.
        dirname "${EGO_LINT}"
    else
        cache_dir
    fi
}

fetch_tool() {
    local dir="$1"
    command -v git >/dev/null 2>&1 || return 1
    mkdir -p "$(dirname "${dir}")" 2>/dev/null || return 1
    git clone --quiet --depth 1 --branch "${PIN}" \
        https://github.com/ZviBaratz/gnome-extension-reviewer.git "${dir}" 2>/dev/null
}

# A cached checkout carries our patch, so git reports it as "-dirty"; both forms are the pin.
verify_pin() {
    local dir="$1"
    [ -d "${dir}/.git" ] || return 0
    command -v git >/dev/null 2>&1 || return 0
    local actual
    actual="$(git -C "${dir}" describe --tags --always 2>/dev/null || true)"
    case "${actual}" in
        "${PIN}"|"${PIN}-dirty") return 0 ;;
        "") fail "cannot read the version of ${dir}; expected ${PIN}" ;;
        *) fail "${dir} is at ${actual}, tools/ego-lint.version says ${PIN}" ;;
    esac
}

# Upstream v0.1.31 aborts its own verdict when an extension has no warnings at all: the `grep
# "^WARN|"` in that path exits 1 under `set -eo pipefail`. Idempotent, and the grep afterwards
# proves the patch still applies - if upstream rewords it, that must fail here rather than quietly
# stop taking effect.
patch_tool() {
    local file="$1/skills/ego-lint/scripts/ego-lint.sh"
    [ -f "${file}" ] || fail "no ${file} in the checkout"
    sed -i \
        -e 's/grep "\^WARN|" "\$RESULTS_FILE" | cut/grep "^WARN|" "$RESULTS_FILE" 2>\/dev\/null | cut/' \
        -e 's/| sort -u | wc -l)/| sort -u | wc -l || true)/' \
        "${file}"
    grep -q 'sort -u | wc -l || true' "${file}" ||
        fail "the upstream verdict no longer matches the patch this gate applies; re-read it"
}

# `rule<TAB>path<TAB>count`, sorted. Line numbers are deliberately dropped: they move with every
# edit above them, and the baseline would churn until nobody reads its diffs. The count keeps a
# second instance of the same rule in the same file visible.
normalise() {
    awk -F'\t' '
        { key = $1 "\t" $2; count[key]++ }
        END { for (k in count) printf "%s\t%d\n", k, count[k] }
    ' | sort
}

parse_findings() {
    local out="$1"
    printf '%s\n' "${out}" |
        sed -nE 's/^\[(WARN|FAIL)\][[:space:]]+([^[:space:]]+)[[:space:]]+(.*)$/\2\t\3/p' |
        while IFS=$'\t' read -r rule detail; do
            path="$(printf '%s' "${detail}" | sed -nE 's/^([A-Za-z0-9_./-]+\.js):[0-9]+.*/\1/p')"
            printf '%s\t%s\n' "${rule}" "${path:--}"
        done | normalise
}

mode=check
case "${1:-}" in
    --update) mode=update ;;
    --prime) mode=prime ;;
    "") ;;
    *) fail "usage: tools/ego-lint.sh [--update|--prime]" ;;
esac

DIR="$(tool_dir)"
if [ ! -x "${DIR}/ego-lint" ]; then
    if [ "${mode}" = prime ]; then
        fetch_tool "${DIR}" || say "could not fetch ${PIN}; the gate will skip until it can"
        exit 0
    fi
    fetch_tool "${DIR}" || {
        say "skipped: no checkout at ${DIR} and could not clone ${PIN} (set EGO_LINT_DIR)"
        exit 0
    }
fi

verify_pin "${DIR}"
patch_tool "${DIR}"

out="$(bash "${DIR}/ego-lint" --show all src/ 2>&1)"
status=$?

actual="$(parse_findings "${out}")"

# The counts have to agree before the comparison means anything: a parser that silently matches
# nothing would report "no new findings" forever, which is worse than a red gate.
reported="$(printf '%s\n' "${out}" | sed -nE 's/.*\(([0-9]+) total findings?\).*/\1/p' | tail -1)"
parsed="$(printf '%s\n' "${actual}" | awk -F'\t' 'NF==3 { n += $3 } END { print n + 0 }')"
if [ -n "${reported}" ] && [ "${reported}" != "${parsed}" ]; then
    printf '%s\n' "${out}"
    fail "read ${parsed} finding(s) from the output but the tool reported ${reported}; fix the parser"
fi
if [ "${status}" -ne 0 ] && [ "${parsed}" -eq 0 ]; then
    printf '%s\n' "${out}"
    fail "ego-lint failed without a finding this gate can read"
fi

if [ "${mode}" = update ]; then
    {
        printf '%s\n' \
            '# Findings this repository accepts, one line per rule and file: <rule> <path> <count>.' \
            '# A path is "-" when the finding names no file. Regenerate with: pnpm run lint:ego -- --update' \
            '# Each line is a decision, so read the diff: a new line accepts a warning for good.'
        lines "${actual}"
    } > "${BASELINE}"
    say "baseline rewritten: $(printf '%s\n' "${actual}" | grep -c . ) line(s)"
    exit 0
fi

if [ ! -f "${BASELINE}" ]; then
    fail "no ${BASELINE}; create it with: pnpm run lint:ego -- --update"
fi

accepted="$(grep -vE '^[[:space:]]*(#|$)' "${BASELINE}" | awk -F' ' 'NF==3 { printf "%s\t%s\t%s\n", $1, $2, $3 }' | sort)"

new="$(comm -13 <(lines "${accepted}") <(lines "${actual}"))"
stale="$(comm -23 <(lines "${accepted}") <(lines "${actual}"))"

if [ -z "${new}" ] && [ -z "${stale}" ]; then
    exit 0
fi

if [ -n "${new}" ]; then
    say "new finding(s), not in the baseline:"
    printf '%s\n' "${new}" | while IFS=$'\t' read -r rule path count; do
        printf '[lint:ego]   %s  %s  x%s\n' "${rule}" "${path}" "${count}"
        printf '%s\n' "${out}" | grep -F "[WARN] ${rule}" | head -3 | sed 's/^/[lint:ego]     /'
    done
fi
if [ -n "${stale}" ]; then
    say "baseline entries that no longer appear (the baseline must stay true):"
    printf '%s\n' "${stale}" | while IFS=$'\t' read -r rule path count; do
        printf '[lint:ego]   %s  %s  x%s\n' "${rule}" "${path}" "${count}"
    done
fi
fail "run 'pnpm run lint:ego -- --update' after reading the difference"

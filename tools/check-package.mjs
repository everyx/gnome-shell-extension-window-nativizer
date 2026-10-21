#!/usr/bin/env node
/**
 * check-package.mjs - the verdict half of `pnpm run lint:zip`.
 *
 * shexli prints its findings and exits 0, so calling it straight from the script let a package
 * with an EGO error pass CI. This reads its JSON report and fails on every error except a
 * shell-version finding whose majors are known to exist. Warnings are printed but do not fail:
 * a warning is what an EGO reviewer reads, not what stops a build.
 *
 * Usage: node tools/check-package.mjs <shexli-report.json>
 */

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Test seam: the checker's tests pin their own audit record instead of the repo's current one.
const API_RECORD = process.env.CHECK_PACKAGE_API_RECORD
    ? path.resolve(process.env.CHECK_PACKAGE_API_RECORD)
    : path.join(ROOT, 'tools', 'shell-api.json');

/**
 * A GNOME major is known to exist when it is either the stable release the host runs, or a line
 * this repo has audited from a real tag. shexli 0.2.1 stops at 50, so a released 51 looks like a
 * future version to it; that is its data lagging, not the manifest lying. Both sources move on
 * their own: a host on 52 admits 52 without a code change, and a new audited line admits itself.
 * A development build is not evidence - `gnome-shell --version` prints `52.beta`, which fails the
 * integer match and leaves the audit record to decide.
 */
function hostStableMajor() {
    try {
        const version = execFileSync('gnome-shell', ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        }).trim();
        const match = /(\d+)\.(\d+)$/.exec(version);
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
}

function auditedMajors() {
    try {
        const record = JSON.parse(readFileSync(API_RECORD, 'utf8'));
        return Array.isArray(record.majors) ? record.majors.map(Number) : [];
    } catch {
        return [];
    }
}

const hostMajor = hostStableMajor();
const knownMajors = new Set([...auditedMajors(), ...(hostMajor === null ? [] : [hostMajor])]);

/** Reads `shell-version=['50', '51']` back into [50, 51]; null when it is not a plain list. */
function majorsFromSnippet(snippet) {
    const match = /^shell-version=\[(.*)\]$/.exec(snippet ?? '');
    if (!match)
        return null;
    const entries = match[1].split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, ''));
    if (!entries.length || entries.some(entry => !/^\d+$/.test(entry)))
        return null;
    return entries.map(Number);
}

function isKnownFalsePositive(finding, report) {
    if (finding.rule_id !== 'EGO-M-004' || finding.severity !== 'error')
        return false;
    const evidence = finding.evidence?.find(item => item.path?.endsWith(':metadata.json'));
    if (!evidence)
        return false;
    const majors = majorsFromSnippet(evidence.snippet);
    if (!majors || !majors.every(major => knownMajors.has(major)))
        return false;
    // The artifact's own parse is part of the evidence: a report without it, or one that parsed a
    // different list than the finding shows, cannot widen the exception. Missing is not "no
    // objection" - a future report shape has to fail here until its evidence is read again.
    const targets = report.artifacts?.target_versions;
    if (!Array.isArray(targets))
        return false;
    const sorted = values => [...values].sort((a, b) => a - b).join(',');
    if (sorted(targets.map(Number)) !== sorted(majors))
        return false;
    return true;
}

function describe(finding) {
    const file = finding.evidence?.[0]?.path ?? 'unknown path';
    return `${finding.rule_id} (${file}): ${finding.message}`;
}

const reportPath = process.argv[2];
if (!reportPath) {
    console.error('[lint:zip] usage: node tools/check-package.mjs <shexli-report.json>');
    process.exit(2);
}

let report;
try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
    console.error(`[lint:zip] cannot read the shexli report: ${error.message}`);
    process.exit(2);
}

const findings = report.findings;
if (!Array.isArray(findings)) {
    console.error('[lint:zip] the shexli report has no "findings" array');
    process.exit(2);
}
if (report.summary?.status === 'issues_found' && findings.length === 0) {
    console.error('[lint:zip] the shexli report says issues were found but lists none');
    process.exit(2);
}

const errors = findings.filter(finding => finding.severity === 'error');
const warnings = findings.filter(finding => finding.severity === 'warning');
const unknown = findings.filter(finding => finding.severity !== 'error' && finding.severity !== 'warning');
const blocking = errors.filter(finding => !isKnownFalsePositive(finding, report));

for (const finding of findings) {
    if (finding.severity === 'warning') {
        console.log(`[lint:zip] WARN  ${describe(finding)}`);
        continue;
    }
    if (isKnownFalsePositive(finding, report)) {
        console.log(`[lint:zip] ALLOW ${describe(finding)}`);
        console.log(`[lint:zip]       ${[...knownMajors].sort((a, b) => a - b).join(', ')} ` +
            'are known releases (stable host and/or audit record); shexli\'s data lags');
        continue;
    }
    console.error(`[lint:zip] ERROR ${describe(finding)}`);
}

if (blocking.length || unknown.length) {
    console.error(`[lint:zip] FAIL: ${blocking.length + unknown.length} finding(s) not covered by an exception`);
    process.exit(1);
}

console.log(`[lint:zip] PASS: ${errors.length} error(s), ${warnings.length} warning(s)` +
    `${errors.length ? ', all errors are known false positives' : ''}`);

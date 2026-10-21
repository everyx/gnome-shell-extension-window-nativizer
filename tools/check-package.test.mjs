#!/usr/bin/env node
/**
 * Tests for tools/check-package.mjs, the verdict half of `pnpm run lint:zip`.
 *
 * The checker owns a CI gate, so its fail-closed edges are worth pinning: the exception is the
 * dangerous part, and every case here either admits one exact known release set or refuses. Runs
 * under Node's own test runner; no session, no gjs, no shexli.
 *
 * Usage: node --test tools/check-package.test.mjs
 */

import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = path.join(ROOT, 'tools', 'check-package.mjs');

let dir;
let noHost;

before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'check-package-'));
    noHost = path.join(dir, 'no-host');
    mkdirSync(noHost);
});

after(() => rmSync(dir, {recursive: true, force: true}));

function auditRecord(majors) {
    const file = path.join(dir, `audit-${majors.join('-')}.json`);
    writeFileSync(file, JSON.stringify({majors}));
    return file;
}

/** A PATH directory whose `gnome-shell` reports the given version. */
function fakeShell(version) {
    const bin = path.join(dir, `shell-${version.replace(/\./g, '-')}`);
    mkdirSync(bin, {recursive: true});
    const executable = path.join(bin, 'gnome-shell');
    writeFileSync(executable, `#!/bin/sh\necho "GNOME Shell ${version}"\n`);
    chmodSync(executable, 0o755);
    return bin;
}

function report(name, {
    rule = 'EGO-M-004',
    severity = 'error',
    snippet = "shell-version=['50', '51']",
    targets = [50, 51],
    withTargets = true,
} = {}) {
    const payload = {
        summary: {status: 'issues_found'},
        findings: [{
            rule_id: rule,
            severity,
            message: 'test finding',
            evidence: [{path: 'package.zip:metadata.json', snippet}],
        }],
    };
    if (withTargets)
        payload.artifacts = {target_versions: targets};
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(payload));
    return file;
}

function run(reportPath, {host = noHost, majors = [50, 51]} = {}) {
    return spawnSync(process.execPath, [CHECKER, reportPath], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: host,
            CHECK_PACKAGE_API_RECORD: auditRecord(majors),
        },
    });
}

test('admits an audited version list whose target list agrees', () => {
    const result = run(report('audited'));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS/);
});

test('admits a stable host major the audit record has not seen', () => {
    const result = run(report('host-stable'), {host: fakeShell('51.1'), majors: [50]});
    assert.equal(result.status, 0);
});

test('admits a host major beyond the audit record when it is declared', () => {
    const result = run(report('host-new', {
        snippet: "shell-version=['52']",
        targets: [52],
    }), {host: fakeShell('52.0'), majors: [50]});
    assert.equal(result.status, 0);
});

test('does not treat a development host version as a release', () => {
    const result = run(report('host-dev', {
        snippet: "shell-version=['52']",
        targets: [52],
    }), {host: fakeShell('52.beta'), majors: [50]});
    assert.equal(result.status, 1);
});

test('fails closed when the report has no target list', () => {
    const result = run(report('no-targets', {withTargets: false}));
    assert.equal(result.status, 1);
});

test('fails when the target list disagrees with the finding evidence', () => {
    const result = run(report('mismatch', {targets: [50, 52]}));
    assert.equal(result.status, 1);
});

test('fails on an error outside the one exception', () => {
    const result = run(report('other-error', {rule: 'EGO-M-001'}));
    assert.equal(result.status, 1);
});

test('fails on an unknown severity', () => {
    const result = run(report('unknown-severity', {severity: 'info'}));
    assert.equal(result.status, 1);
});

test('passes a warning without failing the gate', () => {
    const result = run(report('warning', {rule: 'EGO-P-007', severity: 'warning'}));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /WARN/);
});

test('fails when the audit record stops before a declared major', () => {
    const result = run(report('stale-audit'), {majors: [50]});
    assert.equal(result.status, 1);
});

test('fails closed on a malformed report', () => {
    const file = path.join(dir, 'malformed.json');
    writeFileSync(file, '{not json');
    assert.equal(run(file).status, 2);
});

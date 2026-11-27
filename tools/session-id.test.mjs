#!/usr/bin/env node
/**
 * `tools/dev.sh id` is what every harness tool asks before it trusts a pid file. A session that died
 * leaves one behind, and the pid it names can be reused by anything - so these cover the answer being
 * "no session" rather than a stranger's bus address.
 *
 * Usage: node --test tools/session-id.test.mjs
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'tools', 'dev.sh');

function withStateDir(body) {
    const dir = mkdtempSync(path.join(tmpdir(), 'wn-id-'));
    try {
        return body(dir);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

function devId(dir) {
    const result = spawnSync(DEV, ['id'], {
        env: {...process.env, WN_STATE_DIR: dir},
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('a pid file naming a live process that is not the nested shell names no session', () => {
    withStateDir(dir => {
        const child = spawn('sleep', ['30'], {stdio: 'ignore'});
        try {
            writeFileSync(path.join(dir, 'shell.pid'), `${child.pid}\n`);
            writeFileSync(path.join(dir, 'ready'), '');
            assert.equal(devId(dir), '');
        } finally {
            child.kill('SIGKILL');
        }
    });
});

test('a pid file naming a process that is gone names no session', () => {
    withStateDir(dir => {
        const child = spawn('sleep', ['0.05'], {stdio: 'ignore'});
        const exited = new Promise(resolve => child.on('exit', resolve));
        writeFileSync(path.join(dir, 'shell.pid'), `${child.pid}\n`);
        return exited.then(() => {
            assert.equal(devId(dir), '');
        });
    });
});

test('an empty state directory names no session', () => {
    withStateDir(dir => {
        assert.equal(devId(dir), '');
    });
});

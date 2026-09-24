'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cwd = path.resolve(__dirname, '..');
const { version } = require('@livepad/cli/package.json');

test('legacy module and CLI imports delegate to @livepad/cli', () => {
  assert.equal(require('..'), require('@livepad/cli'));
  assert.equal(require('../cli'), require('@livepad/cli/cli'));
  assert.equal(require('../server'), require('@livepad/cli/server'));
});

test('legacy executable entries keep version and help arguments', () => {
  for (const entry of ['cli.js', 'server.js']) {
    const result = spawnSync(process.execPath, [entry, '--version'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
  const result = spawnSync(process.execPath, ['cli.js', '--help'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, require('@livepad/cli/cli').HELP);
});

test('legacy CLI preserves argument errors and failure exit status', () => {
  const result = spawnSync(process.execPath, ['cli.js', '--unknown'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --unknown/u);
});

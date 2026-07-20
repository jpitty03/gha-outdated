'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'index.js');
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function runBin(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, GITHUB_TOKEN: '' } },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

test('bin --help exits 0 without touching the network', async () => {
  const result = await runBin(['--help'], fixture('no-workflows'));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
});

test('bin rejects unknown arguments with exit 2', async () => {
  const result = await runBin(['--nope'], fixture('no-workflows'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option\(s\): --nope/);
});

test('bin exits 0 when no workflow files exist (no network needed)', async () => {
  const result = await runBin([], fixture('no-workflows'));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No workflow files found/);
});

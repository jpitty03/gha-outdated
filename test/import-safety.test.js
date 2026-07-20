'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');

test('importing the library performs no network requests or process.exit', () => {
  const originalExit = process.exit;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;
  let exited = false;
  let requested = false;

  process.exit = () => {
    exited = true;
    throw new Error('process.exit called during import');
  };
  http.get = https.get = () => {
    requested = true;
    throw new Error('network request during import');
  };

  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('lib')) {
        delete require.cache[key];
      }
    }
    const lib = require('../lib/index');
    assert.equal(typeof lib.run, 'function');
    assert.equal(typeof lib.parseArgs, 'function');
    assert.equal(typeof lib.GitHubClient, 'function');
    assert.equal(lib.EXIT_OK, 0);
    assert.equal(lib.EXIT_OUTDATED, 1);
    assert.equal(lib.EXIT_ERROR, 2);
  } finally {
    process.exit = originalExit;
    http.get = originalHttpGet;
    https.get = originalHttpsGet;
  }

  assert.equal(exited, false);
  assert.equal(requested, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVersion,
  classifyRef,
  compareVersions,
  isOutdated,
  isMajorUpdate,
} = require('../lib/versions');

test('parseVersion accepts supported numeric refs', () => {
  const cases = [
    ['v4', { major: 4, minor: null, patch: null, precision: 1 }],
    ['4', { major: 4, minor: null, patch: null, precision: 1 }],
    ['v4.1', { major: 4, minor: 1, patch: null, precision: 2 }],
    ['v4.1.2', { major: 4, minor: 1, patch: 2, precision: 3 }],
    ['0.5.0', { major: 0, minor: 5, patch: 0, precision: 3 }],
    [' v2 ', { major: 2, minor: null, patch: null, precision: 1 }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseVersion(input), expected, `input: ${input}`);
  }
});

test('parseVersion rejects unsupported refs', () => {
  const rejected = [
    'main',
    'v4.1.2-beta.1',
    'v4.1.2.3',
    '8f4b7f84864484a7bf31766abe9204da3cbe65b3',
    '${{ inputs.version }}',
    'release-v4',
    'v',
    '',
    'v4.x',
    '99999999999999999999',
    undefined,
    null,
  ];
  for (const input of rejected) {
    assert.equal(parseVersion(input), null, `input: ${input}`);
  }
});

test('classifyRef distinguishes numeric, SHA, expression, unsupported', () => {
  assert.equal(classifyRef('v4.1.2'), 'numeric');
  assert.equal(classifyRef('4'), 'numeric');
  assert.equal(classifyRef('8f4b7f84864484a7bf31766abe9204da3cbe65b3'), 'commit-sha');
  assert.equal(classifyRef('abcdef1'), 'commit-sha');
  assert.equal(classifyRef('${{ inputs.version }}'), 'expression');
  assert.equal(classifyRef('main'), 'unsupported');
  assert.equal(classifyRef('v4.1.2-rc.1'), 'unsupported');
});

test('compareVersions orders versions and prefers concrete precision', () => {
  const v = (s) => parseVersion(s);
  assert.ok(compareVersions(v('v5'), v('v4.9.9')) > 0);
  assert.ok(compareVersions(v('v4.1.2'), v('v4.2')) < 0);
  assert.ok(compareVersions(v('v4.1.2'), v('v4.1.1')) > 0);
  assert.equal(compareVersions(v('v4.1.2'), v('4.1.2')), 0);
  // floating v4 alias loses to the concrete v4.0.0 tag
  assert.ok(compareVersions(v('v4.0.0'), v('v4')) > 0);
});

test('isOutdated compares only at the pinned precision', () => {
  const v = (s) => parseVersion(s);
  // floating major: stale only when a newer major exists
  assert.equal(isOutdated(v('v4'), v('v4.1.2')), false);
  assert.equal(isOutdated(v('v4'), v('v5.0.0')), true);
  // regression: a major-only pin equal to the latest release line is not
  // an update (v7 vs v7.0.0 was falsely flagged before the 1.0.8 rework)
  assert.equal(isOutdated(v('v7'), v('v7.0.0')), false);
  assert.equal(isOutdated(v('v5'), v('v5.0.0')), false);
  // major/minor precision
  assert.equal(isOutdated(v('v4.1'), v('v4.1.9')), false);
  assert.equal(isOutdated(v('v4.1'), v('v4.2.0')), true);
  // full precision
  assert.equal(isOutdated(v('v4.1.2'), v('v4.1.2')), false);
  assert.equal(isOutdated(v('v4.1.2'), v('v4.1.3')), true);
  assert.equal(isOutdated(v('v4.1.2'), v('v4.2.0')), true);
  assert.equal(isOutdated(v('v4.1.2'), v('v5')), true);
  // a lower latest version is never an update
  assert.equal(isOutdated(v('v4.2'), v('v4.1.2')), false);
  assert.equal(isOutdated(v('v5'), v('v4.9.9')), false);
  assert.equal(isOutdated(v('v4.1.5'), v('v4.1.2')), false);
});

test('isMajorUpdate requires a strictly greater major', () => {
  const v = (s) => parseVersion(s);
  assert.equal(isMajorUpdate(v('v4'), v('v5.0.0')), true);
  assert.equal(isMajorUpdate(v('v4.1.2'), v('v4.9.9')), false);
  assert.equal(isMajorUpdate(v('v5'), v('v4.0.0')), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  WorkflowReadError,
  findWorkflowFiles,
  parseUsesValue,
  extractReferences,
  collectReferences,
} = require('../lib/workflows');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('findWorkflowFiles returns .yml and .yaml files only', () => {
  const stale = findWorkflowFiles(fixture('stale'));
  assert.equal(stale.length, 1);
  assert.ok(stale[0].endsWith('stale.yml'));

  const clean = findWorkflowFiles(fixture('clean'));
  assert.equal(clean.length, 1);
  assert.ok(clean[0].endsWith('ci.yaml'));
});

test('findWorkflowFiles handles missing and empty workflow dirs', () => {
  assert.deepEqual(findWorkflowFiles(fixture('no-workflows')), []);
  assert.deepEqual(findWorkflowFiles(fixture('empty')), []);
});

test('parseUsesValue handles quotes and comments', () => {
  assert.equal(parseUsesValue('actions/checkout@v4'), 'actions/checkout@v4');
  assert.equal(parseUsesValue('actions/checkout@v4 # pinned'), 'actions/checkout@v4');
  assert.equal(parseUsesValue('"actions/checkout@v4"'), 'actions/checkout@v4');
  assert.equal(parseUsesValue("'actions/checkout@v4' # c"), 'actions/checkout@v4');
  assert.equal(parseUsesValue('"unterminated@v4'), null);
  assert.equal(parseUsesValue('"a@v1" trailing-garbage'), null);
  assert.equal(parseUsesValue('""'), null);
});

test('extractReferences recognizes supported forms and exclusions', () => {
  const content = [
    'jobs:',
    '  reuse:',
    '    uses: octo-org/example-repo/.github/workflows/reusable.yml@v2',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@v4 # comment',
    '      - uses: "actions/setup-node@v4.1"',
    "      - uses: 'octo-org/tool/subdir/action@v1.2.3'",
    '      - uses: ./local/action',
    '      - uses: docker://alpine:3.20',
    '      - uses: broken-no-ref@',
    '      - uses: @justref',
    '      - uses: singlesegment@v1',
    '      - uses: bad&owner/repo@v1',
  ].join('\n');

  const refs = extractReferences(content);
  const byUses = new Map(refs.map((r) => [r.uses, r]));

  assert.deepEqual(
    byUses.get('octo-org/example-repo/.github/workflows/reusable.yml@v2'),
    {
      uses: 'octo-org/example-repo/.github/workflows/reusable.yml@v2',
      kind: 'action',
      repo: 'octo-org/example-repo',
      ref: 'v2',
    }
  );
  assert.equal(byUses.get('actions/checkout@v4').repo, 'actions/checkout');
  assert.equal(byUses.get('actions/setup-node@v4.1').ref, 'v4.1');
  assert.equal(byUses.get('octo-org/tool/subdir/action@v1.2.3').repo, 'octo-org/tool');
  assert.equal(byUses.get('./local/action').kind, 'local');
  assert.equal(byUses.get('docker://alpine:3.20').kind, 'docker');
  assert.equal(byUses.get('broken-no-ref@').kind, 'malformed');
  assert.equal(byUses.get('@justref').kind, 'malformed');
  assert.equal(byUses.get('singlesegment@v1').kind, 'malformed');
  assert.equal(byUses.get('bad&owner/repo@v1').kind, 'malformed');
});

test('collectReferences deduplicates and records source files', () => {
  const files = findWorkflowFiles(fixture('mixed'));
  const refs = collectReferences(files);
  const checkout = refs.filter((r) => r.uses === 'actions/checkout@v4');
  assert.equal(checkout.length, 1, 'duplicates collapse into one entry');
  assert.equal(checkout[0].files.length, 1);
  assert.ok(checkout[0].files[0].endsWith('mixed.yml'));
});

test('collectReferences surfaces unreadable files as operational failures', () => {
  const fakeFs = {
    readFileSync() {
      throw new Error('EACCES: permission denied');
    },
  };
  assert.throws(
    () => collectReferences([path.join('x', 'flow.yml')], { fs: fakeFs }),
    (error) => {
      assert.ok(error instanceof WorkflowReadError);
      assert.match(error.message, /flow\.yml/);
      assert.match(error.message, /EACCES/);
      return true;
    }
  );
});

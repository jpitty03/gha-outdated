'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseArgs, run, EXIT_OK, EXIT_OUTDATED, EXIT_ERROR } = require('../lib/cli');
const { parseVersion } = require('../lib/versions');
const { LookupError } = require('../lib/github');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

class MemoryStream {
  constructor() {
    this.data = '';
  }

  write(chunk) {
    this.data += chunk;
  }
}

/** Fake GitHub client backed by a map of repo -> tag | null | Error. */
function fakeClient(map) {
  return {
    calls: [],
    async getLatestVersion(repo) {
      this.calls.push(repo);
      if (!(repo in map)) {
        throw new Error(`unexpected lookup: ${repo}`);
      }
      const value = map[repo];
      if (value instanceof Error) {
        throw value;
      }
      if (value === null) {
        return null;
      }
      return { tag: value, version: parseVersion(value) };
    },
  };
}

async function runCli(argv, options = {}) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await run(argv, { stdout, stderr, ...options });
  return { code, stdout: stdout.data, stderr: stderr.data };
}

test('parseArgs recognizes every alias and collects unknown args', () => {
  const base = { help: false, version: false, majorOnly: false, invalid: [] };
  assert.deepEqual(parseArgs(['-m']), { ...base, majorOnly: true });
  assert.deepEqual(parseArgs(['-M']), { ...base, majorOnly: true });
  assert.deepEqual(parseArgs(['--major']), { ...base, majorOnly: true });
  assert.deepEqual(parseArgs(['-h']), { ...base, help: true });
  assert.deepEqual(parseArgs(['-H']), { ...base, help: true });
  assert.deepEqual(parseArgs(['--help']), { ...base, help: true });
  assert.deepEqual(parseArgs(['-v']), { ...base, version: true });
  assert.deepEqual(parseArgs(['-V']), { ...base, version: true });
  assert.deepEqual(parseArgs(['--version']), { ...base, version: true });
  assert.deepEqual(parseArgs(['--bogus', '-m']), {
    ...base,
    majorOnly: true,
    invalid: ['--bogus'],
  });
});

test('valid help exits 0 without an unknown-command prefix', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Exit codes:/);
  assert.ok(!result.stdout.includes('Unknown'));
});

test('--version prints the package version and exits 0', async () => {
  const client = fakeClient({});
  const result = await runCli(['--version'], { client });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /^gha-outdated v\d+\.\d+\.\d+\n$/);
  assert.equal(
    result.stdout.trim(),
    `gha-outdated v${require('../package.json').version}`,
  );
  assert.equal(client.calls.length, 0, 'no lookups on version output');
  assert.equal(result.stderr, '', 'nothing on stderr');
});

test('help takes precedence over version', async () => {
  const result = await runCli(['--version', '--help']);
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /Usage:/);
  assert.ok(!/^gha-outdated v\d/.test(result.stdout), 'help wins over version');
});

test('unsupported arguments exit 2 and do no scanning', async () => {
  const client = fakeClient({});
  const result = await runCli(['--frobnicate', '-m'], {
    cwd: fixture('stale'),
    client,
  });
  assert.equal(result.code, EXIT_ERROR);
  assert.match(result.stderr, /Unknown option\(s\): --frobnicate/);
  assert.equal(client.calls.length, 0, 'no lookups after usage error');
  assert.equal(result.stdout, '', 'no scan output on usage error');
});

test('no workflow files is a successful, clearly worded outcome', async () => {
  const result = await runCli([], { cwd: fixture('no-workflows'), client: fakeClient({}) });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /No workflow files found/);

  const empty = await runCli([], { cwd: fixture('empty'), client: fakeClient({}) });
  assert.equal(empty.code, EXIT_OK);
});

test('clean fixture reports up to date and exits 0', async () => {
  const client = fakeClient({
    'actions/checkout': 'v4.1.2',
    'actions/setup-node': 'v4.9.9',
  });
  const result = await runCli([], { cwd: fixture('clean'), client });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /2 checked, 0 outdated, 0 skipped, 0 failed/);
  assert.match(result.stdout, /All checked GitHub Actions are up to date\./);
});

test('outdated fixture lists findings and exits 1', async () => {
  const client = fakeClient({
    'actions/checkout': 'v4.2.2',
    'actions/setup-node': 'v4.1.0',
    'actions/cache': 'v1.0.0',
  });
  const result = await runCli([], { cwd: fixture('stale'), client });
  assert.equal(result.code, EXIT_OUTDATED);
  assert.match(result.stdout, /actions\/checkout@v1 \(MAJOR UPDATE\)/);
  assert.match(result.stdout, /current: v1 -> latest: v4\.2\.2/);
  assert.match(result.stdout, /actions\/setup-node@v1 \(MAJOR UPDATE\)/);
  assert.match(result.stdout, /3 checked, 2 outdated, 0 skipped, 0 failed/);
  assert.ok(!result.stdout.includes('up to date!'));
});

test('--major filters findings to strictly greater latest majors', async () => {
  const client = fakeClient({
    'actions/checkout': 'v4.9.0', // same major as pinned v4.1.2 -> filtered
    'actions/setup-node': 'v5.0.0', // major update over v4
  });
  const result = await runCli(['-m'], { cwd: fixture('clean'), client });
  assert.equal(result.code, EXIT_OUTDATED);
  assert.match(result.stdout, /Mode: major version updates only/);
  assert.match(result.stdout, /actions\/setup-node@v4 \(MAJOR UPDATE\)/);
  assert.ok(!result.stdout.includes('actions/checkout@v4.1.2 ('));
});

test('mixed fixture skips non-comparable refs with visible reasons', async () => {
  const client = fakeClient({
    'octo-org/example-repo': 'v2.1.0',
    'actions/checkout': 'v4.9.9',
    'actions/setup-node': 'v4.1.0',
    'octo-org/tool': 'v1.2.3',
  });
  const result = await runCli([], { cwd: fixture('mixed'), client });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /Skipped references \(not comparable\):/);
  assert.match(result.stdout, /\.\/local\/action - local action/);
  assert.match(result.stdout, /docker:\/\/alpine:3\.20 - Docker image/);
  assert.match(result.stdout, /pinned\/action@8f4b7f8.* - pinned to a commit SHA/);
  assert.match(result.stdout, /dynamic\/action@\$\{\{ inputs\.version \}\} - ref uses a workflow expression/);
  assert.match(result.stdout, /branchy\/action@main - unsupported ref/);
  assert.match(result.stdout, /broken-no-ref@ - unrecognized uses: value/);
  assert.match(result.stdout, /4 checked, 0 outdated, 6 skipped, 0 failed/);
  // floating v4 with latest v4.9.9 stays current; reusable workflow checked via repo
  assert.deepEqual(
    new Set(client.calls),
    new Set(['octo-org/example-repo', 'actions/checkout', 'actions/setup-node', 'octo-org/tool'])
  );
});

test('repositories without comparable tags are skipped, not failed', async () => {
  const client = fakeClient({
    'actions/checkout': null,
    'actions/setup-node': 'v4.0.0',
  });
  const result = await runCli([], { cwd: fixture('clean'), client });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /no stable numeric tags/);
  assert.match(result.stdout, /1 checked, 0 outdated, 1 skipped, 0 failed/);
});

test('any lookup failure exits 2 and never claims all up to date', async () => {
  const client = fakeClient({
    'actions/checkout': new LookupError('actions/checkout', 'request timed out after 10000ms'),
    'actions/setup-node': 'v9.0.0',
  });
  const result = await runCli([], { cwd: fixture('clean'), client });
  assert.equal(result.code, EXIT_ERROR);
  assert.match(result.stderr, /Failed lookups:/);
  assert.match(result.stderr, /timed out/);
  assert.match(result.stderr, /results may be incomplete/);
  assert.ok(!result.stdout.includes('up to date'));
  // the outdated finding is still visible even though the run failed overall
  assert.match(result.stdout, /actions\/setup-node@v4 \(MAJOR UPDATE\)/);
});

test('unreadable workflow files are operational failures (exit 2)', async () => {
  const fakeFs = {
    existsSync: () => true,
    readdirSync: () => [
      { name: 'flow.yml', isFile: () => true },
    ],
    readFileSync: () => {
      throw new Error('EACCES: permission denied');
    },
  };
  const result = await runCli([], {
    cwd: fixture('clean'),
    fs: fakeFs,
    client: fakeClient({}),
  });
  assert.equal(result.code, EXIT_ERROR);
  assert.match(result.stderr, /Unable to read workflow file/);
  assert.match(result.stderr, /could not be completed/);
});

test('workflows with no uses references succeed with a clear message', async () => {
  const fakeFs = {
    existsSync: () => true,
    readdirSync: () => [{ name: 'flow.yml', isFile: () => true }],
    readFileSync: () => 'name: Nothing\non: [push]\njobs: {}\n',
  };
  const result = await runCli([], { cwd: fixture('clean'), fs: fakeFs, client: fakeClient({}) });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /No supported action references found/);
});

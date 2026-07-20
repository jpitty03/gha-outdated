'use strict';

/**
 * Argument parsing and orchestration for the `gha-outdated` CLI.
 *
 * Exit contract:
 *   0 - complete clean check (or valid `--help`)
 *   1 - confirmed outdated refs
 *   2 - invalid usage, or any incomplete/operational failure
 *
 * All environment interaction (working directory, filesystem, env vars,
 * output streams, GitHub client) is injectable so tests never depend on the
 * developer's repository, the live GitHub API, or global process mutation.
 */

const versions = require('./versions');
const workflows = require('./workflows');
const { GitHubClient, mapWithConcurrency } = require('./github');

const EXIT_OK = 0;
const EXIT_OUTDATED = 1;
const EXIT_ERROR = 2;

const LOOKUP_CONCURRENCY = 4;

const SKIP_REASONS = {
  local: 'local action (not a repository ref)',
  docker: 'Docker image reference',
  malformed: 'unrecognized uses: value',
  'commit-sha': 'pinned to a commit SHA (not comparable)',
  expression: 'ref uses a workflow expression',
  unsupported: 'unsupported ref (not a numeric version)',
  'no-tags': 'repository has no stable numeric tags to compare',
};

/**
 * Parse CLI arguments. Unknown arguments are collected, never ignored.
 *
 * @param {string[]} argv
 * @returns {{ help: boolean, version: boolean, majorOnly: boolean, invalid: string[] }}
 */
function parseArgs(argv) {
  const parsed = { help: false, version: false, majorOnly: false, invalid: [] };
  for (const arg of argv) {
    if (arg === '-h' || arg === '-H' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '-v' || arg === '-V' || arg === '--version') {
      parsed.version = true;
    } else if (arg === '-m' || arg === '-M' || arg === '--major') {
      parsed.majorOnly = true;
    } else {
      parsed.invalid.push(arg);
    }
  }
  return parsed;
}

function usage() {
  return `gha-outdated - Check for outdated GitHub Actions in workflow files

Usage:
  npx gha-outdated [options]

Options:
  -m, -M, --major    Only report actions with a newer major version
  -v, -V, --version  Print the installed version
  -h, -H, --help     Show this help message

Environment:
  GITHUB_TOKEN       Optional token for authenticated GitHub API requests
                     (raises the rate limit; never printed)

Exit codes:
  0  all checked actions are up to date
  1  outdated actions were found
  2  invalid usage or the check could not be completed`;
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv arguments after the executable and script name
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {{ write(chunk: string): void }} [options.stdout]
 * @param {{ write(chunk: string): void }} [options.stderr]
 * @param {typeof import('fs')} [options.fs]
 * @param {{ getLatestVersion(repo: string): Promise<object|null> }} [options.client]
 * @returns {Promise<number>} exit code
 */
async function run(argv, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const fs = options.fs || require('fs');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const out = (line) => stdout.write(`${line}\n`);
  const err = (line) => stderr.write(`${line}\n`);

  const parsed = parseArgs(argv);
  if (parsed.invalid.length > 0) {
    err(`Unknown option(s): ${parsed.invalid.join(' ')}`);
    err('');
    err(usage());
    return EXIT_ERROR;
  }
  if (parsed.help) {
    out(usage());
    return EXIT_OK;
  }
  if (parsed.version) {
    out(`gha-outdated v${require('../package.json').version}`);
    return EXIT_OK;
  }

  const client =
    options.client || new GitHubClient({ token: env.GITHUB_TOKEN });

  out('Checking for outdated GitHub Actions...');
  if (parsed.majorOnly) {
    out('Mode: major version updates only');
  }

  const files = workflows.findWorkflowFiles(cwd, { fs });
  if (files.length === 0) {
    out('No workflow files found in .github/workflows.');
    return EXIT_OK;
  }
  out(`Found ${files.length} workflow file(s).`);

  let references;
  try {
    references = workflows.collectReferences(files, { fs });
  } catch (error) {
    err(error.message);
    err('The check could not be completed.');
    return EXIT_ERROR;
  }

  const skipped = [];
  const candidates = [];
  for (const reference of references) {
    if (reference.kind !== 'action') {
      skipped.push({ reference, reason: SKIP_REASONS[reference.kind] });
      continue;
    }
    const classification = versions.classifyRef(reference.ref);
    if (classification !== 'numeric') {
      skipped.push({ reference, reason: SKIP_REASONS[classification] });
      continue;
    }
    candidates.push({
      reference,
      current: versions.parseVersion(reference.ref),
    });
  }

  if (candidates.length === 0 && skipped.length === 0) {
    out('No supported action references found in workflow files.');
    return EXIT_OK;
  }
  out(`Found ${references.length} unique reference(s); checking ${candidates.length}.`);

  const results = await mapWithConcurrency(
    candidates,
    LOOKUP_CONCURRENCY,
    async (candidate) => {
      try {
        const latest = await client.getLatestVersion(candidate.reference.repo);
        return { candidate, latest };
      } catch (error) {
        return { candidate, error };
      }
    }
  );

  const outdated = [];
  const failed = [];
  let checked = 0;
  for (const result of results) {
    if (result.error) {
      failed.push(result);
      continue;
    }
    if (result.latest === null) {
      skipped.push({
        reference: result.candidate.reference,
        reason: SKIP_REASONS['no-tags'],
      });
      continue;
    }
    checked += 1;
    const { current } = result.candidate;
    const latestVersion = result.latest.version;
    if (!versions.isOutdated(current, latestVersion)) {
      continue;
    }
    const isMajor = versions.isMajorUpdate(current, latestVersion);
    if (parsed.majorOnly && !isMajor) {
      continue;
    }
    outdated.push({ ...result, isMajor });
  }

  if (outdated.length > 0) {
    out('');
    out('Outdated actions:');
    out('-----------------');
    for (const entry of outdated) {
      const label = entry.isMajor ? 'MAJOR UPDATE' : 'update available';
      out(`${entry.candidate.reference.uses} (${label})`);
      out(`  current: ${entry.candidate.reference.ref} -> latest: ${entry.latest.tag}`);
    }
  }

  if (skipped.length > 0) {
    out('');
    out('Skipped references (not comparable):');
    for (const entry of skipped) {
      out(`  ${entry.reference.uses} - ${entry.reason}`);
    }
  }

  if (failed.length > 0) {
    err('');
    err('Failed lookups:');
    for (const entry of failed) {
      err(`  ${entry.candidate.reference.uses} - ${entry.error.message}`);
    }
  }

  out('');
  out(
    `Summary: ${checked} checked, ${outdated.length} outdated, ` +
      `${skipped.length} skipped, ${failed.length} failed.`
  );

  if (failed.length > 0) {
    err('The check did not complete for every action; results may be incomplete.');
    return EXIT_ERROR;
  }
  if (outdated.length > 0) {
    return EXIT_OUTDATED;
  }
  out(
    parsed.majorOnly
      ? 'No major version updates found for checked GitHub Actions.'
      : 'All checked GitHub Actions are up to date.'
  );
  return EXIT_OK;
}

module.exports = {
  parseArgs,
  usage,
  run,
  EXIT_OK,
  EXIT_OUTDATED,
  EXIT_ERROR,
};

'use strict';

/**
 * Import-safe library entry point. Requiring this module performs no I/O,
 * makes no network requests, and never calls `process.exit()`.
 */

const cli = require('./cli');
const github = require('./github');
const versions = require('./versions');
const workflows = require('./workflows');

module.exports = {
  run: cli.run,
  parseArgs: cli.parseArgs,
  usage: cli.usage,
  EXIT_OK: cli.EXIT_OK,
  EXIT_OUTDATED: cli.EXIT_OUTDATED,
  EXIT_ERROR: cli.EXIT_ERROR,
  GitHubClient: github.GitHubClient,
  LookupError: github.LookupError,
  versions,
  workflows,
};

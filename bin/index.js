#!/usr/bin/env node

'use strict';

const { run, EXIT_ERROR } = require('../lib/cli');

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = EXIT_ERROR;
  }
);

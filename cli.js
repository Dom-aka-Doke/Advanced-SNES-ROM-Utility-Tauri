#!/usr/bin/env node
'use strict';

// Command line entry point (Node.js)
// Usage: node cli.js -path "C:\ROMs" -recursive -header add -patch "C:\Patches\patch.ips" -fixchecksum

const { run, terminalCopierPrompt } = require('./lib/cli/commandline');

const code = run(process.argv.slice(2), { chooseCopier: terminalCopierPrompt });
process.exitCode = code;

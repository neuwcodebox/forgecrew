#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeCommand } from './cli/index.ts';

executeCommand(process.argv.slice(2), dirname(dirname(fileURLToPath(import.meta.url)))).catch(
  (error) => {
    const reason =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : 'invalid_configuration_or_operation';
    console.error('Worker command failed: ' + reason);
    process.exitCode = 1;
  },
);

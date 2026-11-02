import { readFileSync } from 'node:fs';

// src/ and dist/ share the same package root; staged packages retain package.json.
export const workerVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

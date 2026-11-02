import { defineConfig } from 'tsdown';

export default defineConfig({
  cwd: process.cwd(),
  platform: 'node',
  target: 'node24',
  format: 'esm',
  fixedExtension: false,
  clean: true,
  dts: false,
  deps: {
    neverBundle: ['better-sqlite3'],
    alwaysBundle: [/^(?!better-sqlite3(?:\/|$)).+/],
    onlyImport: ['better-sqlite3'],
    onlyBundle: false,
  },
});

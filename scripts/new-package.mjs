#!/usr/bin/env node
/**
 * Scaffold a workspace package with the conventions this monorepo expects.
 *
 * Idempotent: an existing file is left alone, so re-running after adding a package to the
 * list is safe and will only create what is missing.
 *
 * Usage:
 *   node scripts/new-package.mjs <name> "<description>" [dep ...]
 *   node scripts/new-package.mjs --all      # create every package in PACKAGES below
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The package set for the walking-skeleton slice. Blueprint module numbers in the descriptions. */
const PACKAGES = [
  ['db', 'Prisma client singleton and schema access. The only package that talks to Postgres directly.', []],
  ['ledger', '11.3 Event Ledger. Append-only, hash-chained, signed.', ['db']],
  ['identity', '11.1 Identity & Access. Actors, roles, Authority Levels.', ['db']],
  ['tenancy', '11.2 Tenant / Organization Model. Isolation enforcement.', ['db']],
  ['clients', '1.1 Client Lifecycle & CRM. Client record and compliance categorical state.', ['db', 'ledger']],
  ['consent', '1.5 Consent & Authorization Center. Per-application, per-pull, per-connection.', ['db', 'ledger']],
  ['firewall', '6.2 Funding Ethics Firewall. Precedence over all placement modules.', ['db', 'ledger', 'clients']],
  ['integration', '11.5 Integration Layer / API Gateway. The only path to an external service.', []],
  ['middleware', 'The fixed seven-step middleware chain (Specification v2 section 5.5).', ['ledger', 'identity', 'tenancy', 'clients', 'firewall']],
  ['placement', '5.3 Funding Recommendation Engine. Refusal path for the walking skeleton.', ['ledger', 'clients', 'consent', 'firewall', 'integration', 'middleware']],
];

function createPackage(name, description, deps) {
  const dir = join(repoRoot, 'packages', name);
  mkdirSync(join(dir, 'src'), { recursive: true });

  const dependencies = Object.fromEntries(
    ['core', ...deps].map((dep) => [`@bwc/${dep}`, 'workspace:*']),
  );

  const files = {
    'package.json': `${JSON.stringify(
      {
        name: `@bwc/${name}`,
        version: '0.1.0',
        private: true,
        description,
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        scripts: {
          build: 'tsc -p tsconfig.json',
          typecheck: 'tsc -p tsconfig.json --noEmit',
        },
        dependencies,
        devDependencies: { typescript: '^5.8.3' },
      },
      null,
      2,
    )}\n`,

    'tsconfig.json': `${JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          rootDir: './src',
          outDir: './dist',
          tsBuildInfoFile: './dist/.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
        references: ['core', ...deps].map((dep) => ({ path: `../${dep}` })),
      },
      null,
      2,
    )}\n`,
  };

  const created = [];
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, file);
    if (existsSync(path)) continue;
    writeFileSync(path, content, 'utf8');
    created.push(`packages/${name}/${file}`);
  }
  return created;
}

const [, , first, ...rest] = process.argv;

if (!first) {
  console.error('usage: node scripts/new-package.mjs <name> "<description>" [dep ...]  |  --all');
  process.exit(1);
}

const targets =
  first === '--all' ? PACKAGES : [[first, rest[0] ?? `@bwc/${first}`, rest.slice(1)]];

const created = targets.flatMap(([name, description, deps]) =>
  createPackage(name, description, deps),
);

if (created.length === 0) {
  console.log('nothing to create - all packages already present');
} else {
  console.log(`created ${created.length} file(s):`);
  for (const file of created) console.log(`  ${file}`);
}

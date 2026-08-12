/**
 * A workspace dependency is declared in two files, and only one of them is CI.
 *
 * **This is the defect that has cost four red builds.** Adding `@bwc/x` to a package means editing
 * `package.json`, which is what pnpm links and what turbo orders builds from, AND the `references`
 * array in `tsconfig.json`, which is what TypeScript's project-references build reads. Edit one and
 * not the other and:
 *
 *   `pnpm typecheck`      passes - turbo orders from package.json, so the dist is already there
 *   `pnpm test`           passes - vitest aliases `@bwc/*` straight to src
 *   `tsc -b apps/api`     FAILS   - and this is the one CI runs
 *
 * The error it produces is `Cannot find module '@bwc/x' or its corresponding type declarations`,
 * followed by a cascade of `TS7006 implicitly has an 'any' type` from every value that module was
 * supposed to type. None of it names the real cause, which is a file nobody edited.
 *
 * ## Why a test rather than a lint rule or a CI step
 *
 * `tsc -b` already catches it, in CI, after a push, having burned four minutes - and only for the
 * subgraph `apps/api` reaches. A package deep in the tree whose mismatch nothing imports is not
 * caught at all. This runs in `pnpm verify` before the push, covers **every** workspace unit, and
 * fails with the line to add rather than with a missing-module error.
 *
 * ## Both directions, and the second one is not symmetry for its own sake
 *
 * A dependency with no reference breaks `tsc -b`. A reference with no dependency is the opposite
 * failure and quieter: TypeScript resolves the types and pnpm never links the package, so it
 * compiles and then throws `Cannot find module` at runtime, in whichever environment happens to
 * exercise that line first.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The repository root, from this file. */
const ROOT = join(import.meta.dirname, '..', '..');

interface Unit {
  /** `packages/identity`, `apps/api` - what a failure message names. */
  readonly label: string;
  readonly directory: string;
  readonly packageName: string;
  /** `@bwc/*` from dependencies and devDependencies both. */
  readonly declared: ReadonlySet<string>;
  /** `@bwc/*` resolved from each `references` path, or null when there is no tsconfig. */
  readonly referenced: ReadonlySet<string> | null;
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/**
 * The package name a reference points at, read from ITS package.json.
 *
 * Resolved rather than derived from the directory name. They agree today, and a check that assumed
 * they always would could not tell a reference pointing somewhere unexpected from a correct one -
 * which is exactly the class of mistake this file exists to catch.
 */
const nameOfReference = (fromDirectory: string, path: string): string | null => {
  const manifest = join(fromDirectory, path, 'package.json');
  try {
    const name = readJson(manifest)['name'];
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
};

const workspaceUnits = (): readonly Unit[] => {
  const units: Unit[] = [];

  for (const base of ['packages', 'apps']) {
    const baseDirectory = join(ROOT, base);
    for (const name of readdirSync(baseDirectory).sort()) {
      const directory = join(baseDirectory, name);
      if (!statSync(directory).isDirectory()) continue;

      let manifest: Record<string, unknown>;
      try {
        manifest = readJson(join(directory, 'package.json'));
      } catch {
        continue;
      }

      const dependencies = {
        ...((manifest['dependencies'] as Record<string, string>) ?? {}),
        ...((manifest['devDependencies'] as Record<string, string>) ?? {}),
      };
      const declared = new Set(Object.keys(dependencies).filter((key) => key.startsWith('@bwc/')));

      let referenced: Set<string> | null = null;
      try {
        const tsconfig = readJson(join(directory, 'tsconfig.json'));
        const references = (tsconfig['references'] as { path: string }[] | undefined) ?? [];
        referenced = new Set(
          references
            .map((reference) => nameOfReference(directory, reference.path))
            .filter((value): value is string => value !== null),
        );
      } catch {
        referenced = null;
      }

      units.push({
        label: `${base}/${name}`,
        directory,
        packageName: typeof manifest['name'] === 'string' ? manifest['name'] : `${base}/${name}`,
        declared,
        referenced,
      });
    }
  }

  return units;
};

const UNITS = workspaceUnits();

describe('a workspace dependency is declared in both files or in neither', () => {
  it('finds the workspace at all, so a passing suite is not an empty one', () => {
    // A glob that matched nothing would make every assertion below vacuously true, which is the
    // way a structural check quietly stops checking.
    expect(UNITS.length).toBeGreaterThan(20);
    expect(UNITS.some((unit) => unit.label === 'apps/api')).toBe(true);
  });

  it.each(
    UNITS.filter((unit) => unit.referenced !== null).map((unit) => [unit.label, unit] as const),
  )('%s references every @bwc dependency it declares', (_label, unit) => {
    const missing = [...unit.declared].filter((name) => !unit.referenced?.has(name)).sort();

    expect(
      missing,
      missing.length === 0
        ? ''
        : [
            `${unit.label}/package.json depends on ${missing.join(', ')} and ${unit.label}/tsconfig.json does not reference ${missing.length === 1 ? 'it' : 'them'}.`,
            '',
            'pnpm typecheck and pnpm test will both pass. `tsc -b apps/api`, which is what CI runs, will not:',
            `it reports "Cannot find module '${missing[0] ?? ''}'" and then a cascade of implicit-any errors from every value that module was meant to type.`,
            '',
            `Add to ${unit.label}/tsconfig.json "references":`,
            ...missing.map(
              (name) => `  { "path": "<relative path to packages/${name.replace('@bwc/', '')}>" }`,
            ),
          ].join('\n'),
    ).toEqual([]);
  });

  it.each(
    UNITS.filter((unit) => unit.referenced !== null).map((unit) => [unit.label, unit] as const),
  )('%s declares every @bwc project it references', (_label, unit) => {
    const undeclared = [...(unit.referenced ?? [])]
      .filter((name) => !unit.declared.has(name))
      .sort();

    expect(
      undeclared,
      undeclared.length === 0
        ? ''
        : [
            `${unit.label}/tsconfig.json references ${undeclared.join(', ')} and ${unit.label}/package.json does not depend on ${undeclared.length === 1 ? 'it' : 'them'}.`,
            '',
            'This is the quieter direction. TypeScript resolves the types and pnpm never links the package, so it compiles and then throws',
            '"Cannot find module" at RUNTIME, in whichever environment exercises that line first.',
            '',
            `Add to ${unit.label}/package.json "dependencies":`,
            ...undeclared.map((name) => `  "${name}": "workspace:*"`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('has a tsconfig for every unit that depends on another package', () => {
    // A unit with @bwc dependencies and no tsconfig at all cannot be built by project references,
    // and the two lists above would skip it silently.
    const unbuildable = UNITS.filter((unit) => unit.referenced === null && unit.declared.size > 0);

    expect(
      unbuildable.map((unit) => unit.label),
      'These depend on workspace packages and have no readable tsconfig.json, so nothing checks their references.',
    ).toEqual([]);
  });
});

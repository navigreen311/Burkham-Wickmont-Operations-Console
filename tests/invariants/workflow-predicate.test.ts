/**
 * Invariant: decision points cannot execute arbitrary code, and a malformed predicate refuses
 * rather than silently evaluating false.
 *
 * A playbook is editable by non-technical admins through the Playbook Builder (2.5) and stored
 * as JSON. If a branch condition were an expression string, publishing a playbook would be a
 * code-execution path into a system holding SSNs and bank data.
 *
 * The second half matters as much as the first: a broken predicate treated as `false` takes the
 * `otherwise` branch, so a workflow runs the wrong path and nothing reports a problem.
 */

import { describe, expect, it } from 'vitest';
import { PREDICATE_OPERATORS, evaluate, type Predicate } from '@bwc/workflow';

const scope = {
  client: { complianceState: 'pass', legalName: 'Acme LLC' },
  context: { documentsReceived: 3, nested: { depth: 2 } },
  instance: { playbookVersion: 1 },
};

describe('predicate evaluation is sandboxed', () => {
  it('cannot reach anything outside the three declared roots', () => {
    for (const field of [
      'process.env.DATABASE_URL',
      'global.process',
      'require',
      'this.constructor',
    ]) {
      const result = evaluate({ field, op: 'exists' }, scope);
      expect(result.ok && result.value, `${field} must not resolve`).toBe(false);
    }
  });

  it('refuses to walk the prototype chain', () => {
    for (const field of [
      'context.__proto__',
      'context.constructor',
      'context.nested.constructor.prototype',
    ]) {
      const result = evaluate({ field, op: 'exists' }, scope);
      expect(result.ok && result.value, `${field} must not resolve`).toBe(false);
    }
  });

  it('refuses an unknown operator instead of defaulting to false', () => {
    // The dangerous shape: an operator someone expected to exist, silently taking `otherwise`.
    const result = evaluate(
      { field: 'client.complianceState', op: 'matches' } as unknown as Predicate,
      scope,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown operator/i);
  });

  it('refuses ordered comparison on strings, which would smuggle in ordinality', () => {
    // `gte` on compliance state would reintroduce exactly the ranking Decision E removed.
    const result = evaluate(
      { field: 'client.complianceState', op: 'gte', value: 'needs_review' },
      scope,
    );
    expect(result.ok).toBe(false);
  });

  it('propagates a malformed nested predicate rather than swallowing it', () => {
    const result = evaluate(
      {
        all: [
          { field: 'context.documentsReceived', op: 'gte', value: 1 },
          { field: 'x', op: 'nope' } as unknown as Predicate,
        ],
      },
      scope,
    );
    expect(result.ok).toBe(false);
  });
});

describe('predicate evaluation is correct', () => {
  it('evaluates membership and equality', () => {
    expect(
      evaluate(
        { field: 'client.complianceState', op: 'in', value: ['pass', 'pass_with_findings'] },
        scope,
      ),
    ).toEqual({ ok: true, value: true });
    expect(evaluate({ field: 'client.complianceState', op: 'eq', value: 'fail' }, scope)).toEqual({
      ok: true,
      value: false,
    });
    expect(
      evaluate({ field: 'client.complianceState', op: 'not_in', value: ['fail'] }, scope),
    ).toEqual({ ok: true, value: true });
  });

  it('evaluates ordered comparison on numbers and dates', () => {
    expect(evaluate({ field: 'context.documentsReceived', op: 'gte', value: 3 }, scope)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluate({ field: 'context.documentsReceived', op: 'gt', value: 3 }, scope)).toEqual({
      ok: true,
      value: false,
    });

    const dated = { context: { openedAt: new Date('2026-01-01') } };
    expect(
      evaluate({ field: 'context.openedAt', op: 'lt', value: new Date('2026-06-01') }, dated),
    ).toEqual({ ok: true, value: true });
  });

  it('composes with all, any and not', () => {
    expect(
      evaluate(
        {
          all: [
            { field: 'client.complianceState', op: 'in', value: ['pass'] },
            { field: 'context.documentsReceived', op: 'gte', value: 3 },
          ],
        },
        scope,
      ),
    ).toEqual({ ok: true, value: true });

    expect(
      evaluate(
        {
          any: [
            { field: 'client.complianceState', op: 'eq', value: 'fail' },
            { field: 'context.documentsReceived', op: 'eq', value: 3 },
          ],
        },
        scope,
      ),
    ).toEqual({ ok: true, value: true });
    expect(
      evaluate({ not: { field: 'client.complianceState', op: 'eq', value: 'fail' } }, scope),
    ).toEqual({ ok: true, value: true });
  });

  it('treats a missing field as absent rather than throwing', () => {
    expect(evaluate({ field: 'context.neverSet', op: 'not_exists' }, scope)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluate({ field: 'context.neverSet', op: 'eq', value: 1 }, scope)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('exposes exactly the operators it documents', () => {
    expect([...PREDICATE_OPERATORS].sort()).toEqual([
      'eq',
      'exists',
      'gt',
      'gte',
      'in',
      'lt',
      'lte',
      'neq',
      'not_exists',
      'not_in',
    ]);
  });
});

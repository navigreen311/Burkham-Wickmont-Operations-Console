/**
 * Decision-point predicates - Specification v2 §5.3, "Decision point evaluation ... Evaluates
 * against client state, compliance state, and workflow context."
 *
 * Declarative, and deliberately not a JavaScript expression. A playbook is editable through the
 * Playbook Builder (2.5) by non-technical admins, and its definition is stored as JSON; if a
 * branch condition were an expression string, publishing a playbook would be a code-execution
 * path into a system holding SSNs and bank data. There is no `eval`, no `Function`, and no
 * template interpolation anywhere in this file.
 *
 * The cost is a small language. That is the right trade: a branch that cannot be expressed here
 * is a branch that should be a decision node with an explicit operator added to this file, where
 * it gets a name, a test, and a review.
 */

export const PREDICATE_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'not_exists',
] as const;

export type PredicateOperator = (typeof PREDICATE_OPERATORS)[number];

export const isPredicateOperator = (value: unknown): value is PredicateOperator =>
  typeof value === 'string' && (PREDICATE_OPERATORS as readonly string[]).includes(value);

export interface Comparison {
  readonly field: string;
  readonly op: PredicateOperator;
  readonly value?: unknown;
}

export interface AllOf {
  readonly all: readonly Predicate[];
}

export interface AnyOf {
  readonly any: readonly Predicate[];
}

export interface Not {
  readonly not: Predicate;
}

export type Predicate = Comparison | AllOf | AnyOf | Not;

/** The facts a predicate may read. Nothing else is reachable from a playbook. */
export interface EvaluationScope {
  readonly client?: Record<string, unknown>;
  readonly context?: Record<string, unknown>;
  readonly instance?: Record<string, unknown>;
}

export type EvaluationResult =
  { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly reason: string };

const ROOTS = ['client', 'context', 'instance'] as const;

/**
 * Resolve a dotted path against the scope.
 *
 * Only the three declared roots are reachable, so a playbook cannot address `process.env` or
 * anything else that happens to be in scope at the call site. Prototype keys are rejected
 * outright rather than resolved: `constructor.prototype` on a plain object would otherwise walk
 * out of the data and into the runtime.
 */
const resolve = (scope: EvaluationScope, path: string): { found: boolean; value: unknown } => {
  const segments = path.split('.');
  const [root, ...rest] = segments;

  if (root === undefined || !(ROOTS as readonly string[]).includes(root)) {
    return { found: false, value: undefined };
  }

  let current: unknown = (scope as Record<string, unknown>)[root];

  for (const segment of rest) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return { found: false, value: undefined };
    }
    if (current === null || current === undefined || typeof current !== 'object') {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
};

const isComparison = (predicate: Predicate): predicate is Comparison =>
  typeof predicate === 'object' && predicate !== null && 'field' in predicate && 'op' in predicate;

const compareOrdered = (
  op: 'gt' | 'gte' | 'lt' | 'lte',
  left: unknown,
  right: unknown,
): EvaluationResult => {
  // Ordered comparison is defined for numbers and dates only. Strings would silently give
  // lexicographic ordering, and a playbook comparing compliance states that way would
  // reintroduce the ordinal semantics Decision E removed.
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;

  if (typeof leftValue !== 'number' || typeof rightValue !== 'number') {
    return {
      ok: false,
      reason: `Operator '${op}' is defined for numbers and dates only; received ${typeof leftValue} and ${typeof rightValue}.`,
    };
  }

  switch (op) {
    case 'gt':
      return { ok: true, value: leftValue > rightValue };
    case 'gte':
      return { ok: true, value: leftValue >= rightValue };
    case 'lt':
      return { ok: true, value: leftValue < rightValue };
    case 'lte':
      return { ok: true, value: leftValue <= rightValue };
  }
};

/**
 * Evaluate a predicate.
 *
 * Returns a result rather than throwing or defaulting to false. A malformed predicate is a
 * playbook authoring error, and silently treating it as false would take the `otherwise` branch
 * — a workflow quietly running the wrong path, which is worse than one that stops and says the
 * predicate is broken.
 */
export const evaluate = (predicate: Predicate, scope: EvaluationScope): EvaluationResult => {
  if (typeof predicate !== 'object' || predicate === null) {
    return { ok: false, reason: 'Predicate must be an object.' };
  }

  if ('all' in predicate) {
    if (!Array.isArray(predicate.all)) return { ok: false, reason: "'all' must be an array." };
    for (const child of predicate.all) {
      const result = evaluate(child, scope);
      if (!result.ok) return result;
      if (!result.value) return { ok: true, value: false };
    }
    return { ok: true, value: true };
  }

  if ('any' in predicate) {
    if (!Array.isArray(predicate.any)) return { ok: false, reason: "'any' must be an array." };
    for (const child of predicate.any) {
      const result = evaluate(child, scope);
      if (!result.ok) return result;
      if (result.value) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }

  if ('not' in predicate) {
    const result = evaluate(predicate.not, scope);
    return result.ok ? { ok: true, value: !result.value } : result;
  }

  if (!isComparison(predicate)) {
    return { ok: false, reason: 'Predicate must be a comparison, all, any, or not.' };
  }

  if (!isPredicateOperator(predicate.op)) {
    return {
      ok: false,
      reason: `Unknown operator '${String(predicate.op)}'. Known operators: ${PREDICATE_OPERATORS.join(', ')}.`,
    };
  }

  const { found, value: actual } = resolve(scope, predicate.field);

  switch (predicate.op) {
    case 'exists':
      return { ok: true, value: found && actual !== null && actual !== undefined };
    case 'not_exists':
      return { ok: true, value: !found || actual === null || actual === undefined };
    case 'eq':
      return { ok: true, value: found && actual === predicate.value };
    case 'neq':
      return { ok: true, value: !found || actual !== predicate.value };
    case 'in':
      if (!Array.isArray(predicate.value)) {
        return { ok: false, reason: "Operator 'in' requires an array value." };
      }
      return { ok: true, value: found && predicate.value.includes(actual) };
    case 'not_in':
      if (!Array.isArray(predicate.value)) {
        return { ok: false, reason: "Operator 'not_in' requires an array value." };
      }
      return { ok: true, value: !found || !predicate.value.includes(actual) };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (!found) {
        return { ok: false, reason: `Field '${predicate.field}' is not present in scope.` };
      }
      return compareOrdered(predicate.op, actual, predicate.value);
  }
};

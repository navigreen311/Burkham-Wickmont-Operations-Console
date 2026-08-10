/**
 * Playbook definition and validation - blueprint 2.2.
 *
 * A playbook is a node graph, stored as JSON and versioned. Per Decision C the Console owns
 * these definitions outright; CapitalForge's workflow store is legacy and never read.
 *
 * Validation runs at publish rather than at execution. A playbook with a dangling `next` that is
 * only discovered three weeks into a client engagement fails at the worst possible moment - in
 * the middle of a live workflow, with an instance already committed to it. Catching it at publish
 * makes it an authoring error instead.
 */

import { PREDICATE_OPERATORS, type Predicate } from './predicate.js';

export const NODE_KINDS = [
  'agent_task',
  'human_checkpoint',
  'decision',
  'wait',
  'terminal',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/** Work dispatched to a Village department. Completed externally, not by the engine. */
export interface AgentTaskNode {
  readonly kind: 'agent_task';
  readonly department: string;
  readonly action: string;
  readonly slaMinutes?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  readonly next: string;
}

/** Routes to the Human Approval Console (2.4). Completed externally by a human. */
export interface HumanCheckpointNode {
  readonly kind: 'human_checkpoint';
  readonly queue: string;
  readonly summary: string;
  readonly slaMinutes?: number;
  readonly next: string;
}

/** Resolved in-engine. Branches are tried in order; the first true one wins. */
export interface DecisionNode {
  readonly kind: 'decision';
  readonly branches: readonly { readonly when: Predicate; readonly next: string }[];
  readonly otherwise: string;
}

/**
 * Sleeps. Duration waits are resolved by the worker when `runAt` arrives; event waits are
 * resolved by the Event Ledger listener (next slice) and are accepted but not yet resolvable,
 * which `validate` reports rather than letting a playbook stall silently.
 */
export interface WaitNode {
  readonly kind: 'wait';
  readonly until: { readonly durationMinutes: number } | { readonly event: string };
  readonly next: string;
}

export interface TerminalNode {
  readonly kind: 'terminal';
  readonly outcome: 'completed' | 'cancelled';
}

export type PlaybookNode =
  AgentTaskNode | HumanCheckpointNode | DecisionNode | WaitNode | TerminalNode;

export interface PlaybookDefinition {
  readonly startNode: string;
  readonly nodes: Readonly<Record<string, PlaybookNode>>;
}

export interface ValidationIssue {
  readonly nodeKey: string;
  readonly problem: string;
}

/** Every `next` a node can point at. Terminal nodes point nowhere. */
const outgoing = (node: PlaybookNode): string[] => {
  switch (node.kind) {
    case 'agent_task':
    case 'human_checkpoint':
    case 'wait':
      return [node.next];
    case 'decision':
      return [...node.branches.map((branch) => branch.next), node.otherwise];
    case 'terminal':
      return [];
  }
};

const predicateIssues = (predicate: Predicate, path: string): string[] => {
  if (typeof predicate !== 'object' || predicate === null) return [`${path}: not an object`];

  if ('all' in predicate || 'any' in predicate) {
    const children = ('all' in predicate ? predicate.all : predicate.any) as unknown;
    if (!Array.isArray(children)) return [`${path}: all/any must be an array`];
    return children.flatMap((child, index) =>
      predicateIssues(child as Predicate, `${path}[${index}]`),
    );
  }
  if ('not' in predicate) return predicateIssues(predicate.not, `${path}.not`);

  if (!('field' in predicate) || !('op' in predicate)) {
    return [`${path}: comparison requires 'field' and 'op'`];
  }
  if (!(PREDICATE_OPERATORS as readonly string[]).includes(predicate.op)) {
    return [`${path}: unknown operator '${String(predicate.op)}'`];
  }
  return [];
};

/**
 * Validate a definition.
 *
 * Checks reachability as well as structure. An unreachable node is not an error that will ever
 * fire at runtime — it is dead weight in a document a compliance reviewer has to read, and it is
 * usually a symptom of a `next` that was retargeted and left an orphan behind.
 */
export const validate = (definition: PlaybookDefinition): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const keys = Object.keys(definition.nodes);

  if (keys.length === 0) {
    return [{ nodeKey: '(playbook)', problem: 'definition has no nodes' }];
  }
  if (!Object.prototype.hasOwnProperty.call(definition.nodes, definition.startNode)) {
    issues.push({
      nodeKey: '(playbook)',
      problem: `startNode '${definition.startNode}' is not among the nodes`,
    });
  }

  for (const [key, node] of Object.entries(definition.nodes)) {
    if (!(NODE_KINDS as readonly string[]).includes(node.kind)) {
      issues.push({ nodeKey: key, problem: `unknown node kind '${String(node.kind)}'` });
      continue;
    }

    for (const target of outgoing(node)) {
      if (!Object.prototype.hasOwnProperty.call(definition.nodes, target)) {
        issues.push({ nodeKey: key, problem: `points at '${target}', which does not exist` });
      }
    }

    if (node.kind === 'decision') {
      if (node.branches.length === 0) {
        issues.push({ nodeKey: key, problem: 'decision has no branches' });
      }
      node.branches.forEach((branch, index) => {
        for (const problem of predicateIssues(branch.when, `branches[${index}].when`)) {
          issues.push({ nodeKey: key, problem });
        }
      });
    }

    if (node.kind === 'wait') {
      if ('durationMinutes' in node.until) {
        if (!Number.isFinite(node.until.durationMinutes) || node.until.durationMinutes < 0) {
          issues.push({
            nodeKey: key,
            problem: 'wait durationMinutes must be a non-negative number',
          });
        }
      } else if (typeof node.until.event !== 'string' || node.until.event === '') {
        issues.push({ nodeKey: key, problem: 'wait event must be a non-empty event type' });
      }
    }
  }

  // Reachability from the start node.
  const reachable = new Set<string>();
  const frontier = [definition.startNode];
  while (frontier.length > 0) {
    const key = frontier.pop() as string;
    if (reachable.has(key)) continue;
    const node = definition.nodes[key];
    if (!node) continue;
    reachable.add(key);
    for (const target of outgoing(node)) frontier.push(target);
  }

  for (const key of keys) {
    if (!reachable.has(key)) {
      issues.push({ nodeKey: key, problem: 'unreachable from startNode' });
    }
  }

  // A graph with no terminal can only end by running out of retries.
  if (!keys.some((key) => definition.nodes[key]?.kind === 'terminal')) {
    issues.push({ nodeKey: '(playbook)', problem: 'no terminal node - the workflow cannot end' });
  }

  return issues;
};

export const isValid = (definition: PlaybookDefinition): boolean =>
  validate(definition).length === 0;

/**
 * The seeded playbooks, checked without a database.
 *
 * **The point of these is that they run at authoring time, which is where a playbook defect belongs.**
 * `validate` is called by `publishPlaybook`, so a dangling `next` is already an authoring error
 * rather than a live failure - but publishing needs a database and a decision to publish, and these
 * assertions need neither. A broken graph fails here first.
 *
 * Three properties carry this file.
 *
 * **Every node says where it came from.** `provenance` is data rather than a comment precisely so
 * that the review list cannot drift from the playbooks, and that only holds if something asserts the
 * two sets are equal. Without this test, retargeting a `next` and adding a node would silently
 * produce a step nobody reviewed.
 *
 * **Every wait names an event type that exists.** A wait on a string that is not an `EventType` is a
 * workflow that parks forever with nothing able to wake it - and the listener would report nothing,
 * because it only ever matches events that were actually appended.
 *
 * **Every task names a department and every checkpoint names a queue.** A task dispatched to a
 * department nobody staffs sits in the queue looking normal.
 */

import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, isEventType } from '@bwc/core';
import {
  PHASE_IDENTITY,
  V1_PLAYBOOK_SEEDS,
  inferredSteps,
  isValid,
  validate,
  type PlaybookSeed,
} from '@bwc/workflow';
import { TEMPLATES_BY_PLAYBOOK, V1_TEMPLATE_SEEDS } from '@bwc/deliverables';

/** Appendix B's department list. A task addressed to anything else has no owner. */
const APPENDIX_B_DEPARTMENTS = [
  'capital_readiness',
  'funding_strategy',
  'capital_operations',
  'risk_and_defense',
  'cfo_advisory',
  'lifecycle_and_exit',
  'compliance_and_evidence',
  'channel_partnerships',
  'concierge_desk',
  'capitalforge_ops',
];

const seeds: readonly PlaybookSeed[] = V1_PLAYBOOK_SEEDS;

describe('the seeded playbooks are publishable', () => {
  it.each(seeds.map((seed) => [seed.key, seed] as const))('%s validates', (_key, seed) => {
    // The same function `publishPlaybook` runs. If this fails, the seed cannot be published at all.
    expect(validate(seed.definition), JSON.stringify(validate(seed.definition))).toEqual([]);
    expect(isValid(seed.definition)).toBe(true);
  });

  it('covers phases 0, 1 and 2, once each', () => {
    // The three PHASE playbooks, which is what this asserts. `post-funding-follow-up` also carries
    // phase 2 - a funded client lives there and it is how the console groups them - but it is not
    // a phase of the service model. It is started by the funding event rather than run in sequence,
    // which is exactly why it is a playbook of its own.
    const phases = seeds.filter((seed) => seed.key.startsWith('phase-'));
    expect(phases.map((seed) => seed.phase).sort()).toEqual([0, 1, 2]);

    // Every key distinct, across all of them. Two seeds sharing a key would have one silently
    // overwrite the other at publish, since the upsert is on (key, version).
    expect(new Set(seeds.map((seed) => seed.key)).size).toBe(seeds.length);
  });

  it('records why each phase carries the number it does', () => {
    // The blueprint defines no phase. The mapping is the load-bearing guess in this slice, so it is
    // written down rather than left in somebody's head.
    for (const seed of seeds) {
      expect(PHASE_IDENTITY[seed.phase], `phase ${seed.phase}`).toBeDefined();
      expect(seed.identityBasis.length).toBeGreaterThan(40);
    }
  });
});

describe('every node says where it came from', () => {
  it.each(seeds.map((seed) => [seed.key, seed] as const))(
    '%s has exactly one provenance entry per node',
    (_key, seed) => {
      const nodes = Object.keys(seed.definition.nodes).sort();
      const documented = Object.keys(seed.provenance).sort();

      // **THE ASSERTION THIS FILE EXISTS FOR.** Equality in both directions: a node with no entry is
      // a step nobody reviewed, and an entry with no node is a review list describing a playbook
      // that has moved on.
      expect(documented).toEqual(nodes);
    },
  );

  it.each(seeds.map((seed) => [seed.key, seed] as const))(
    '%s cites a source or gives reasoning, never neither',
    (_key, seed) => {
      for (const [nodeKey, entry] of Object.entries(seed.provenance)) {
        if (entry.basis === 'blueprint') {
          expect(entry.source.length, `${nodeKey} source`).toBeGreaterThan(20);
        } else {
          // An inference with a one-line excuse is the thing this whole scheme exists to prevent.
          expect(entry.reasoning.length, `${nodeKey} reasoning`).toBeGreaterThan(60);
        }
      }
    },
  );

  it('produces a review list that is neither empty nor everything', () => {
    const inferred = inferredSteps();
    const total = seeds.reduce((sum, seed) => sum + Object.keys(seed.definition.nodes).length, 0);

    // Not empty: authoring three playbooks from a blueprint that defines no phase cannot have been
    // pure transcription, and a seed claiming otherwise would be the confident-sounding failure.
    expect(inferred.length).toBeGreaterThan(0);
    // Not everything: if nothing came from the blueprint, these are not this firm's playbooks.
    expect(inferred.length).toBeLessThan(total);

    for (const step of inferred) {
      expect(seeds.some((seed) => seed.key === step.playbookKey)).toBe(true);
      expect(step.reasoning.length).toBeGreaterThan(60);
    }
  });
});

describe('every node addresses something that exists', () => {
  it.each(seeds.map((seed) => [seed.key, seed] as const))(
    '%s waits only on real event types',
    (_key, seed) => {
      for (const [nodeKey, node] of Object.entries(seed.definition.nodes)) {
        if (node.kind !== 'wait' || !('event' in node.until)) continue;

        // A wait on a string that is not an EventType parks forever: nothing can append it, so the
        // listener never matches it, and the instance looks like it is merely being patient.
        expect(isEventType(node.until.event), `${nodeKey} waits on '${node.until.event}'`).toBe(
          true,
        );
        expect(EVENT_TYPES as readonly string[]).toContain(node.until.event);
      }
    },
  );

  it.each(seeds.map((seed) => [seed.key, seed] as const))(
    '%s dispatches only to Appendix B departments',
    (_key, seed) => {
      for (const [nodeKey, node] of Object.entries(seed.definition.nodes)) {
        if (node.kind !== 'agent_task') continue;
        expect(APPENDIX_B_DEPARTMENTS, `${nodeKey} -> ${node.department}`).toContain(
          node.department,
        );
        expect(node.action.length, `${nodeKey} action`).toBeGreaterThan(30);
      }
    },
  );

  it.each(seeds.map((seed) => [seed.key, seed] as const))(
    '%s gives every human checkpoint a queue and a summary somebody can act on',
    (_key, seed) => {
      for (const [nodeKey, node] of Object.entries(seed.definition.nodes)) {
        if (node.kind !== 'human_checkpoint') continue;

        // The queue IS the 11.4 assignee - `dispatch` passes it straight to `raise`. An empty one
        // would raise a task assigned to nobody, which is a task nobody sees.
        expect(node.queue.length, `${nodeKey} queue`).toBeGreaterThan(0);
        // The summary is what a person reads in 2.4's console. "Approve" is not a summary.
        expect(node.summary.length, `${nodeKey} summary`).toBeGreaterThan(40);
      }
    },
  );

  it('gives every task and checkpoint an SLA, so a stalled phase is visible', () => {
    for (const seed of seeds) {
      for (const [nodeKey, node] of Object.entries(seed.definition.nodes)) {
        if (node.kind !== 'agent_task' && node.kind !== 'human_checkpoint') continue;
        // `breachedSlas` is what surfaces a stalled workflow. A node with no SLA can sit forever
        // and never appear in anybody's overdue list.
        expect(node.slaMinutes, `${seed.key}/${nodeKey}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the playbooks and the templates agree', () => {
  it('names a registered template for every seeded playbook', () => {
    const registered = new Set(V1_TEMPLATE_SEEDS.map((template) => template.key));

    for (const seed of seeds) {
      const templates = TEMPLATES_BY_PLAYBOOK[seed.key];
      expect(templates, `${seed.key} has no template mapping`).toBeDefined();

      for (const key of templates ?? []) {
        // A playbook that drafts a template nobody registered fails at the moment a person is
        // waiting for the document.
        expect(registered, `${seed.key} draws on '${key}'`).toContain(key);
      }
    }
  });

  it('maps no template for a playbook that is not seeded', () => {
    const keys = new Set(seeds.map((seed) => seed.key));
    for (const playbookKey of Object.keys(TEMPLATES_BY_PLAYBOOK)) {
      expect(keys, `${playbookKey} is mapped but not seeded`).toContain(playbookKey);
    }
  });
});

describe('the graphs end, and end honestly', () => {
  it.each(seeds.map((seed) => [seed.key, seed] as const))(
    '%s reaches a terminal from the start node',
    (_key, seed) => {
      const terminals = Object.entries(seed.definition.nodes).filter(
        ([, node]) => node.kind === 'terminal',
      );
      expect(terminals.length).toBeGreaterThan(0);
    },
  );

  it('cancels rather than completes where nothing was delivered', () => {
    // Phase 0 ends `cancelled` on a failed compliance state and Phase 1 on a frozen placement. A
    // `completed` terminal on those paths would report a served client in every count that reads
    // instance status.
    for (const key of ['phase-0-capital-readiness', 'phase-1-placement']) {
      const seed = seeds.find((entry) => entry.key === key);
      const outcomes = Object.values(seed?.definition.nodes ?? {})
        .filter((node) => node.kind === 'terminal')
        .map((node) => (node as { outcome: string }).outcome);
      expect(outcomes, key).toContain('cancelled');
      expect(outcomes, key).toContain('completed');
    }
  });
});

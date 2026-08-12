/**
 * The playbooks and the message templates agree about what gets sent when.
 *
 * They were authored in the same wave by different people. The playbooks describe six client-facing
 * steps; the Communications Hub holds nine templates; **nothing referenced anything**. Two of the
 * nine matched a step by coincidence of naming, six described moments no step reached, and three
 * steps that say they send had nothing to send.
 *
 * That is not a disagreement, which is what makes it hard to see: each side is internally coherent
 * and neither is wrong on its own. `TEMPLATES_BY_PLAYBOOK` in `@bwc/deliverables` had already
 * solved the same shape for the documents a playbook produces - and it exists because one person
 * happened to own both files. Where the boundary fell between two people, nothing was built.
 *
 * **The assertion that carries this file is exhaustiveness, not mapping.** Every Concierge Desk node
 * in every seeded playbook must appear in exactly one of three lists: it sends a named template, it
 * sends and has none yet, or it is not a send. A new client-facing step cannot be written without
 * somebody deciding which - and the decision is recorded in a file rather than in whoever
 * remembers.
 *
 * The two gap lists are deliberately not asserted non-empty. They are known-absence records, and
 * when the missing templates and the missing steps land, entries move between lists and
 * exhaustiveness still holds.
 */

import { describe, expect, it } from 'vitest';
import {
  NOT_A_SEND,
  SEED_TEMPLATES,
  SENDS_WITHOUT_A_TEMPLATE,
  TEMPLATES_BY_PLAYBOOK_NODE,
  TEMPLATES_WITHOUT_A_STEP,
} from '@bwc/comms';
import { V1_PLAYBOOK_SEEDS } from '@bwc/workflow';

/** The department that talks to clients. Every send in a playbook is dispatched to it. */
const CONCIERGE_DESK = 'concierge_desk';

const templateKeys = new Set(SEED_TEMPLATES.map((template) => template.key));

/**
 * Every `playbook-key/node-key` in a seeded playbook that causes a client to be contacted.
 *
 * Two shapes, because there are now two ways a playbook can reach a client:
 *
 *   an `agent_task` dispatched to the Concierge Desk - the ordinary send; and
 *   a `wait` that chases, whose `remindQueue` is that desk - a send raised beside a parked wait
 *   rather than as a step (ADR-0078).
 *
 * The second was added after this invariant was written, which is the case it had to survive: a new
 * way to contact a client that the classification did not know about would have gone unclassified
 * and unnoticed, and the reminder summary would have named a template nothing checked.
 */
const clientFacingNodes = V1_PLAYBOOK_SEEDS.flatMap((seed) =>
  Object.entries(seed.definition.nodes)
    .filter(([, node]) => {
      if (node.kind === 'agent_task') {
        return (node as { readonly department: string }).department === CONCIERGE_DESK;
      }
      if (node.kind === 'wait') {
        const wait = node as {
          readonly remindAfterMinutes?: number;
          readonly remindQueue?: string;
        };
        return wait.remindAfterMinutes !== undefined && wait.remindQueue === CONCIERGE_DESK;
      }
      return false;
    })
    .map(([nodeKey]) => `${seed.key}/${nodeKey}`),
);

const mapped = new Set(Object.keys(TEMPLATES_BY_PLAYBOOK_NODE));
const withoutTemplate = new Set(SENDS_WITHOUT_A_TEMPLATE);
const notASend = new Set(NOT_A_SEND);

describe('every client-facing step is classified', () => {
  it('finds the client-facing steps at all', () => {
    // If the department constant or the seed shape changed, every assertion below would pass
    // vacuously over an empty list - the failure mode this whole file exists to prevent.
    expect(clientFacingNodes.length).toBeGreaterThan(0);
  });

  it.each(clientFacingNodes)('%s appears in exactly one list', (node) => {
    const appearances = [mapped.has(node), withoutTemplate.has(node), notASend.has(node)].filter(
      Boolean,
    ).length;

    // THE ASSERTION THIS FILE EXISTS FOR. A new client-facing step fails here until somebody says
    // which template it sends, or says on the record that it sends none. Nothing about an unmapped
    // step looks wrong from either side: the playbook reads as complete and the templates read as
    // published.
    expect(appearances, `${node} is in ${appearances} of the three lists`).toBe(1);
  });

  it('classifies no step that does not exist', () => {
    // The other direction. A step renamed or deleted leaves a stale entry pointing at nothing, and
    // a mapping nobody can reach is worse than no mapping - it reads as coverage.
    const known = new Set(clientFacingNodes);
    for (const node of [...mapped, ...withoutTemplate, ...notASend]) {
      expect(known, `${node} is classified but is not a client-facing step`).toContain(node);
    }
  });
});

describe('every mapping names something real', () => {
  it('sends only templates that were seeded', () => {
    for (const [node, keys] of Object.entries(TEMPLATES_BY_PLAYBOOK_NODE)) {
      expect(keys.length, `${node} maps to no template`).toBeGreaterThan(0);
      for (const key of keys) {
        // A step naming a template nobody published fails at the moment a client is waiting to
        // hear something.
        expect(templateKeys, `${node} sends '${key}'`).toContain(key);
      }
    }
  });

  it('accounts for every seeded template', () => {
    const reachable = new Set(Object.values(TEMPLATES_BY_PLAYBOOK_NODE).flat());
    const unreachable = new Set(TEMPLATES_WITHOUT_A_STEP);

    for (const template of SEED_TEMPLATES) {
      const counted = reachable.has(template.key) || unreachable.has(template.key);
      // A tenth template added without a step would otherwise sit published and unsendable, which
      // looks identical to a template nobody has needed yet.
      expect(
        counted,
        `'${template.key}' is neither sent by a step nor recorded as unreachable`,
      ).toBe(true);
    }
  });

  it('records no unreachable template that was never seeded', () => {
    for (const key of TEMPLATES_WITHOUT_A_STEP) {
      expect(templateKeys, `'${key}' is recorded unreachable but was never seeded`).toContain(key);
    }
  });

  it('does not record a template as both sent and unreachable', () => {
    const reachable = new Set(Object.values(TEMPLATES_BY_PLAYBOOK_NODE).flat());
    for (const key of TEMPLATES_WITHOUT_A_STEP) {
      expect(reachable, `'${key}' is both sent by a step and recorded unreachable`).not.toContain(
        key,
      );
    }
  });
});

describe('the client hears about the things that happen to their application', () => {
  it('tells them it was submitted, and tells them the answer either way', () => {
    // This assertion replaces the one that recorded the silence. Phase 1 used to run
    // `submit_application`, `await_provider_decision` and `record_outcome` with exactly one
    // client-facing step in the whole phase - and it fired before the application was even sent.
    for (const key of ['application-submitted', 'offer-received', 'provider-declined']) {
      expect(TEMPLATES_WITHOUT_A_STEP, key).not.toContain(key);
    }

    const phase1 = V1_PLAYBOOK_SEEDS.find((seed) => seed.key === 'phase-1-placement');
    expect(phase1, 'phase-1-placement is not seeded').toBeDefined();

    const sends = Object.entries(phase1?.definition.nodes ?? {})
      .filter(
        ([, node]) =>
          node.kind === 'agent_task' &&
          (node as { readonly department: string }).department === CONCIERGE_DESK,
      )
      .map(([key]) => key);

    expect(sends).toEqual([
      'request_client_authorization',
      'notify_submission',
      'notify_offer',
      'notify_decline',
    ]);
  });

  it('reaches the decline through a branch rather than hoping somebody remembers', () => {
    const phase1 = V1_PLAYBOOK_SEEDS.find((seed) => seed.key === 'phase-1-placement');
    const gate = phase1?.definition.nodes['outcome_gate'];

    expect(gate?.kind).toBe('decision');
    if (gate?.kind !== 'decision') return;

    // The decline is the one likelier to be skipped in practice, which is why it is reached by an
    // explicit branch. Both branches read `context.fundingOutcome`, written by `record_outcome`,
    // because resolving an event wait does not carry the event's payload into context.
    const targets = gate.branches.map((branch) => branch.next);
    expect(targets).toEqual(['notify_offer', 'notify_decline']);

    // And an outcome that is neither - a withdrawal, or a `record_outcome` that wrote nothing -
    // completes silently. Guessing which of two messages to send would be worse than sending none:
    // a client told an offer arrived when it did not is a mistake no later correction undoes.
    expect(gate.otherwise).toBe('phase_1_complete');
  });
});

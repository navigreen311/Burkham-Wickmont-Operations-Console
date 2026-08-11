/**
 * The world the five read-only surfaces look at.
 *
 * Split out of `console-server.ts` rather than inlined, because it is four modules' worth of
 * history and the harness's own job - seed a tenant, seed credentials, listen - is already the
 * length it should be.
 *
 * **Everything here is history, not fixtures.** Each surface reads a fact some module produced, so
 * the seed produces it the way production would: `generateContract` issues the contract, `store`
 * plus `read` writes the access log, `tick` dispatches the checkpoint. A row inserted directly
 * would let a surface pass against a shape the module never emits.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActor, type EventActor } from '@bwc/identity';
import { seedFoundingClaims } from '@bwc/claims';
import { activateState, publishStateModule } from '@bwc/regulatory';
import {
  generateContract,
  publishClause,
  publishTemplate,
  reviewTemplate,
  type TemplateSection,
} from '@bwc/contracts';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  generateKek,
  read as readVault,
  recordScanResult,
  store as storeDocument,
} from '@bwc/vault';
import {
  fromDollars,
  publishOffer,
  recordBilling,
  recordFundingOutcome,
  startEngagement,
} from '@bwc/billing';
import { publishPlaybook, start as startWorkflow, tick, type PlaybookDefinition } from '@bwc/workflow';
import { E2E_APPROVAL_QUEUE, E2E_CONTRACT_STATE } from './fixture.js';

/**
 * Fixed dates in the past, so nothing here races a clock.
 *
 * The checkpoint's sixty-minute SLA is breached by any clock the harness could be running on, and
 * the approval that never funded is more than sixty days old - which is what makes the refund an
 * entitlement rather than a maybe.
 */
const WORKFLOW_START = new Date('2026-01-05T00:00:00.000Z');
const ENGAGEMENT_START = new Date('2026-01-15T00:00:00.000Z');
const APPROVED_ON = new Date('2026-02-01T00:00:00.000Z');

export const E2E_VAULT_FILENAME = 'e2e-bureau-pull.json';

/**
 * A canary that appears nowhere else in the repository.
 *
 * The documents spec asserts this string is absent from the page, which is how it checks that no
 * route on that surface returns document content. **The first version of that check looked for a
 * word from the payload and failed against unrelated copy** - one of the health components explains
 * that uptime would need "a synthetic check hitting the API from outside", and the assertion could
 * not tell that sentence from a leaked bank statement.
 *
 * A canary has to be unique or it is not a canary: a substring shared with legitimate text answers
 * a question nobody asked. Deliberately ugly so it stays that way.
 */
export const E2E_VAULT_CANARY = 'zzcanary-vault-bytes-must-never-render-zz';

/** Deliberately not a real payload. Nothing here is a real person's document. */
const DOCUMENT_CONTENT = Buffer.from(`{"canary":"${E2E_VAULT_CANARY}"}`, 'utf8');

const SERVICE_AGREEMENT: readonly TemplateSection[] = [
  {
    heading: 'Engagement',
    body: 'This agreement is between Burkham Wickmont and {{clientLegalName}}.',
    insertClauseKeys: ['scope_of_services'],
  },
  {
    heading: 'Required disclosures',
    body: 'The following disclosures form part of this agreement.',
    insertDisclosures: true,
  },
];

/** One human checkpoint, which is the whole of what 2.4 reads. */
const APPROVAL_PLAYBOOK: PlaybookDefinition = {
  startNode: 'compliance_review',
  nodes: {
    compliance_review: {
      kind: 'human_checkpoint',
      queue: E2E_APPROVAL_QUEUE,
      summary: 'Needs Review compliance state awaiting a human',
      slaMinutes: 60,
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

export interface SurfacesSeedInput {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly clientId: string;
  readonly actorId: string;
}

export const seedSurfaces = async (input: SurfacesSeedInput): Promise<void> => {
  const actor: EventActor = { id: input.actorId, kind: 'human' };

  // --- 2.4: a checkpoint parked and past its SLA ---
  //
  // Playbooks are not tenant-scoped, so the key carries the run's tenant slug. A fixed key would
  // collide with the version a previous run published.
  const playbookKey = `e2e-console-surfaces-${input.tenantSlug}`;
  const published = await publishPlaybook({
    key: playbookKey,
    version: 1,
    phase: 0,
    definition: APPROVAL_PLAYBOOK,
  });
  if (published.status !== 'ok') throw new Error(`seed: playbook (${published.status})`);

  const instance = await startWorkflow({
    tenantId: input.tenantId,
    playbookKey,
    clientId: input.clientId,
    actor,
    now: WORKFLOW_START,
  });
  if (instance.status !== 'ok') throw new Error(`seed: workflow instance (${instance.status})`);

  // Dispatches the checkpoint: parks the task and raises the assignment 11.4 holds. Without this
  // the queue is empty and the surface would be tested against nothing.
  await tick({
    workerId: 'e2e-console-surfaces',
    now: WORKFLOW_START,
    actor,
    tenantId: input.tenantId,
  });

  // --- 7.3: an issued contract ---
  await seedFoundingClaims(input.tenantId, 'compliance@burkhamwickmont.test', actor);

  await publishStateModule({
    tenantId: input.tenantId,
    state: E2E_CONTRACT_STATE,
    summary: `${E2E_CONTRACT_STATE} module for the Console surfaces harness.`,
    citations: [`${E2E_CONTRACT_STATE} commercial financing provisions`],
    disclosures: [
      {
        key: 'tx_cost_basis',
        text: 'Any cost figure shown to a TX client states the basis on which it was computed.',
        citation: 'TX commercial financing provisions §1',
      },
    ],
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor,
  });

  await activateState({
    tenantId: input.tenantId,
    state: E2E_CONTRACT_STATE,
    actor,
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: 'Memo BW-REG-2026-042',
  });

  await publishClause({
    tenantId: input.tenantId,
    key: 'scope_of_services',
    text: 'Standard scope of services terms.',
    citation: 'Standard engagement policy, approved 2026-07',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor,
  });

  const template = await publishTemplate({
    tenantId: input.tenantId,
    key: 'service_agreement',
    kind: 'service_agreement',
    title: 'Service Agreement',
    sections: SERVICE_AGREEMENT,
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor,
  });
  if (template.status !== 'ok') throw new Error(`seed: template (${template.status})`);

  // A template counsel has not seen cannot be generated from, which is the point of 7.3's gate.
  await reviewTemplate({
    tenantId: input.tenantId,
    templateKey: 'service_agreement',
    templateVersion: template.value.version,
    actor,
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: 'Memo BW-CON-2026-013',
  });

  const contract = await generateContract({
    tenantId: input.tenantId,
    clientId: input.clientId,
    templateKey: 'service_agreement',
    state: E2E_CONTRACT_STATE,
    offerTier: 'Foundation',
    channel: 'direct',
    variables: { clientLegalName: 'Console Surfaces Subject LLC' },
    generatedBy: 'compliance@burkhamwickmont.test',
    actor,
  });
  if (contract.status !== 'ok') throw new Error(`seed: contract (${contract.status})`);

  // --- 3.2: a document, and an access log with a refusal in it ---
  const root = await mkdtemp(join(tmpdir(), 'bwc-e2e-vault-'));
  process.env['E2E_VAULT_KEK'] ??= generateKek();
  const vault = {
    store: new LocalEncryptedStore(root),
    kek: new EnvKekProvider('E2E_VAULT_KEK'),
  };

  const stored = await storeDocument(vault, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    kind: 'credit_report',
    filename: E2E_VAULT_FILENAME,
    contentType: 'application/json',
    content: DOCUMENT_CONTENT,
    actorId: input.actorId,
  });
  if (stored.status !== 'ok') throw new Error(`seed: vault document (${stored.status})`);

  await recordScanResult(input.tenantId, stored.value.id, 'clean', input.actorId);

  // An observer, purely so the access log has a REFUSAL in it. That entry is the reason the log is
  // worth a page: a granted read is unremarkable, a pattern of below-level attempts is not.
  const observer = await createActor({
    tenantId: input.tenantId,
    kind: 'village_agent',
    label: 'E2E observer',
    authorityLevel: 0,
    department: 'capital_readiness',
  });

  await readVault(vault, {
    tenantId: input.tenantId,
    documentId: stored.value.id,
    actorId: input.actorId,
  });
  // Refused: a credit report needs Authority Level 2 and this actor holds 0.
  await readVault(vault, {
    tenantId: input.tenantId,
    documentId: stored.value.id,
    actorId: observer.id,
  });

  // --- 1.4: an engagement carrying an unresolved refund entitlement ---
  await publishOffer({
    tenantId: input.tenantId,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    minimumCents: fromDollars(2_495),
    successFeeBasisPoints: 850,
    publishedBy: 'concierge-desk',
    actor,
  });

  const engagement = await startEngagement({
    tenantId: input.tenantId,
    clientId: input.clientId,
    offerKey: 'foundation',
    startedOn: ENGAGEMENT_START,
    actor,
  });
  if (engagement.status !== 'ok') throw new Error(`seed: engagement (${engagement.status})`);

  await recordBilling({
    tenantId: input.tenantId,
    engagementId: engagement.value.id,
    kind: 'charge',
    amountCents: fromDollars(2_495),
    description: 'Foundation retainer',
    occurredOn: ENGAGEMENT_START,
    recordedBy: 'concierge-desk',
    actor,
  });

  await recordBilling({
    tenantId: input.tenantId,
    engagementId: engagement.value.id,
    kind: 'payment',
    amountCents: fromDollars(2_495),
    description: 'Retainer paid',
    occurredOn: ENGAGEMENT_START,
    recordedBy: 'concierge-desk',
    actor,
  });

  // The success fee, charged against the APPROVED limit - never a requested one, which 1.4 has no
  // field for at all.
  await recordBilling({
    tenantId: input.tenantId,
    engagementId: engagement.value.id,
    kind: 'charge',
    amountCents: fromDollars(4_250),
    description: 'Success fee on approved credit limit',
    approvedCreditLimitCents: fromDollars(50_000),
    occurredOn: APPROVED_ON,
    recordedBy: 'concierge-desk',
    actor,
  });

  // Approved and never funded. Sixty days on that is an objective refund entitlement, which is what
  // reaches both the billing surface and the founder's decision queue.
  await recordFundingOutcome({
    tenantId: input.tenantId,
    engagementId: engagement.value.id,
    clientId: input.clientId,
    provider: 'An end-to-end provider',
    approvedCreditLimitCents: fromDollars(50_000),
    approvedOn: APPROVED_ON,
    actor,
  });
};

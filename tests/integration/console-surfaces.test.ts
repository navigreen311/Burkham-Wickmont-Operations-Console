/**
 * The five surfaces this slice added to the Console, over a real socket.
 *
 * **The property this file exists for: every field the page reads is asserted by name here.**
 *
 * The DOM layer has no type checking and the browser has no opinion about a field that is not
 * there - `undefined` renders as the empty string inside a template literal, so a renamed or
 * misspelled field produces a page with a blank where a value should be and no error anywhere.
 * That has bitten this repository twice. A transport test that asserts only `status: 'ok'` would
 * pass through both.
 *
 * So each surface below asserts the exact key set of its list rows, and each list's total, rather
 * than spot-checking two fields and trusting the rest.
 *
 * **Nothing here is a write, and that is the finding rather than the omission.** All five modules
 * expose writes; none of those writes has an action in `ACTION_MINIMUM_LEVEL`, and `decideAuthority`
 * refuses an action absent from the catalogue. The Vault surface goes further and exposes no route
 * that returns document content at all, which is a decision rather than a gap. ADR-0037, ADR-0038.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import {
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  inviteStaff,
  totp,
} from '@bwc/identity';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
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
  read as readVault,
  recordScanResult,
  store as storeDocument,
  type VaultConfig,
} from '@bwc/vault';
import {
  fromDollars,
  publishOffer,
  recordBilling,
  recordFundingOutcome,
  startEngagement,
} from '@bwc/billing';
import {
  forInstance,
  publishPlaybook,
  start as startWorkflow,
  tick,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { createApp } from '../../apps/api/src/app.js';
import { type ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;
let vaultRoot: string;
let vault: VaultConfig;

let clientId: string;
let engagementId: string;
let contractId: string;
let documentId: string;
let checkpointTaskId: string;

const PASSWORD = 'a-long-enough-console-password';
const EMAIL = 'console-surfaces@example.com';
const QUEUE = 'compliance_and_evidence';

/**
 * A string that exists only inside the seeded document's ciphertext.
 *
 * The vault assertions look for its ABSENCE, which only means something if it is unique. The
 * browser spec's first version of the same check looked for a word from the payload and matched a
 * health component explaining that uptime would need "a synthetic check hitting the API from
 * outside" - a substring shared with legitimate copy answers a question nobody asked.
 */
const VAULT_CANARY = 'zzcanary-vault-bytes-must-never-render-zz';

const limiter = createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 });

let secret: Buffer;

/**
 * The same stepped clock `console-transport` uses, for the same reason: a TOTP code is spent when
 * it is accepted, so two sign-ins inside thirty seconds is a replay rather than a test.
 */
let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

/**
 * The workflow world is built in the past on purpose.
 *
 * A human checkpoint with a sixty-minute SLA, started in January, is past its SLA by any clock the
 * app could be running on. Asserting the breach list against a fixed past date is deterministic;
 * asserting it against a freshly started instance would be a race with the SLA window.
 */
const WORKFLOW_START = new Date('2026-01-05T00:00:00.000Z');
const ENGAGEMENT_START = new Date('2026-01-15T00:00:00.000Z');
/** More than sixty days before the engagement is read, which is what the refund trigger runs on. */
const APPROVED_ON = new Date('2026-02-01T00:00:00.000Z');

const human = () => ({ id: fx.human.id, kind: 'human' as const });

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly body: string;
}

let cookie = '';

const call = async (path: string): Promise<Reply> => {
  const response = await fetch(`${base}${path}`, {
    headers: cookie === '' ? {} : { cookie },
  });
  const body = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json, body };
};

/** The `data` of an `ok` envelope, with the assertion that it was one. */
const dataOf = async (path: string): Promise<Record<string, unknown>> => {
  const reply = await call(path);
  expect(reply.json['status'], `${path} -> ${reply.body}`).toBe('ok');
  return reply.json['data'] as Record<string, unknown>;
};

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
      queue: QUEUE,
      summary: 'Needs Review compliance state awaiting a human',
      slaMinutes: 60,
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('console-surfaces');

  vaultRoot = await mkdtemp(join(tmpdir(), 'bwc-console-surfaces-'));
  process.env['VAULT_SURFACES_KEK'] = generateKek();
  vault = {
    store: new LocalEncryptedStore(vaultRoot),
    kek: new EnvKekProvider('VAULT_SURFACES_KEK'),
  };

  clientId = (await createClient(fx.tenant.id, 'Console Surfaces LLC', human())).id;

  // --- the staff credential ---
  const invitation = await inviteStaff({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    email: EMAIL,
    invitedBy: fx.human.id,
  });
  if (invitation.status !== 'ok') throw new Error(`setup: invite - ${invitation.reason}`);

  const offer = await enrolStaffFromInvitation({
    tenantId: fx.tenant.id,
    token: invitation.value.token,
    password: PASSWORD,
  });
  if (offer.status !== 'ok') throw new Error(`setup: enrol - ${offer.reason}`);

  const decoded = base32Decode(offer.value.secret);
  if (!decoded) throw new Error('setup: unreadable secret');
  secret = decoded;

  const confirmed = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    password: PASSWORD,
    code: totp(secret, at()),
  });
  if (confirmed.status !== 'ok') throw new Error(`setup: confirm - ${confirmed.reason}`);

  // --- 2.4: a workflow parked on a human checkpoint, past its SLA ---
  //
  // Playbooks are not tenant-scoped - they are the operating company's own definitions - so the key
  // carries the run's tenant slug. A fixed key would collide with the version a previous run
  // published, which is the same discipline the per-run tenant slug follows.
  const playbookKey = `console-surfaces-approval-${fx.tenant.slug}`;
  const published = await publishPlaybook({
    key: playbookKey,
    version: 1,
    phase: 0,
    definition: APPROVAL_PLAYBOOK,
  });
  if (published.status !== 'ok') throw new Error(`setup: playbook - ${published.reason}`);

  const instance = await startWorkflow({
    tenantId: fx.tenant.id,
    playbookKey,
    clientId,
    actor: human(),
    now: WORKFLOW_START,
  });
  if (instance.status !== 'ok') throw new Error(`setup: start - ${instance.reason}`);

  // Dispatches the checkpoint: parks the task and raises the assignment 11.4 holds.
  await tick({
    workerId: 'console-surfaces',
    now: WORKFLOW_START,
    actor: human(),
    tenantId: fx.tenant.id,
  });

  // --- 7.3: an issued contract ---
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', human());

  await publishStateModule({
    tenantId: fx.tenant.id,
    state: 'TX',
    summary: 'TX module for the Console surfaces test.',
    citations: ['TX commercial financing provisions'],
    disclosures: [
      {
        key: 'tx_cost_basis',
        text: 'Any cost figure shown to a TX client states the basis on which it was computed.',
        citation: 'TX commercial financing provisions §1',
      },
    ],
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });

  await activateState({
    tenantId: fx.tenant.id,
    state: 'TX',
    actor: human(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: 'Memo BW-REG-2026-041',
  });

  await publishClause({
    tenantId: fx.tenant.id,
    key: 'scope_of_services',
    text: 'Standard scope of services terms.',
    citation: 'Standard engagement policy, approved 2026-07',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });

  const template = await publishTemplate({
    tenantId: fx.tenant.id,
    key: 'service_agreement',
    kind: 'service_agreement',
    title: 'Service Agreement',
    sections: SERVICE_AGREEMENT,
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });
  if (template.status !== 'ok') throw new Error(`setup: template - ${template.reason}`);

  await reviewTemplate({
    tenantId: fx.tenant.id,
    templateKey: 'service_agreement',
    templateVersion: template.value.version,
    actor: human(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: 'Memo BW-CON-2026-012',
  });

  const contract = await generateContract({
    tenantId: fx.tenant.id,
    clientId,
    templateKey: 'service_agreement',
    state: 'TX',
    offerTier: 'Foundation',
    channel: 'direct',
    variables: { clientLegalName: 'Console Surfaces LLC' },
    generatedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });
  if (contract.status !== 'ok') throw new Error(`setup: contract - ${contract.reason}`);
  contractId = contract.value.id;

  // --- 3.2: a document, and an access log with a refusal in it ---
  const stored = await storeDocument(vault, {
    tenantId: fx.tenant.id,
    clientId,
    kind: 'credit_report',
    filename: 'bureau-pull.json',
    contentType: 'application/json',
    content: Buffer.from(`{"canary":"${VAULT_CANARY}"}`, 'utf8'),
    actorId: fx.human.id,
  });
  if (stored.status !== 'ok') throw new Error(`setup: document - ${stored.reason}`);
  documentId = stored.value.id;

  await recordScanResult(fx.tenant.id, documentId, 'clean', fx.human.id);

  // One granted read and one refused one. The refusal is the entry the access-log surface exists
  // for: a credit report needs Level 2 and the observer holds Level 0.
  await readVault(vault, { tenantId: fx.tenant.id, documentId, actorId: fx.human.id });
  await readVault(vault, { tenantId: fx.tenant.id, documentId, actorId: fx.observer.id });

  // --- 1.4: an engagement with a charge and a refund entitlement ---
  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    minimumCents: fromDollars(2_495),
    successFeeBasisPoints: 850,
    publishedBy: 'concierge-desk',
    actor: human(),
  });

  const engagement = await startEngagement({
    tenantId: fx.tenant.id,
    clientId,
    offerKey: 'foundation',
    startedOn: ENGAGEMENT_START,
    actor: human(),
  });
  if (engagement.status !== 'ok') throw new Error(`setup: engagement - ${engagement.reason}`);
  engagementId = engagement.value.id;

  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'charge',
    amountCents: fromDollars(2_495),
    description: 'Foundation retainer',
    occurredOn: ENGAGEMENT_START,
    recordedBy: 'concierge-desk',
    actor: human(),
  });

  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'payment',
    amountCents: fromDollars(2_495),
    description: 'Retainer paid',
    occurredOn: ENGAGEMENT_START,
    recordedBy: 'concierge-desk',
    actor: human(),
  });

  // The success fee, charged against an APPROVED limit, and an approval that never funded. Sixty
  // days on, that is an objective refund entitlement - which is what the surface has to show.
  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'charge',
    amountCents: fromDollars(4_250),
    description: 'Success fee on approved credit limit',
    approvedCreditLimitCents: fromDollars(50_000),
    occurredOn: APPROVED_ON,
    recordedBy: 'concierge-desk',
    actor: human(),
  });

  await recordFundingOutcome({
    tenantId: fx.tenant.id,
    engagementId,
    clientId,
    provider: 'A test provider',
    approvedCreditLimitCents: fromDollars(50_000),
    approvedOn: APPROVED_ON,
    actor: human(),
  });

  // --- the app ---
  const config: ConsoleConfig = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_console_session',
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 10_000,
    rateLimitStore: 'memory',
    devActorHeader: false,
  };

  server = createServer(createApp({ config, limiter, now: at }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;

  offsetMs += 31_000;
  const signIn = await fetch(`${base}/api/console/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, code: totp(secret, at()) }),
  });
  const setCookie = signIn.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup: sign-in returned no cookie');
  cookie = setCookie.split(';')[0] as string;

  // The task the approval surface drills into. Read through the route rather than remembered from
  // setup, so the id under test is the one the page would actually be handed.
  const queue = (await dataOf(`/api/console/approvals?queue=${QUEUE}`)) as {
    items: { workflowTaskId: string }[];
  };
  checkpointTaskId = queue.items[0]?.workflowTaskId ?? '';
});

afterAll(async () => {
  // Guarded: a `beforeAll` that threw before the listen leaves these undefined, and an afterAll
  // that then throws replaces the real failure with a TypeError about `close`.
  if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
  if (fx !== undefined) await cleanupTenant(fx.tenant.id);
});

/**
 * Every route this slice added, so a surface that shipped without a session guard fails here.
 *
 * A separate list from `console-transport`'s: that file's list covers the routes that existed
 * before, and two lists that must both be updated is worse than one - but editing a file this
 * slice does not own is worse still, and this list is checked the same way.
 */
const ADDED: readonly string[] = [
  '/api/console/approvals',
  '/api/console/approvals/any-id',
  '/api/console/clients/any-id/contracts',
  '/api/console/contracts/any-id',
  '/api/console/contract-staleness',
  '/api/console/clients/any-id/documents',
  '/api/console/documents/any-id/access-log',
  '/api/console/offers',
  '/api/console/clients/any-id/billing',
  '/api/console/engagements/any-id',
  '/api/console/workbench',
];

describe('none of the new surfaces answers without a session', () => {
  it.each(ADDED)('refuses %s', async (path) => {
    const held = cookie;
    cookie = '';
    try {
      const reply = await call(path);
      expect(reply.json['status'], path).toBe('refused');
      expect(reply.status, path).toBe(409);
      // The same sentence every other cause gets, so which routes exist is not learnable here.
      expect(reply.json['reason'], path).toBe('Sign in to continue.');
    } finally {
      cookie = held;
    }
  });
});

// --- 2.4 Human Approval Console ---------------------------------------------

describe('2.4 the approval queue', () => {
  it('lists open checkpoints in a named queue, with every field the page reads', async () => {
    const data = await dataOf(`/api/console/approvals?queue=${QUEUE}`);

    expect(data['queue']).toBe(QUEUE);
    expect(data['queueAsked']).toBe(true);

    const items = data['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    // THE ASSERTION THIS FILE EXISTS FOR. The page reads each of these by name inside a template
    // literal, where a missing one renders as the empty string and never as an error.
    expect(Object.keys(items[0] as object).sort()).toEqual([
      'assignedTo',
      'clientId',
      'id',
      'kind',
      'slaDueAt',
      'status',
      'summary',
      'workflowTaskId',
    ]);
    expect(items[0]?.['kind']).toBe('human_checkpoint');
    expect(items[0]?.['assignedTo']).toBe(QUEUE);
    expect(items[0]?.['clientId']).toBe(clientId);
    expect(items[0]?.['status']).toBe('open');
    expect(items[0]?.['summary']).toBe('Needs Review compliance state awaiting a human');

    // The list carries its total. A page showing rows without one reads as the whole set.
    expect(data['total']).toBe(1);
  });

  it('answers with the SLA list and no items when nobody named a queue', async () => {
    const data = await dataOf('/api/console/approvals');

    // Not a refusal: "nobody named a queue" and "that queue is empty" are different answers, and
    // an operator arriving on the page has given neither.
    expect(data['queueAsked']).toBe(false);
    expect(data['queue']).toBe('');
    expect(data['items']).toEqual([]);
    expect(data['total']).toBe(0);
    // The breach list needs no queue and is still populated.
    expect(data['breachedTotal']).toBe(1);
  });

  it('reports the breached checkpoint with every field the page reads', async () => {
    const data = await dataOf('/api/console/approvals');
    const breached = data['breached'] as Record<string, unknown>[];

    expect(breached).toHaveLength(1);
    expect(Object.keys(breached[0] as object).sort()).toEqual([
      'department',
      'escalatedAt',
      'id',
      'instanceId',
      'kind',
      'nodeKey',
      'slaDueAt',
      'status',
    ]);
    expect(breached[0]?.['nodeKey']).toBe('compliance_review');
    expect(breached[0]?.['kind']).toBe('human_checkpoint');
    expect(breached[0]?.['status']).toBe('waiting');
    expect(breached[0]?.['escalatedAt']).toBeNull();
    expect(data['breachedTotal']).toBe(1);
  });

  it('opens one checkpoint with its workflow, its assignments, and why it cannot be resolved here', async () => {
    expect(checkpointTaskId).not.toBe('');
    const data = await dataOf(`/api/console/approvals/${checkpointTaskId}`);

    expect(Object.keys(data['task'] as object).sort()).toEqual([
      'attempts',
      'department',
      'escalatedAt',
      'id',
      'kind',
      'lastError',
      'maxAttempts',
      'nodeKey',
      'slaDueAt',
      'status',
    ]);
    expect(Object.keys(data['instance'] as object).sort()).toEqual([
      'clientId',
      'currentNodeKey',
      'id',
      'playbookKey',
      'playbookVersion',
      'status',
    ]);

    const siblings = data['siblings'] as Record<string, unknown>[];
    expect(Object.keys(siblings[0] as object).sort()).toEqual(['id', 'kind', 'nodeKey', 'status']);
    expect(data['siblingsTotal']).toBe(siblings.length);

    const notifications = data['notifications'] as Record<string, unknown>[];
    expect(notifications).toHaveLength(1);
    expect(Object.keys(notifications[0] as object).sort()).toEqual([
      'assignedTo',
      'id',
      'status',
      'summary',
    ]);
    expect(data['notificationsTotal']).toBe(1);

    // **Named rather than implied by an absent button.** If somebody adds the action to the
    // catalogue and wires the write, this assertion fails and the page's sentence gets revisited
    // with it - which is the point of asserting a `false`.
    const resolution = data['resolution'] as Record<string, unknown>;
    expect(resolution['available']).toBe(false);
    expect(resolution['requiredAction']).toBe('resolve_human_checkpoint');
    expect(String(resolution['reason'])).toContain('ACTION_MINIMUM_LEVEL');
  });

  it('will not open another tenant’s task, or one that does not exist, and says the same thing to both', async () => {
    // `find`, `findInstance` and `forInstance` are keyed by id alone with no tenant filter - right
    // for an engine that resolved its own scope, wrong to rely on for an id typed into a browser.
    const other = await makeFixture('console-surfaces-other');
    try {
      const otherClient = await createClient(other.tenant.id, 'Another Tenant LLC', {
        id: other.human.id,
        kind: 'human',
      });
      const otherKey = `console-surfaces-approval-${other.tenant.slug}`;
      await publishPlaybook({
        key: otherKey,
        version: 1,
        phase: 0,
        definition: APPROVAL_PLAYBOOK,
      });
      const otherInstance = await startWorkflow({
        tenantId: other.tenant.id,
        playbookKey: otherKey,
        clientId: otherClient.id,
        actor: { id: other.human.id, kind: 'human' },
        now: WORKFLOW_START,
      });
      if (otherInstance.status !== 'ok') throw new Error('setup: other instance');
      await tick({
        workerId: 'console-surfaces-other',
        now: WORKFLOW_START,
        actor: { id: other.human.id, kind: 'human' },
        tenantId: other.tenant.id,
      });

      const theirs = (await forInstance(otherInstance.value.id)).find(
        (task) => task.kind === 'human_checkpoint',
      );
      expect(theirs, 'the other tenant should have a checkpoint to try to read').toBeDefined();

      const crossTenant = await call(`/api/console/approvals/${theirs?.id ?? 'none'}`);
      const absent = await call('/api/console/approvals/00000000-0000-0000-0000-000000000000');

      expect(crossTenant.json['status']).toBe('no_data');
      // Word for word the same. "No such task" and "that is somebody else's" are the same answer
      // to a caller who is entitled to neither.
      expect(crossTenant.json['reason']).toBe(absent.json['reason']);
      expect(crossTenant.body).not.toContain(otherClient.id);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });
});

// --- 7.3 Contract & Disclosure Builder --------------------------------------

describe('7.3 contracts and disclosures', () => {
  it('lists what was issued to a client, with every field the page reads', async () => {
    const data = await dataOf(`/api/console/clients/${clientId}/contracts`);
    const contracts = data['contracts'] as Record<string, unknown>[];

    expect(contracts).toHaveLength(1);
    expect(Object.keys(contracts[0] as object).sort()).toEqual([
      'clauseKeys',
      'contentHash',
      'disclosureKeys',
      'id',
      'issuedAt',
      'kind',
      'state',
      'stateModuleVersion',
      'templateKey',
      'templateVersion',
    ]);
    expect(contracts[0]?.['kind']).toBe('service_agreement');
    expect(contracts[0]?.['state']).toBe('TX');
    expect(data['total']).toBe(1);

    // The list deliberately carries no document content: it is a table of contents, and each of
    // these is a binding document whose text should travel as few places as possible.
    expect(contracts[0]).not.toHaveProperty('content');
    expect(contracts[0]).not.toHaveProperty('document');
  });

  it('opens one document with its integrity, its placeholders and its provenance', async () => {
    const data = await dataOf(`/api/console/contracts/${contractId}`);

    expect(data['id']).toBe(contractId);
    expect(data['clientId']).toBe(clientId);
    expect(data['kind']).toBe('service_agreement');

    const integrity = data['integrity'] as Record<string, unknown>;
    expect(Object.keys(integrity).sort()).toEqual(['detail', 'intact']);
    expect(integrity['intact']).toBe(true);

    // Every substitution resolved. A document carrying a literal placeholder went out with a blank.
    expect(data['unresolvedPlaceholders']).toEqual([]);
    expect(data['unresolvedPlaceholdersTotal']).toBe(0);

    const document_ = data['document'] as Record<string, unknown>;
    expect(Object.keys(document_).sort()).toEqual([
      'channel',
      'offerTier',
      'provenance',
      'sections',
      'sectionsTotal',
      'title',
    ]);
    expect(Object.keys(document_['provenance'] as object).sort()).toEqual([
      'generatedAt',
      'stateModuleVersion',
      'templateKey',
      'templateVersion',
    ]);

    const sections = document_['sections'] as Record<string, unknown>[];
    expect(Object.keys(sections[0] as object).sort()).toEqual([
      'body',
      'clauses',
      'disclosures',
      'heading',
    ]);
    expect(document_['sectionsTotal']).toBe(sections.length);

    // The clause carries the citation that put it there. A clause with no provenance is one nobody
    // can defend, and the page prints the citation beside the text.
    const clause = (sections[0]?.['clauses'] as Record<string, unknown>[])[0];
    expect(Object.keys(clause as object).sort()).toEqual(['citation', 'key', 'text']);

    const disclosures = sections.flatMap(
      (section) => section['disclosures'] as Record<string, unknown>[],
    );
    expect(disclosures.length).toBeGreaterThan(0);
    expect(Object.keys(disclosures[0] as object).sort()).toEqual([
      'citation',
      'key',
      'source',
      'text',
    ]);

    // The substituted variable actually landed, which is the difference between a generated
    // document and a template with the client's name still spelled `{{clientLegalName}}`.
    expect(String(sections[0]?.['body'])).toContain('Console Surfaces LLC');
  });

  it('reports staleness as two lists, because the remedy differs', async () => {
    const data = await dataOf('/api/console/contract-staleness');

    expect(data['stale']).toEqual([]);
    expect(data['staleTotal']).toBe(0);
    expect(data['onSupersededTemplates']).toEqual([]);
    expect(data['onSupersededTemplatesTotal']).toBe(0);
  });

  it('lists a document generated against a state module that has since moved', async () => {
    // Publishing a new TX version makes the issued contract stale without touching it: an issued
    // contract is frozen, and staleness is derived rather than written back.
    await publishStateModule({
      tenantId: fx.tenant.id,
      state: 'TX',
      summary: 'TX module, revised.',
      citations: ['TX commercial financing provisions, as amended'],
      disclosures: [
        {
          key: 'tx_cost_basis',
          text: 'Any cost figure shown to a TX client states the basis on which it was computed.',
          citation: 'TX commercial financing provisions §1',
        },
      ],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });

    const data = await dataOf('/api/console/contract-staleness');
    const stale = data['stale'] as Record<string, unknown>[];

    expect(stale).toHaveLength(1);
    expect(Object.keys(stale[0] as object).sort()).toEqual([
      'clientId',
      'currentVersion',
      'generatedAgainstVersion',
      'id',
      'issuedAt',
      'kind',
      'reason',
      'state',
    ]);
    expect(stale[0]?.['generatedAgainstVersion']).toBe(1);
    expect(stale[0]?.['currentVersion']).toBe(2);
    expect(data['staleTotal']).toBe(1);

    // The issued document itself did not change. That is the whole of ADR-0010.
    const contract = await dataOf(`/api/console/contracts/${contractId}`);
    expect((contract['integrity'] as Record<string, unknown>)['intact']).toBe(true);
  });
});

// --- 3.2 Secure Document Vault ----------------------------------------------

describe('3.2 the vault surface', () => {
  it('lists document metadata with every field the page reads, and no content', async () => {
    const data = await dataOf(`/api/console/clients/${clientId}/documents`);
    const documents = data['documents'] as Record<string, unknown>[];

    expect(documents).toHaveLength(1);
    expect(Object.keys(documents[0] as object).sort()).toEqual([
      'byteSize',
      'contentType',
      'filename',
      'id',
      'kind',
      'legalHold',
      'minimumLevelToRead',
      'retainUntil',
      'scanStatus',
      'sha256',
    ]);
    expect(data['total']).toBe(1);

    expect(documents[0]?.['kind']).toBe('credit_report');
    expect(documents[0]?.['scanStatus']).toBe('clean');
    // The module's own constant, surfaced rather than recomputed: a credit report needs Level 2.
    expect(documents[0]?.['minimumLevelToRead']).toBe(2);
    // Not resolved into a boolean here. `read` gates on tenant, level, scan and hold in a fixed
    // order, and a `readable` computed on this side would be a second copy of that gate.
    expect(documents[0]).not.toHaveProperty('readable');

    expect(data['actorAuthorityLevel']).toBe(3);
  });

  it('carries no document content on any route, which is the decision rather than a gap', async () => {
    // THE ASSERTION THIS SURFACE EXISTS FOR. The stored payload carries a canary that exists
    // nowhere else; if any route here ever grows a content field, this finds it.
    const listing = await call(`/api/console/clients/${clientId}/documents`);
    const log = await call(`/api/console/documents/${documentId}/access-log`);

    for (const reply of [listing, log]) {
      expect(reply.body).not.toContain(VAULT_CANARY);
    }

    const data = listing.json['data'] as Record<string, unknown>;
    expect(data['bytesAvailableHere']).toBe(false);
  });

  it('shows the access log with its refusals, counted separately', async () => {
    const data = await dataOf(`/api/console/documents/${documentId}/access-log`);
    const entries = data['entries'] as Record<string, unknown>[];

    expect(Object.keys(entries[0] as object).sort()).toEqual([
      'action',
      'actorId',
      'at',
      'granted',
      'reason',
      'watermarked',
    ]);

    // **The refusals are why this has a page.** A log showing only successes answers the less
    // interesting half, and a pattern of below-level attempts on one file is what an audit wants.
    expect(data['refusedTotal']).toBe(1);
    expect(data['grantedTotal']).toBe(1);
    expect(data['total']).toBe(2);

    const refusal = entries.find((entry) => entry['granted'] === false);
    expect(refusal?.['reason']).toBe('below_level');
    expect(refusal?.['actorId']).toBe(fx.observer.id);
  });
});

// --- 1.4 Pricing, Billing & Offer Management --------------------------------

describe('1.4 billing', () => {
  it('lists the offer ladder with money as cents and as the module’s own rendering', async () => {
    const data = await dataOf('/api/console/offers');
    const offers = data['offers'] as Record<string, unknown>[];

    expect(offers).toHaveLength(1);
    expect(Object.keys(offers[0] as object).sort()).toEqual([
      'committedMonths',
      'key',
      'minimumCents',
      'minimumDisplay',
      'monthlyCents',
      'monthlyDisplay',
      'name',
      'retainerCents',
      'retainerDisplay',
      'rung',
      'successFeeBasisPoints',
      'version',
    ]);
    expect(data['total']).toBe(1);

    // Integer cents, and the rendering comes from 1.4 rather than from arithmetic in the page.
    expect(offers[0]?.['retainerCents']).toBe(249_500);
    expect(offers[0]?.['retainerDisplay']).toBe('$2,495.00');
    // Basis points, never a percentage: the stored figure is what the fee computes from.
    expect(offers[0]?.['successFeeBasisPoints']).toBe(850);
  });

  it('lists a client’s engagements and unspent credit, with every field the page reads', async () => {
    const data = await dataOf(`/api/console/clients/${clientId}/billing`);
    const engagements = data['engagements'] as Record<string, unknown>[];

    expect(engagements).toHaveLength(1);
    expect(Object.keys(engagements[0] as object).sort()).toEqual([
      'annualPrepay',
      'cancelledOn',
      'committedThrough',
      'id',
      'meetsMinimum',
      'offerId',
      'outstandingCents',
      'outstandingDisplay',
      'refundTotal',
      'startedOn',
      'status',
      'unresolvedRefundTotal',
    ]);
    expect(data['total']).toBe(1);

    // The entitlement is derived, not stored, and it is unresolved: nobody has paid or declined it.
    expect(engagements[0]?.['refundTotal']).toBe(1);
    expect(engagements[0]?.['unresolvedRefundTotal']).toBe(1);

    const credit = data['credit'] as Record<string, unknown>;
    expect(Object.keys(credit).sort()).toEqual([
      'availableCents',
      'availableDisplay',
      'sources',
      'sourcesTotal',
    ]);
    const sources = credit['sources'] as Record<string, unknown>[];
    expect(Object.keys(sources[0] as object).sort()).toEqual([
      'alreadyDrawnCents',
      'alreadyDrawnDisplay',
      'availableCents',
      'availableDisplay',
      'engagementId',
      'occurredOn',
      'paidCents',
      'paidDisplay',
      'recordId',
    ]);
    expect(credit['sourcesTotal']).toBe(sources.length);
  });

  it('opens one engagement with its balance as components, never as one net figure', async () => {
    const data = await dataOf(`/api/console/engagements/${engagementId}`);

    expect(Object.keys(data['engagement'] as object).sort()).toEqual([
      'annualPrepay',
      'cancelledOn',
      'clientId',
      'committedThrough',
      'id',
      'offerId',
      'startedOn',
      'status',
    ]);

    const balance = data['balance'] as Record<string, unknown>;
    expect(Object.keys(balance).sort()).toEqual([
      'chargedCents',
      'chargedDisplay',
      'creditedCents',
      'creditedDisplay',
      'meetsMinimum',
      'minimumCents',
      'minimumDisplay',
      'outstandingCents',
      'outstandingDisplay',
      'paidCents',
      'paidDisplay',
      'refundedCents',
      'refundedDisplay',
    ]);
    expect(data['balanceUnavailableReason']).toBeNull();

    // Charged 2,495 + 4,250; paid 2,495. The four components are what a client disputing an
    // invoice is actually asking about.
    expect(balance['chargedCents']).toBe(674_500);
    expect(balance['paidCents']).toBe(249_500);
    expect(balance['outstandingCents']).toBe(425_000);
    expect(balance['outstandingDisplay']).toBe('$4,250.00');
  });

  it('shows a success-fee charge against the approved credit limit, never a requested one', async () => {
    const data = await dataOf(`/api/console/engagements/${engagementId}`);
    const records = data['records'] as Record<string, unknown>[];

    expect(Object.keys(records[0] as object).sort()).toEqual([
      'amountCents',
      'amountDisplay',
      'approvedCreditLimitCents',
      'approvedCreditLimitDisplay',
      'description',
      'id',
      'kind',
      'occurredOn',
    ]);
    expect(data['recordsTotal']).toBe(records.length);

    const successFee = records.find((record) => record['approvedCreditLimitCents'] !== null);
    expect(successFee?.['approvedCreditLimitCents']).toBe(5_000_000);
    expect(successFee?.['approvedCreditLimitDisplay']).toBe('$50,000.00');

    // The invariant expressed as an absence. There is no field for a requested limit anywhere in
    // 1.4, so there is nothing for the arithmetic to reach for.
    expect(JSON.stringify(records)).not.toContain('requestedCreditLimit');
    expect(JSON.stringify(records)).not.toContain('creditLimitCents');
  });

  it('lists the refund entitlement the record produces, unresolved', async () => {
    const data = await dataOf(`/api/console/engagements/${engagementId}`);
    const refunds = data['refunds'] as Record<string, unknown>[];

    expect(refunds).toHaveLength(1);
    expect(Object.keys(refunds[0] as object).sort()).toEqual([
      'amountCents',
      'amountDisplay',
      'basis',
      'resolved',
      'trigger',
    ]);
    expect(refunds[0]?.['trigger']).toBe('approved_not_funded_60_days');
    expect(refunds[0]?.['resolved']).toBeNull();
    expect(data['refundsTotal']).toBe(1);
    expect(data['unresolvedRefundTotal']).toBe(1);
  });

  it('renders the fee exhibit with the success fee contingent, not estimated at zero', async () => {
    const data = await dataOf(`/api/console/engagements/${engagementId}`);
    const exhibit = data['exhibit'] as Record<string, unknown>;

    expect(Object.keys(exhibit).sort()).toEqual([
      'contingentLines',
      'contingentLinesTotal',
      'knownTotalDollars',
      'lines',
      'linesTotal',
      'summary',
    ]);
    expect(data['exhibitUnavailableReason']).toBeNull();

    const lines = exhibit['lines'] as Record<string, unknown>[];
    expect(Object.keys(lines[0] as object).sort()).toEqual([
      'amount',
      'basis',
      'label',
      'whenCharged',
    ]);
    expect(exhibit['linesTotal']).toBe(lines.length);

    // **THE ASSERTION.** No approved limit is passed to the exhibit, so the success fee is
    // contingent and its amount is `null`. A `0` here would state that the client owes nothing,
    // which is a different claim from "this is not determinable yet".
    const contingent = lines.find((line) => line['amount'] === null);
    expect(contingent, 'the success fee should be a contingent line').toBeDefined();
    expect(contingent?.['amount']).not.toBe(0);
    expect(exhibit['contingentLinesTotal']).toBeGreaterThan(0);

    // Amounts on the exhibit are DOLLARS while every other figure here is cents. The retainer is
    // $2,495, not 249500.
    expect(exhibit['knownTotalDollars']).toBe(2_495);
  });

  it('forwards a refusal unchanged rather than inventing a balance', async () => {
    const reply = await call('/api/console/engagements/00000000-0000-0000-0000-000000000000');
    expect(reply.json['status']).toBe('no_data');
    expect(reply.json['reason']).toBe('No such engagement in this tenant.');
  });
});

// --- 11.11 Founder / Executive Workbench ------------------------------------

describe('11.11 the founder workbench', () => {
  it('assembles the decision queue with what happens if nobody acts', async () => {
    const data = await dataOf('/api/console/workbench');

    const decisions = data['decisions'] as Record<string, unknown>[];
    expect(decisions.length).toBeGreaterThan(0);
    expect(Object.keys(decisions[0] as object).sort()).toEqual([
      'costOfInaction',
      'dueAt',
      'key',
      'kind',
      'resolveIn',
      'summary',
      'urgency',
    ]);
    expect(data['decisionsTotal']).toBe(decisions.length);
    expect(data['overdueTotal']).toBe(
      decisions.filter((decision) => decision['urgency'] === 'overdue').length,
    );

    // The unresolved refund entitlement seeded above reaches the founder queue, which is what makes
    // this an assembly over the modules rather than a second store.
    const refunds = decisions.find((decision) => decision['kind'] === 'refunds_unresolved');
    expect(refunds, 'the unresolved refund should reach the founder queue').toBeDefined();
    // The field that makes this a queue rather than a feed.
    expect(String(refunds?.['costOfInaction'])).toContain('PAY');
    expect(String(refunds?.['resolveIn'])).toContain('1.4');
  });

  it('carries the rollup with its withheld metrics rather than zeroes', async () => {
    const data = await dataOf('/api/console/workbench');
    const rollup = data['rollup'] as Record<string, unknown>;

    expect(Object.keys(rollup).sort()).toEqual([
      'clients',
      'complianceCounts',
      'healthyShare',
      'meetsComplianceTarget',
      'openCorrectionObligations',
      'periodFrom',
      'periodPartial',
      'periodTo',
      'placementApprovalRate',
      'revenuePerClientCents',
      'withheld',
      'withheldTotal',
    ]);

    const withheld = rollup['withheld'] as Record<string, unknown>[];
    expect(rollup['withheldTotal']).toBe(withheld.length);
    if (withheld.length > 0) {
      // Each withheld metric carries the note saying why. A key with no note is a gap nobody can
      // act on, and the page prints the note.
      expect(Object.keys(withheld[0] as object).sort()).toEqual(['key', 'note']);
    }

    // A metric with no value is `null` and stays `null` across the transport. 9.1's rule is that a
    // missing measurement is not a measurement of zero, and JSON is where that quietly gets lost.
    for (const key of ['healthyShare', 'placementApprovalRate', 'revenuePerClientCents']) {
      const value = rollup[key];
      expect(value === null || typeof value === 'number', key).toBe(true);
    }
  });

  it('carries health as components and counts, never reduced to one word', async () => {
    const data = await dataOf('/api/console/workbench');
    const health = data['health'] as Record<string, unknown>;

    expect(Object.keys(health).sort()).toEqual([
      'checkedAt',
      'components',
      'componentsTotal',
      'counts',
      'detail',
      'overall',
    ]);

    const components = health['components'] as Record<string, unknown>[];
    expect(Object.keys(components[0] as object).sort()).toEqual([
      'detail',
      'key',
      'label',
      'state',
    ]);
    expect(health['componentsTotal']).toBe(components.length);

    // `unmonitored` is a state with a count of its own. Nobody looking is not evidence of health,
    // and the page prints the number beside the word.
    const counts = health['counts'] as Record<string, number>;
    expect(counts).toHaveProperty('unmonitored');
    expect(typeof counts['unmonitored']).toBe('number');
  });

  it('gives one line per department', async () => {
    const data = await dataOf('/api/console/workbench');
    const departments = data['crossDepartment'] as Record<string, unknown>[];

    expect(departments.length).toBeGreaterThan(0);
    expect(Object.keys(departments[0] as object).sort()).toEqual(['department', 'status']);
    expect(data['crossDepartmentTotal']).toBe(departments.length);
  });
});

// --- the page's own source --------------------------------------------------

/**
 * The structural rules the Console page claims to follow, actually checked.
 *
 * **`console.js` has said since it was written that "a test asserts that the markup-assigning
 * properties appear nowhere in this directory". No such test existed.** The portal has one
 * (`portal-ui.test.ts`) and the Console's page was written to the same rule with nothing enforcing
 * it - which is the shape ADR-0033 names: a comment describing a control is not a control, and it
 * had been read past for as long as it had existed.
 *
 * Adding five views is the wrong time to find that out and the right time to fix it.
 */
const PUBLIC = join(process.cwd(), 'apps', 'api', 'public');

describe('the page keeps the rules it says it keeps', () => {
  it('assigns nothing to a markup-writing property, anywhere in the directory', async () => {
    for (const file of ['console.js', 'api.js']) {
      const source = await readFile(join(PUBLIC, file), 'utf8');
      expect(source, file).not.toContain('innerHTML');
      expect(source, file).not.toContain('outerHTML');
      expect(source, file).not.toContain('insertAdjacentHTML');
      expect(source, file).not.toContain('document.write');
      expect(source, file).not.toContain('eval(');
    }
  });

  it('has no inline script, no inline style and no event-handler attribute', async () => {
    const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');

    // A `<script>` with a body, as opposed to one with only a src. The policy carries no
    // 'unsafe-inline' and no nonce, so anything inline simply would not run.
    expect(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/u.test(html)).toBe(false);
    expect(html).not.toContain('<style');
    expect(/\sstyle="/u.test(html)).toBe(false);
    expect(/\son[a-z]+="/u.test(html)).toBe(false);
  });

  it('loads nothing from another host', async () => {
    for (const file of ['index.html', 'console.css']) {
      const source = await readFile(join(PUBLIC, file), 'utf8');
      expect(source, file).not.toContain('http://');
      expect(source, file).not.toContain('https://');
      expect(source, file).not.toContain('//cdn');
    }
  });

  it('names only routes that exist', async () => {
    // A page written against an endpoint that was renamed fails in a browser and passes every
    // server test. Nothing else in this suite opens one.
    const source = await readFile(join(PUBLIC, 'api.js'), 'utf8');
    const paths = [...source.matchAll(/[`'"](\/api\/[^`'"]*)[`'"]/gu)]
      .map((match) => match[1] as string)
      // Template holes become a literal segment; the route matches a param either way.
      .map((path) => path.replace(/\$\{[^}]*\}/gu, 'a-placeholder-id'))
      .map((path) => path.replace(/\?.*$/u, ''));

    expect(paths.length).toBeGreaterThan(20);

    for (const path of new Set(paths)) {
      // Both verbs: a GET-only route answers a POST with 404 and vice versa, which would be
      // indistinguishable from the failure being looked for.
      const [posted, fetched] = await Promise.all([
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        fetch(`${base}${path}`),
      ]);

      expect(posted.status === 404 && fetched.status === 404, path).toBe(false);
    }
  });

  it('serves the document, its script and its stylesheet', async () => {
    const page = await fetch(`${base}/console/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/u);

    const body = await page.text();
    // The five surfaces are in the document rather than built at runtime, which is what makes the
    // no-inline-script rule affordable.
    for (const view of [
      'view-approvals',
      'view-contracts',
      'view-documents',
      'view-billing',
      'view-workbench',
    ]) {
      expect(body, view).toContain(view);
    }

    for (const [path, type] of [
      ['/console/console.js', /javascript/u],
      ['/console/api.js', /javascript/u],
      ['/console/console.css', /css/u],
    ] as const) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(type);
    }
  });

  it('keeps the page’s relaxed policy off the API', async () => {
    const pagePolicy = (await fetch(`${base}/console/`)).headers.get('content-security-policy') ?? '';
    const apiPolicy =
      (await fetch(`${base}/api/health`)).headers.get('content-security-policy') ?? '';

    expect(pagePolicy).toContain("script-src 'self'");
    expect(pagePolicy).not.toContain('unsafe-inline');
    expect(pagePolicy).not.toContain('nonce-');

    // A JSON route still serves no document. A policy that leaked would be one nobody noticed
    // until it mattered.
    expect(apiPolicy).toContain("default-src 'none'");
    expect(apiPolicy).not.toContain('script-src');
  });
});

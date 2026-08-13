/**
 * 4.1 Communications Hub with 4.4, end to end.
 *
 * The send path runs four gates in order - preference, then the middleware chain (which carries
 * the Regulatory Engine's state gate and the compliance scanner), then the log, then the provider
 * seam. This suite exercises each refusal and the one success.
 *
 * It also asserts the thing this slice was picked for: 7.1's `communications` source stops being a
 * gap, so a client file no longer carries a note saying a reader should not treat its absence as
 * evidence that nothing was said.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { read } from '@bwc/ledger';
import { seedFoundingClaims } from '@bwc/claims';
import { activateState, publishStateModule } from '@bwc/regulatory';
import { assembleEvidenceFile } from '@bwc/evidence';
import {
  communicationsFor,
  contactSummary,
  currentTemplate,
  publishTemplate,
  recordInbound,
  render,
  send,
  setDoNotCall,
  setPreferences,
  unresolvedPlaceholders,
} from '@bwc/comms';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

/** 15:00 UTC is 10:00 in Chicago - inside the window. */
const MID_MORNING = new Date('2026-08-10T15:00:00.000Z');
/** 12:00 UTC is 07:00 in Chicago - before it opens. */
const TOO_EARLY = new Date('2026-08-10T12:00:00.000Z');

beforeAll(async () => {
  fx = await makeFixture('comms');

  const client = await createClient(fx.tenant.id, 'Contacted Co', human());
  clientId = client.id;
  await transitionComplianceState({
    tenantId: fx.tenant.id,
    clientId,
    to: 'pass',
    reason: 'test fixture',
    actor: human(),
  });

  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', human());

  await publishStateModule({
    tenantId: fx.tenant.id,
    state: 'TX',
    summary: 'Texas module for the communications test.',
    citations: ['Tex. Fin. Code - scope confirmed by counsel'],
    disclosures: [],
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
    documentReference: 'Memo BW-REG-2026-055',
  });

  await setPreferences({
    tenantId: fx.tenant.id,
    clientId,
    emailAllowed: true,
    smsAllowed: true,
    timezone: 'America/Chicago',
    preferredChannel: 'email',
    updatedBy: 'concierge-desk',
    actor: human(),
  });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function human() {
  return { id: fx.human.id, kind: 'human' as const };
}

const attempt = (overrides: Record<string, unknown> = {}) =>
  send({
    tenantId: fx.tenant.id,
    clientId,
    actorId: fx.human.id,
    channel: 'email',
    subject: 'Your capital options',
    body: 'A summary of your capital options is attached for your review.',
    jurisdiction: 'TX',
    sentBy: 'concierge-desk',
    actor: human(),
    now: MID_MORNING,
    ...overrides,
  });

describe('the send path', () => {
  it('passes every gate and stops honestly at the provider seam', async () => {
    // `not_built` rather than `ok`: the message was approved and nothing delivered it. Reporting
    // success would put "the client was told" in a compliance log when they were not.
    const result = await attempt();

    expect(result.status).toBe('not_built');
    if (result.status !== 'not_built') return;

    expect(result.module).toMatch(/email provider/);
    expect(result.reason).toMatch(/logged as approved to send/);
    // **The refusal names the gate now, not a constant.** Email was outside the vendor model
    // entirely until ADR-0085 - it could have been switched on by editing one line, with no
    // evidence, no accountable person and no record.
    expect(result.reason).toMatch(/vendor selection|Argus|DPA|attestation/i);

    const log = await communicationsFor(fx.tenant.id, clientId);
    const approved = log.filter((entry) => entry.status === 'approved_to_send');
    expect(approved).toHaveLength(1);
    expect(approved[0]?.body).toMatch(/capital options/);
  });

  it('refuses a channel the client has not permitted, and logs the attempt', async () => {
    // "We tried to contact this client and could not" is evidence. A log holding only what went
    // out would answer a regulator with the half that flatters us.
    const result = await attempt({ channel: 'voice' });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/has not permitted voice/);
    }

    const log = await communicationsFor(fx.tenant.id, clientId);
    const blocked = log.filter((entry) => entry.channel === 'voice');
    expect(blocked[0]?.status).toBe('blocked');
    expect(blocked[0]?.blockedReason).toMatch(/has not permitted voice/);
    // The body is kept on a blocked attempt too: what we tried to say is part of the record.
    expect(blocked[0]?.body.length).toBeGreaterThan(10);
  });

  it('refuses an SMS outside the client local window', async () => {
    const result = await attempt({ channel: 'sms', now: TOO_EARLY });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/Local time in America\/Chicago is 07:00/);
    }
  });

  it('sends the same SMS later the same day', async () => {
    const result = await attempt({ channel: 'sms', now: MID_MORNING });
    expect(result.status).toBe('not_built');
  });

  it('refuses a message to a client in a state nobody activated', async () => {
    // Step 5 of the chain. An email is a client-facing action, and principle 6 gates those on a
    // state compliance check.
    const result = await attempt({ jurisdiction: 'NV' });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/No regulatory module exists for NV/);
    }
  });

  it('refuses a message containing banned language', async () => {
    // Step 7. A banned phrase reaching a client is the failure 4.2 exists to prevent, and this is
    // the path that would otherwise carry it there.
    const result = await attempt({ body: 'Your approval is guaranteed once you sign.' });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/Marketing Claim Library bans/);
      expect(result.reason).toMatch(/approval is guaranteed/);
    }

    const log = await communicationsFor(fx.tenant.id, clientId);
    expect(log.some((entry) => entry.body.includes('approval is guaranteed'))).toBe(true);
    expect(log.find((entry) => entry.body.includes('approval is guaranteed'))?.status).toBe(
      'blocked',
    );
  });

  it('refuses an empty message', async () => {
    expect((await attempt({ body: '   ' })).status).toBe('refused');
  });
});

describe('do-not-call cannot be overridden', () => {
  it('blocks SMS and voice under urgency, and still permits email', async () => {
    const dncClient = await createClient(fx.tenant.id, 'Do Not Call Co', human());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: dncClient.id,
      to: 'pass',
      reason: 'test fixture',
      actor: human(),
    });
    await setPreferences({
      tenantId: fx.tenant.id,
      clientId: dncClient.id,
      emailAllowed: true,
      smsAllowed: true,
      timezone: 'America/Chicago',
      updatedBy: 'concierge-desk',
      actor: human(),
    });
    await setDoNotCall({
      tenantId: fx.tenant.id,
      clientId: dncClient.id,
      reason: 'Client asked to stop being texted on 2026-07-04.',
      setOn: new Date('2026-07-04T00:00:00.000Z'),
      updatedBy: 'concierge-desk',
      actor: human(),
    });

    const urgentSms = await attempt({
      clientId: dncClient.id,
      channel: 'sms',
      urgent: true,
      body: 'Urgent: your application needs a document today.',
    });

    // Urgency rerouted it to email rather than sending the SMS. It did not reach past do-not-call.
    expect(urgentSms.status).toBe('not_built');

    const log = await communicationsFor(fx.tenant.id, dncClient.id);
    expect(log.every((entry) => entry.channel !== 'sms' || entry.status === 'blocked')).toBe(true);
    const sent = log.find((entry) => entry.status === 'approved_to_send');
    expect(sent?.channel).toBe('email');
    expect(sent?.urgentReroute).toBe(true);
  });

  it('refuses a do-not-call instruction with no reason', async () => {
    const result = await setDoNotCall({
      tenantId: fx.tenant.id,
      clientId,
      reason: '   ',
      setOn: MID_MORNING,
      updatedBy: 'concierge-desk',
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });
});

describe('templates', () => {
  it('requires a subject on an email template', async () => {
    const result = await publishTemplate({
      tenantId: fx.tenant.id,
      key: 'no-subject',
      channel: 'email',
      body: 'Body without a subject.',
      publishedBy: 'concierge-desk',
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });

  it('renders variables and leaves unresolved placeholders visible', async () => {
    // "Hello {{firstName}}," is obviously broken and gets caught; "Hello ," looks like a
    // formatting slip and gets sent.
    await publishTemplate({
      tenantId: fx.tenant.id,
      key: 'status-update',
      channel: 'email',
      subject: 'An update on your application, {{firstName}}',
      body: 'Hello {{firstName}}, your application with {{provider}} is progressing.',
      publishedBy: 'concierge-desk',
      actor: human(),
    });

    const template = await currentTemplate(fx.tenant.id, 'status-update');
    if (template.status !== 'ok') throw new Error('expected a template');

    const rendered = render(template.value, { firstName: 'Dana' });
    expect(rendered.subject).toBe('An update on your application, Dana');
    expect(rendered.body).toContain('{{provider}}');
    expect(unresolvedPlaceholders(rendered.body)).toEqual(['provider']);
  });

  it('supersedes rather than editing, so an old message stays explicable', async () => {
    await publishTemplate({
      tenantId: fx.tenant.id,
      key: 'status-update',
      channel: 'email',
      subject: 'Update on your application',
      body: 'Hello {{firstName}}, there is news.',
      publishedBy: 'concierge-desk',
      actor: human(),
    });

    const template = await currentTemplate(fx.tenant.id, 'status-update');
    if (template.status !== 'ok') throw new Error('expected a template');
    expect(template.value.version).toBe(2);
  });
});

describe('the log and the Ledger', () => {
  it('never puts a message body in the Ledger', async () => {
    // The log is the audit record and holds the body; the Ledger is retained indefinitely and
    // carries a hash, so a message can be identified without being quoted.
    const events = await read({ tenantId: fx.tenant.id });
    const comms = events.filter((event) => event.type.startsWith('comms.'));
    expect(comms.length).toBeGreaterThan(0);

    for (const event of comms) {
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toMatch(/capital options is attached/);
      // The distinctive tail of the blocked message. A block reason legitimately QUOTES the
      // banned phrase - naming which phrase tripped is what makes the block actionable, and the
      // phrase comes from our own claim library rather than from the client. What must not appear
      // is the message itself.
      expect(serialized).not.toMatch(/once you sign/);
    }

    const blocked = comms.filter((event) => event.type === 'comms.message.blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]?.payload['bodyHash']).toBeDefined();
  });

  it('records an inbound message without gating it', async () => {
    // A client contacting us is not something to permit or refuse, and a system that dropped
    // inbound messages from a do-not-call client would lose the one asking to be called.
    const result = await recordInbound({
      tenantId: fx.tenant.id,
      clientId,
      channel: 'email',
      subject: 'Re: your update',
      body: 'Please stop emailing me about this.',
      receivedAt: MID_MORNING,
      recordedBy: 'concierge-desk',
      actor: human(),
    });
    expect(result.status).toBe('ok');

    const log = await communicationsFor(fx.tenant.id, clientId);
    expect(log.some((entry) => entry.direction === 'inbound')).toBe(true);
  });

  it('summarises what contacting this client has looked like', async () => {
    const summary = await contactSummary(fx.tenant.id, clientId);

    expect(summary.attempted).toBeGreaterThan(0);
    expect(summary.approved).toBeGreaterThan(0);
    expect(summary.blocked).toBeGreaterThan(0);
    expect(summary.inbound).toBe(1);
    expect(summary.blockReasons[0]?.reason.length).toBeGreaterThan(10);
  });
});

describe('the Evidence Vault gap is closed', () => {
  it('reports communications as real coverage rather than not_built', async () => {
    // The reason this slice was picked. Until now every client file carried a note saying a reader
    // "should not treat its absence as evidence that nothing was said."
    const file = await assembleEvidenceFile({ tenantId: fx.tenant.id, clientId, now: MID_MORNING });
    if (file.status !== 'ok') throw new Error('expected a file');

    const communications = file.value.coverage.find((entry) => entry.key === 'communications');
    expect(communications?.coverage).toBe('complete');
    expect(communications?.itemCount).toBeGreaterThan(0);

    expect(file.value.gaps.some((gap) => gap.includes('4.1 Communications Hub'))).toBe(false);
  });

  it('carries metadata into the file and leaves the bodies in the log', async () => {
    // An evidence file assembled for export should not carry every message a client was sent
    // inside it by default. A reader who needs the wording asks the log.
    const file = await assembleEvidenceFile({ tenantId: fx.tenant.id, clientId, now: MID_MORNING });
    if (file.status !== 'ok') throw new Error('expected a file');

    const section = file.value.sections.find((entry) => entry.key === 'communications');
    const serialized = JSON.stringify(section?.items);

    expect(serialized).toMatch(/bodyHash/);
    expect(serialized).not.toMatch(/capital options is attached/);
  });

  it('still reports an empty log as empty rather than as not_built', async () => {
    const quiet = await createClient(fx.tenant.id, 'Never Contacted Co', human());
    const file = await assembleEvidenceFile({
      tenantId: fx.tenant.id,
      clientId: quiet.id,
      now: MID_MORNING,
    });
    if (file.status !== 'ok') throw new Error('expected a file');

    const communications = file.value.coverage.find((entry) => entry.key === 'communications');
    expect(communications?.coverage).toBe('empty');
    expect(communications?.note).toMatch(/nothing sent, nothing blocked, nothing received/);
  });
});

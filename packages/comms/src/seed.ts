/**
 * The ordinary sends - 4.1's "email / SMS templates", seeded.
 *
 * These are the messages a file actually generates: a welcome, a document chase, an authorization
 * request, a status update, an offer, a decline, a reminder, a check-in. Nothing here sequences
 * them. 2.2 owns playbooks, waits and escalation, and a second scheduler in this package would
 * drift from it and give the operator two places to look - the same reasoning `templates.ts` gives
 * for staying thin.
 *
 * ## Every template is scanned before it is published
 *
 * `seedMessageTemplates` runs each body through 4.2 and publishes **nothing** unless all of them
 * pass. That is a deliberate ordering constraint, not a convenience: a template is a message that
 * will be sent many times, so a banned phrase in one is a banned phrase in every send it produces,
 * and the cheapest moment to catch it is before it is stored.
 *
 * It also means seeding templates into a tenant with no Marketing Claim Library **refuses**, with
 * the scanner's own reason. That is the correct answer rather than an inconvenience: the library is
 * what makes "this template is sendable" a statement about anything.
 *
 * Refusing the batch rather than the offending template is the other half of it. A half-published
 * template set leaves some send paths built and some absent, with nothing on the record saying
 * which - and "the welcome email exists but the document request does not" is discovered by a
 * client not receiving one.
 *
 * ## A requires-disclosure phrase is only usable when the disclosure is in the body
 *
 * 8.1 and 4.5 both check `text.includes(disclosure)` and refuse when it is missing, rather than
 * letting content through on the promise that somebody attaches it later. This seed holds itself to
 * the same rule, and `offer-received` is the template that demonstrates it: it says "up to", which
 * is a requires-disclaimer phrase, and it carries `DISCLOSURE_MAXIMUM` in its own body.
 *
 * The disclosure is IMPORTED rather than retyped. The check is exact string inclusion, so a
 * disclosure typed out by hand fails on a changed comma - and the failure reads as the template
 * being wrong rather than the copy being a duplicate.
 *
 * ## No voice templates
 *
 * Blueprint 4.1 routes voice through CapitalForge to VoiceForge, and 4.3 treats a call as something
 * that has already happened - it detects promises in a transcript rather than approving a script.
 * A voice template seeded here would be a script for a system that does not read it.
 */

import { DISCLOSURE_MAXIMUM } from '@bwc/claims';
import { scanForTenant } from '@bwc/scanner';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';
import type { Channel } from './windows.js';
import { publishTemplate, type TemplateRecord } from './templates.js';

export interface SeedTemplate {
  readonly key: string;
  readonly channel: Channel;
  readonly subject?: string;
  readonly body: string;
  /** What the send is for, so a reviewer can tell whether the wording matches the moment. */
  readonly purpose: string;
}

/** The standing disclosure every client-facing template carries. Principle 1. */
const NOT_A_LENDER =
  'Burkham Wickmont is not a lender, investment adviser, or credit repair organization. We do not make credit decisions and cannot promise any outcome.';

/**
 * The SMS footer.
 *
 * Short because it has to be, and present because 4.4's preference record is a gate rather than a
 * courtesy: a client who cannot find the way out of a channel has not meaningfully chosen it.
 */
const SMS_FOOTER = 'Reply STOP to stop messages from us.';

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    key: 'client-onboarding-welcome',
    channel: 'email',
    subject: 'Your file with Burkham Wickmont is open',
    purpose: 'Sent once, when a client record is created and an advisor is assigned.',
    body: [
      'Hello {{firstName}},',
      '',
      'Your file is open and {{advisorName}} is looking after it.',
      '',
      'What happens next:',
      '',
      '1. We ask you for a short list of documents.',
      '2. We review what you send and tell you which providers fit your business and which do not.',
      '3. If you decide to proceed, you authorize each application in writing before it is sent.',
      '',
      'Nothing goes to any provider until you have authorized that specific application.',
      '',
      NOT_A_LENDER,
      '',
      'Reply to this message with any question and it will reach {{advisorName}} directly.',
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
  {
    key: 'document-request',
    channel: 'email',
    subject: 'Documents needed for {{clientLegalName}}',
    purpose: 'The document chase. Sent when a file is missing something a review needs.',
    body: [
      'Hello {{firstName}},',
      '',
      'To carry on with the review of {{clientLegalName}} we need the following:',
      '',
      '{{documentList}}',
      '',
      'You can reply to this message with the files attached, or upload them from your portal.',
      '',
      'Send the documents as they were issued. We do not alter anything you send us, and a provider will compare what we forward against its own records.',
      '',
      NOT_A_LENDER,
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
  {
    key: 'document-request-reminder-sms',
    channel: 'sms',
    purpose: 'Short nudge on an outstanding document. Subject to 4.4 quiet hours.',
    body: [
      '{{firstName}}, {{advisorName}} at Burkham Wickmont. We are still waiting on {{documentName}} for your file. Reply here or upload it in your portal.',
      SMS_FOOTER,
    ].join(' '),
  },
  {
    key: 'application-authorization-request',
    channel: 'email',
    subject: 'Your authorization is needed for {{providerName}}',
    purpose:
      'Sent before any submission. The written authorization the middleware chain requires for a specific application.',
    body: [
      'Hello {{firstName}},',
      '',
      'We would like to submit an application for {{clientLegalName}} to {{providerName}} under reference {{applicationReference}}.',
      '',
      'We cannot send it without your written authorization for this application. Authorizing it covers this application and no other.',
      '',
      'What {{providerName}} will receive: {{packetSummary}}',
      '',
      'To authorize, open {{authorizationLink}} and confirm. If you would rather not proceed, reply and tell us; we will not send it, and there is nothing further you need to do.',
      '',
      NOT_A_LENDER,
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
  {
    key: 'application-submitted',
    channel: 'email',
    subject: 'Submitted to {{providerName}}',
    purpose: 'Status update on submission, so the client is not left wondering.',
    body: [
      'Hello {{firstName}},',
      '',
      'The application for {{clientLegalName}} went to {{providerName}} on {{submittedOn}} under reference {{applicationReference}}, with your authorization on file.',
      '',
      '{{providerName}} decides on its own timetable and we do not control it. We will tell you what they say as soon as they say it, including if the answer is no.',
      '',
      'If they come back to us for more information we will forward the request to you rather than answer on your behalf.',
      '',
      NOT_A_LENDER,
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
  {
    key: 'offer-received',
    channel: 'email',
    subject: 'An offer from {{providerName}}',
    purpose:
      'Sent when a provider approves. Uses a requires-disclaimer phrase and carries the disclosure in the body.',
    body: [
      'Hello {{firstName}},',
      '',
      '{{providerName}} has approved {{clientLegalName}} for {{approvedCreditLimit}} on {{productName}}.',
      '',
      'The product is published with limits of up to {{productCeiling}}. The figure above is the one approved for you, and it is the only one that applies to this offer.',
      '',
      DISCLOSURE_MAXIMUM,
      '',
      'The full terms, including the cost of the facility and any fees, are in the attached summary. Read it before you accept. We can go through it with you on a call if that is easier.',
      '',
      'Accepting is your decision and there is no deadline from us.',
      '',
      NOT_A_LENDER,
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
  {
    key: 'provider-declined',
    channel: 'email',
    subject: 'A decision from {{providerName}}',
    purpose:
      'The message nobody writes in advance and everybody needs. A decline is a recorded outcome under 5.5.',
    body: [
      'Hello {{firstName}},',
      '',
      '{{providerName}} has declined the application for {{clientLegalName}} under reference {{applicationReference}}. The reason they gave us is: {{declineReason}}',
      '',
      'This is one provider and one decision. It is recorded on your file so that we do not send you back to the same place on the same basis.',
      '',
      '{{advisorName}} will come back to you with what this changes, if anything, and which other providers are worth trying. If the answer is that none are worth trying right now, we will tell you that instead.',
      '',
      NOT_A_LENDER,
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
  {
    key: 'appointment-reminder-sms',
    channel: 'sms',
    purpose: 'Reminder for a booked call. Subject to 4.4 quiet hours.',
    body: [
      '{{firstName}}, reminder: your call with {{advisorName}} at Burkham Wickmont is {{appointmentAt}}. Reply here to move it.',
      SMS_FOOTER,
    ].join(' '),
  },
  {
    key: 'post-funding-checkin',
    channel: 'email',
    subject: 'Checking in on {{clientLegalName}}',
    purpose:
      'The stewardship send - principle 2. Recurring after funding, on the cadence 2.2 sets.',
    body: [
      'Hello {{firstName}},',
      '',
      'It has been {{monthsSinceFunding}} months since {{providerName}} funded {{clientLegalName}}, and this is the check-in we said we would make.',
      '',
      'Two things worth a look:',
      '',
      '1. Whether the facility is doing what you took it for.',
      '2. Whether anything has changed in the business that would change what is available to you.',
      '',
      'If a promotional period on any of your facilities is coming to an end, the rate that follows is set by the provider and is ordinarily higher. We track those dates and will flag them before they arrive.',
      '',
      'Reply with a time and {{advisorName}} will call you.',
      '',
      NOT_A_LENDER,
      '',
      '{{advisorName}}',
      'Burkham Wickmont',
    ].join('\n'),
  },
];

export interface TemplateSeedFinding {
  readonly key: string;
  readonly phrase: string;
  readonly disposition: 'banned' | 'requires_disclaimer';
  readonly detail: string;
}

export interface TemplateSeedReport {
  readonly published: readonly TemplateRecord[];
  /** Library entries each body was checked against, so a pass says how much it checked. */
  readonly libraryEntriesChecked: number;
}

/**
 * Seed the message templates, scanning every body first.
 *
 * The scan happens for ALL templates before any is published, so a failure leaves the tenant with
 * whatever it had rather than with a partial set.
 *
 * Never runs on import.
 */
export const seedMessageTemplates = async (
  tenantId: string,
  publishedBy: string,
  actor: EventActor,
  now?: Date,
): Promise<Outcome<TemplateSeedReport>> => {
  const findings: TemplateSeedFinding[] = [];
  let libraryEntriesChecked = 0;

  for (const template of SEED_TEMPLATES) {
    // The subject is client-facing too. A banned phrase in a subject line is the part of the
    // message that arrives whether or not it is opened.
    const text = `${template.subject ?? ''}\n${template.body}`;

    const scan = await scanForTenant({
      tenantId,
      text,
      actor,
      context: `message template ${template.key}`,
    });

    // An empty library refuses here, and propagating that verbatim is the honest answer: these
    // templates cannot be called sendable until there is something to check them against.
    if (scan.status !== 'ok') return scan as Outcome<never>;
    libraryEntriesChecked = scan.value.libraryEntriesChecked;

    for (const finding of scan.value.findings) {
      if (finding.disposition === 'banned') {
        findings.push({
          key: template.key,
          phrase: finding.phrase,
          disposition: 'banned',
          detail: finding.rationale,
        });
      }
    }

    // The stricter rule, applied here rather than left to the send path: the disclosure has to be
    // in this body, because there is no later step that adds one.
    for (const disclosure of scan.value.requiredDisclosures) {
      if (!text.includes(disclosure)) {
        findings.push({
          key: template.key,
          phrase:
            scan.value.findings.find((f) => f.requiredDisclosure === disclosure)?.phrase ??
            '(unknown)',
          disposition: 'requires_disclaimer',
          detail: `The body uses language that obliges this disclosure and does not contain it: ${disclosure}`,
        });
      }
    }
  }

  if (findings.length > 0) {
    return refused(
      `${findings.length} seeded message template problem(s), so none was published: ${findings
        .map((finding) => `'${finding.key}' (${finding.disposition}: '${finding.phrase}')`)
        .join(', ')}. A template is sent many times, so a claim-library problem in one is a problem in every send it produces.`,
      'Blueprint 4.1 with 4.2 and 7.4 - a template that cannot pass the scanner is not a template',
    );
  }

  const published: TemplateRecord[] = [];
  for (const template of SEED_TEMPLATES) {
    const result = await publishTemplate({
      tenantId,
      key: template.key,
      channel: template.channel,
      ...(template.subject !== undefined ? { subject: template.subject } : {}),
      body: template.body,
      publishedBy,
      actor,
      ...(now !== undefined ? { now } : {}),
    });
    if (result.status === 'ok') published.push(result.value);
  }

  return ok({ published, libraryEntriesChecked });
};

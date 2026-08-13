/**
 * The call lifecycle, and the VoiceForge seam - blueprint 4.3.
 *
 * Blueprint 4.3 routes through **CapitalForge -> VoiceForge**, which is not gated in. So audio
 * capture, transcription and AI summary generation report `not_built`, and everything that
 * operates on a transcript once one exists is fully built in `detect.ts`.
 *
 * The same split as 3.3, and worth restating because it is the thing that keeps this module
 * honest: the seam says what it is, and the analysis is ready the day a transcript arrives rather
 * than being written then, under time pressure, by somebody who has forgotten why the rules were
 * what they were.
 *
 * `beginCall` is NOT a `not_built` seam. It is the consent decision, and that is real work with
 * real consequences whether or not any audio is captured - so it records a call either way, and a
 * refused consent produces a `consent_refused` record rather than nothing. "We wanted to record
 * this call and could not" is evidence, the same way a blocked send is in 4.1.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { notBuilt, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { activationStanding } from '@bwc/integration';
import { requiredDisclosures } from '@bwc/regulatory';
import { mayRecord } from './consent.js';
import {
  checkDisclosures,
  detectPromises,
  detectSignals,
  type ConversationSignals,
  type DisclosureCheck,
  type PromiseFinding,
  type TranscriptTurn,
} from './detect.js';
import { raiseObligations, type Obligation } from './obligations.js';

export type CallStatus = 'consent_refused' | 'recording' | 'captured' | 'analysed';

export interface CallRecord {
  readonly id: string;
  readonly clientId: string;
  readonly status: CallStatus;
  readonly jurisdiction: string;
  readonly clientConsentRequired: boolean;
  readonly consentBasis: string;
  readonly purpose: string;
  readonly startedAt: string;
  readonly recordingPermitted: boolean;
}

export interface BeginCallInput {
  readonly tenantId: string;
  readonly clientId: string;
  /** Two-letter state code where the CLIENT is. */
  readonly jurisdiction: string;
  readonly purpose: string;
  readonly internalParticipants: readonly string[];
  readonly startedAt: Date;
  readonly actor: EventActor;
}

/**
 * Open a call record and decide whether it may be recorded.
 *
 * Returns `ok` in both directions - permitted and not - because the call happens either way. What
 * changes is whether a recording may be made, and the record says which, on what basis, and under
 * which state's rule. `consentBasis` is stored rather than derived later: the rule may change, and
 * the question a regulator asks is what the rule was on the day.
 */
export const beginCall = async (input: BeginCallInput): Promise<Outcome<CallRecord>> => {
  if (input.purpose.trim() === '') {
    return refused(
      'A call record needs a stated purpose. Without one there is no way to judge later whether the disclosures it required were the right ones.',
      'Blueprint 4.3 - call recordings and summaries',
    );
  }
  if (input.internalParticipants.length === 0) {
    return refused(
      'A call record needs at least one internal participant. A promise with no speaker is an obligation with no owner.',
      'Blueprint 4.3 - promise tracking',
    );
  }

  const verdict = await mayRecord({
    tenantId: input.tenantId,
    clientId: input.clientId,
    jurisdiction: input.jurisdiction,
    now: input.startedAt,
  });
  if (verdict.status !== 'ok') return verdict as Outcome<never>;

  const row = await db().callRecord.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: verdict.value.permitted ? 'recording' : 'consent_refused',
      jurisdiction: verdict.value.requirement.state,
      clientConsentRequired: verdict.value.requirement.clientConsentRequired,
      consentBasis: verdict.value.detail,
      purpose: input.purpose,
      startedAt: input.startedAt,
      internalParticipants: [...input.internalParticipants],
    },
  });

  await append({
    tenantId: input.tenantId,
    type: verdict.value.permitted ? 'calls.recording.started' : 'calls.recording.refused',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      callId: row.id,
      jurisdiction: verdict.value.requirement.state,
      regime: verdict.value.requirement.regime,
      clientConsentRequired: verdict.value.requirement.clientConsentRequired,
    },
  });

  return ok({
    id: row.id,
    clientId: row.clientId,
    status: row.status as CallStatus,
    jurisdiction: row.jurisdiction,
    clientConsentRequired: row.clientConsentRequired,
    consentBasis: row.consentBasis,
    purpose: row.purpose,
    startedAt: row.startedAt.toISOString(),
    recordingPermitted: verdict.value.permitted,
  });
};

/**
 * Capture the audio and produce a transcript and summary.
 *
 * `not_built`. VoiceForge is not gated in, and returning `ok` with an empty transcript would put a
 * call in the store looking analysed and clean - which is the exact reading design principle 9
 * exists to prevent, applied to the module where a false clean reading means a promise nobody
 * corrected.
 */
export const captureCall = async (callId: string): Promise<Outcome<never>> => {
  // A gate rather than a constant sentence. `voice` is a vendor now (ADR-0085), so this names the
  // evidence still outstanding and going live takes the same four items Plaid needs - rather than
  // an edit to this line.
  //
  // Recording a call is the seam with the sharpest consent exposure in the system: several states
  // require all-party consent, and that rule is an INVARIANT rather than a parameter. A capture
  // path that could be switched on without a security review is the one worth gating hardest.
  const standing = await activationStanding('voice');
  return notBuilt(
    '11.5 Integration Layer - voice provider',
    `Call ${callId} is on record with its consent basis, but no audio was captured, no transcript exists and no summary was generated: ${standing.explanation} Analysis (promise detection, disclosure completeness, objections and buying signals) is built and runs the moment a transcript is supplied.`,
  );
};

/**
 * Attach a transcript from outside.
 *
 * The seam a transcript arrives through while VoiceForge is ungated - a human paste, an export,
 * an eventual provider. Kept separate from `captureCall` so the vendor's absence stays visible
 * rather than being quietly satisfied by whoever calls this.
 */
export const attachTranscript = async (input: {
  tenantId: string;
  callId: string;
  turns: readonly TranscriptTurn[];
  source: string;
  endedAt: Date;
  actor: EventActor;
}): Promise<Outcome<{ callId: string; turns: number }>> => {
  if (input.turns.length === 0) {
    return refused(
      'An empty transcript cannot be attached. A call analysed against nothing would report no promises and no missing disclosures, which reads exactly like a clean call.',
      'Design principle 9 - an empty result is not a clean result',
    );
  }

  const call = await db().callRecord.findFirst({
    where: { tenantId: input.tenantId, id: input.callId },
  });
  if (!call) {
    return refused(
      `No call ${input.callId} is on record in this tenant.`,
      'Principle 5 - tenant isolation',
    );
  }
  if (call.status === 'consent_refused') {
    return refused(
      'This call was not permitted to be recorded, so a transcript of it should not exist. Attaching one would mean a recording was made after the consent check said no.',
      'Blueprint 4.3 - every call recorded WITH CONSENT',
    );
  }

  await db().callRecord.update({
    where: { id: call.id },
    data: {
      status: 'captured',
      endedAt: input.endedAt,
      recordingReference: input.source,
      transcript: input.turns as unknown as object,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'calls.transcript.attached',
    actor: input.actor,
    clientId: call.clientId,
    payload: { callId: call.id, source: input.source, turns: input.turns.length },
  });

  return ok({ callId: call.id, turns: input.turns.length });
};

export interface CallAnalysis {
  readonly callId: string;
  readonly promises: readonly PromiseFinding[];
  readonly obligations: readonly Obligation[];
  readonly disclosures: DisclosureCheck;
  readonly signals: ConversationSignals;
  readonly summary: Outcome<never>;
}

/**
 * Analyse a captured call.
 *
 * Runs the built analysis and raises obligations for whatever it found. The AI SUMMARY is reported
 * as its own `not_built` inside the result rather than being omitted, because a caller who gets an
 * analysis with no summary field would reasonably conclude the call did not need one.
 *
 * Disclosure requirements come from 7.2 for the call's jurisdiction, so a call in an activated
 * state is checked against that state's obligations rather than a list this module invented.
 */
export const analyseCall = async (input: {
  tenantId: string;
  callId: string;
  owedBy: string;
  actor: EventActor;
  productKind?: string;
  now?: Date;
}): Promise<Outcome<CallAnalysis>> => {
  const now = input.now ?? new Date();

  const call = await db().callRecord.findFirst({
    where: { tenantId: input.tenantId, id: input.callId },
  });
  if (!call) {
    return refused(
      `No call ${input.callId} is on record in this tenant.`,
      'Principle 5 - tenant isolation',
    );
  }
  if (call.transcript === null) {
    return notBuilt(
      '11.5 Integration Layer - CapitalForge to VoiceForge',
      `Call ${input.callId} has no transcript, so there is nothing to analyse. This is the vendor seam rather than a clean call: no promise detection has run.`,
    );
  }

  const turns = call.transcript as unknown as readonly TranscriptTurn[];

  const promises = detectPromises(turns);
  const signals = detectSignals(turns);

  const required = await requiredDisclosures({
    tenantId: input.tenantId,
    state: call.jurisdiction,
    ...(input.productKind !== undefined ? { productKind: input.productKind } : {}),
  });

  const disclosures = checkDisclosures(
    turns,
    required.map((disclosure) => ({ key: disclosure.key, text: disclosure.text })),
  );

  const obligations = await raiseObligations({
    tenantId: input.tenantId,
    clientId: call.clientId,
    callId: call.id,
    findings: promises,
    owedBy: input.owedBy,
    actor: input.actor,
    now,
  });
  if (obligations.status !== 'ok') return obligations as Outcome<never>;

  await db().callRecord.update({
    where: { id: call.id },
    data: { status: 'analysed', analysedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'calls.analysed',
    actor: input.actor,
    clientId: call.clientId,
    payload: {
      callId: call.id,
      promises: promises.length,
      disclosuresMissing: disclosures.missing.length,
      objections: signals.objections.length,
      buyingSignals: signals.buyingSignals.length,
    },
  });

  return ok({
    callId: call.id,
    promises,
    obligations: obligations.value,
    disclosures,
    signals,
    // Carried as a value rather than omitted. An analysis with no summary field reads as a call
    // that did not need one.
    summary: notBuilt(
      '11.5 Integration Layer - VoiceForge summary generation',
      'No AI summary was generated: the summary provider is not gated in. The findings above were produced by the built analysis, not by a model.',
    ),
  });
};

export const callsFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly CallRecord[]> => {
  const rows = await db().callRecord.findMany({
    where: { tenantId, clientId },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    status: row.status as CallStatus,
    jurisdiction: row.jurisdiction,
    clientConsentRequired: row.clientConsentRequired,
    consentBasis: row.consentBasis,
    purpose: row.purpose,
    startedAt: row.startedAt.toISOString(),
    recordingPermitted: row.status !== 'consent_refused',
  }));
};

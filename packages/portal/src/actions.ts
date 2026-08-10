/**
 * What a client can do - blueprint 11.10.
 *
 * Every action here is a call into the module that owns the gate. None of them re-implements a
 * check, and that is the point: a portal check would be a second copy of a rule, and the second
 * copy is the one that would be wrong when they disagreed.
 *
 *   upload    -> 3.2 Secure Document Vault, which encrypts and holds the document UNREADABLE
 *                until its scan completes. The portal does not decide that; it cannot.
 *   sign      -> 1.5 Consent & Authorization Center. A signature is a consent record.
 *   message   -> 4.1 Communications Hub, whose INBOUND path is deliberately ungated - a client
 *                contacting us is not something to permit or refuse.
 *   Plaid     -> not_built, per Decision A.
 *
 * The one thing the portal enforces is that the acting client is acting on their own file.
 */

import { store as storeDocument, type DocumentKind } from '@bwc/vault';
import { grant as grantConsent, type ConsentKind } from '@bwc/consent';
import { recordInbound } from '@bwc/comms';
import { notBuilt, ok, refused, type Outcome } from '@bwc/core';
import type { ClientPrincipal } from './views.js';

/**
 * The document kinds a client may upload.
 *
 * The client supplies their own records. Everything else in 3.2 - credit_report,
 * lender_application, adverse_action_notice, signed_authorization - is something WE produce or
 * receive on their behalf, and a client-supplied copy would sit alongside ours with nothing saying
 * which is authoritative. `other` is excluded for the same reason in reverse: a kind that means
 * anything is a kind nothing can be routed on.
 */
export const CLIENT_UPLOADABLE_KINDS: readonly DocumentKind[] = [
  'bank_statement',
  'tax_return',
  'government_id',
  'entity_document',
  'profit_and_loss',
  'balance_sheet',
  'debt_schedule',
];

export interface UploadResult {
  readonly documentId: string;
  readonly scanStatus: string;
  readonly detail: string;
}

/**
 * Upload a document.
 *
 * Goes straight to 3.2 with the client's own id. The document lands `pending` and is unreadable
 * until the scan completes - that is 3.2's rule, enforced in 3.2, and this function could not
 * bypass it if it wanted to.
 *
 * The returned detail says the document is not yet usable, because a client who uploads a
 * statement and sees it appear will otherwise assume the work has started.
 */
export const uploadDocument = async (input: {
  principal: ClientPrincipal;
  kind: DocumentKind;
  filename: string;
  contentType: string;
  content: Buffer;
  vaultConfig: Parameters<typeof storeDocument>[0];
}): Promise<Outcome<UploadResult>> => {
  if (!CLIENT_UPLOADABLE_KINDS.includes(input.kind)) {
    return refused(
      `A client cannot upload a document of kind '${input.kind}' through the portal. The kinds a client supplies are: ${CLIENT_UPLOADABLE_KINDS.join(', ')}. Anything else is something we produce, and a client-supplied copy of it would sit alongside ours with nothing saying which is authoritative.`,
      'Blueprint 11.10 - deliberately minimal scope',
    );
  }

  const stored = await storeDocument(input.vaultConfig, {
    tenantId: input.principal.tenantId,
    clientId: input.principal.clientId,
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    content: input.content,
    actorId: input.principal.actorId,
  });

  if (stored.status !== 'ok') return stored as Outcome<never>;

  return ok({
    documentId: stored.value.id,
    scanStatus: stored.value.scanStatus,
    detail:
      'Uploaded and encrypted. It is not readable by anyone, including us, until the malware scan completes - so nothing has started on it yet. You will not need to upload it again.',
  });
};

/**
 * Sign a disclosure.
 *
 * A signature IS a consent record, so this creates one in 1.5 rather than storing a signature
 * somewhere and hoping the two stay aligned. A signature that lived in the portal and a consent
 * that lived in 1.5 would be two records of one act, and a revocation would only reach one.
 *
 * The scope is required and is the text the client is agreeing to. 1.5 refuses an unscoped
 * consent, so this cannot become a blanket authorization by omission.
 */
export const signDisclosure = async (input: {
  principal: ClientPrincipal;
  kind: ConsentKind;
  scope: string;
  expiresAt?: Date;
}): Promise<Outcome<{ consentId: string; detail: string }>> => {
  const granted = await grantConsent({
    tenantId: input.principal.tenantId,
    clientId: input.principal.clientId,
    kind: input.kind,
    scope: input.scope,
    actor: { id: input.principal.actorId, kind: 'human' },
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });

  if (granted.status !== 'ok') return granted as Outcome<never>;

  return ok({
    consentId: granted.value.id,
    detail:
      'Recorded as an authorization in the Consent & Authorization Center. You can withdraw it at any time, and withdrawal takes effect on the next action rather than at the end of any window.',
  });
};

/**
 * Send a message to the Concierge Desk.
 *
 * Inbound only, and ungated - 4.1 made that call deliberately: a system that dropped inbound
 * messages from a do-not-call client would lose the one where they asked to be called.
 *
 * There is no outbound path here. A client message is answered through 4.1's send path, which runs
 * the preference gate, the middleware chain and the compliance scanner. A portal reply that
 * skipped those would be the one piece of client-facing text nobody checked.
 */
export const sendMessage = async (input: {
  principal: ClientPrincipal;
  subject?: string;
  body: string;
  receivedAt?: Date;
}): Promise<Outcome<{ communicationId: string; detail: string }>> => {
  if (input.body.trim() === '') {
    return refused(
      'An empty message cannot be sent.',
      'Blueprint 4.1 - the communication log is the audit record',
    );
  }

  const recorded = await recordInbound({
    tenantId: input.principal.tenantId,
    clientId: input.principal.clientId,
    channel: 'email',
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    body: input.body,
    receivedAt: input.receivedAt ?? new Date(),
    recordedBy: input.principal.actorId,
    actor: { id: input.principal.actorId, kind: 'human' },
  });

  if (recorded.status !== 'ok') return recorded as Outcome<never>;

  return ok({
    communicationId: recorded.value.communicationId,
    detail: 'Delivered to the Concierge Desk and recorded in your communication history.',
  });
};

/**
 * Connect a bank account through Plaid Link.
 *
 * `not_built`, per Decision A. Blueprint 11.10's change from v1 puts the Plaid Link experience in
 * the Portal, and Decision A puts Plaid behind an Argus security review, a signed DPA and SOC 2
 * Type II - none of which has happened.
 *
 * Worth being precise about what this refusal protects. Plaid Link hands us a token that reads a
 * client's bank transactions. A half-built version that captured the authorization without the
 * review would be the exact sequence Decision A exists to prevent: the client authorizes, and the
 * security question is asked afterwards.
 */
export const connectBankAccount = async (principal: ClientPrincipal): Promise<Outcome<never>> =>
  notBuilt(
    '11.5 Integration Layer - Plaid Link (Decision A)',
    `Bank connection is not available for client ${principal.clientId}. Decision A requires Plaid to clear Argus security review, a signed DPA and SOC 2 Type II before any client connects an account. Capturing the authorization now and asking the security question afterwards is the sequence that decision exists to prevent.`,
  );

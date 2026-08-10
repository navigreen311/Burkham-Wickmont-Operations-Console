/**
 * What a client can see - blueprint 11.10, "the Secure Client Delivery Room".
 *
 * Blueprint 11.10 says "deliberately minimal scope" and "not a SaaS dashboard", and this file
 * takes that literally.
 *
 * **The portal decides nothing.** The tempting build is a portal-specific permission model - a list
 * of what clients may see. That list would drift from 3.2's document classes, 11.1's access model
 * and 1.5's consent records, and the drifted copy is the one that would actually be enforced.
 *
 * So every view asks the module that owns the fact. The portal composes; it does not judge. The
 * one rule it enforces itself is the one no other module can: **the client sees their own file and
 * nothing else**, checked against the resolved client identity rather than an id the caller
 * supplied.
 */

import { db } from '@bwc/db';
import { forClient as documentsForClient } from '@bwc/vault';
import { forClient as deliverablesForClient } from '@bwc/deliverables';
import { forClient as consentsForClient } from '@bwc/consent';
import { communicationsFor } from '@bwc/comms';
import { engagementsForClient } from '@bwc/billing';
import { noData, ok, type Outcome } from '@bwc/core';

/**
 * A resolved client identity.
 *
 * Taken as a value rather than resolved here. 11.1 owns identity, and a portal that authenticated
 * its own users would be a second login with a second session model - and the second one is the
 * one that would be wrong. The caller has authenticated; this is who they turned out to be.
 */
export interface ClientPrincipal {
  readonly tenantId: string;
  readonly clientId: string;
  /** For the access log. A client file read is still a read. */
  readonly actorId: string;
}

export interface EngagementView {
  readonly engagementId: string;
  readonly offerKey: string;
  readonly status: string;
  readonly startedOn: string;
  readonly outstandingCents: number;
}

export interface DocumentView {
  readonly documentId: string;
  readonly kind: string;
  readonly filename: string;
  /** `pending` until 3.2's scan completes. Shown as such - see `actions.ts`. */
  readonly scanStatus: string;
  /** Retention horizon, when 7.5 has set one. Null until then. */
  readonly storedAt: string | null;
}

export interface DeliverableView {
  readonly deliverableId: string;
  readonly templateKey: string;
  readonly version: number;
  readonly deliveredAt: string;
}

export interface DisclosureView {
  readonly consentId: string;
  readonly kind: string;
  readonly scope: string;
  readonly grantedAt: string;
  readonly revoked: boolean;
}

export interface MessageView {
  readonly direction: 'inbound' | 'outbound';
  readonly channel: string;
  readonly subject: string | null;
  readonly body: string;
  readonly occurredAt: string;
}

export interface ClientRoom {
  readonly clientLegalName: string;
  readonly complianceState: string;
  readonly engagements: readonly EngagementView[];
  readonly documents: readonly DocumentView[];
  readonly deliverables: readonly DeliverableView[];
  readonly disclosures: readonly DisclosureView[];
  readonly messages: readonly MessageView[];
  /** What the room deliberately does not show, and why. */
  readonly withheld: readonly string[];
}

/**
 * Everything in this client's room.
 *
 * `withheld` is carried for 7.1's reason applied to a client-facing surface: a room that silently
 * omits something asserts there is nothing there. A client who cannot see our internal assessment
 * of their file should be told that is a deliberate boundary rather than left to conclude nothing
 * exists.
 *
 * Only DELIVERED deliverables appear. A draft is work in progress, and 3.4's whole approval chain
 * exists so a client sees the approved version - showing a draft would route around it.
 */
export const clientRoom = async (principal: ClientPrincipal): Promise<Outcome<ClientRoom>> => {
  const client = await db().client.findFirst({
    where: { tenantId: principal.tenantId, id: principal.clientId },
  });
  if (!client) return noData('No such client file.');

  const [documents, deliverables, consents, messages, engagements] = await Promise.all([
    documentsForClient(principal.tenantId, principal.clientId),
    deliverablesForClient(principal.tenantId, principal.clientId),
    consentsForClient(principal.tenantId, principal.clientId),
    communicationsFor(principal.tenantId, principal.clientId),
    engagementsForClient(principal.tenantId, principal.clientId),
  ]);

  return ok({
    clientLegalName: client.legalName,
    complianceState: client.complianceState,
    engagements: engagements.map((engagement) => ({
      engagementId: engagement.id,
      offerKey: engagement.offerId,
      status: engagement.status,
      startedOn: engagement.startedOn,
      outstandingCents: 0,
    })),
    documents: documents.map((document) => ({
      documentId: document.id,
      kind: document.kind,
      filename: document.filename,
      scanStatus: document.scanStatus,
      storedAt: document.retainUntil?.toISOString() ?? null,
    })),
    // Delivered only. 3.4's approval chain exists so a client sees the approved version.
    deliverables: deliverables
      .filter((deliverable) => deliverable.deliveredAt !== null)
      .map((deliverable) => ({
        deliverableId: deliverable.id,
        templateKey: deliverable.templateKey,
        version: deliverable.version,
        deliveredAt: (deliverable.deliveredAt as Date).toISOString(),
      })),
    disclosures: consents.map((consent) => ({
      consentId: consent.id,
      kind: consent.kind,
      scope: consent.scope,
      grantedAt: consent.grantedAt.toISOString(),
      revoked: consent.revokedAt !== null,
    })),
    // Blocked outbound attempts are NOT shown. The client did not receive them, and a room that
    // showed "we tried to text you and your own do-not-call instruction stopped us" would be
    // arguing with the client about a preference they set.
    messages: messages
      .filter((message) => message.status !== 'blocked')
      .map((message) => ({
        direction: message.direction,
        channel: message.channel,
        subject: message.subject,
        body: message.body,
        occurredAt: message.occurredAt,
      })),
    withheld: [
      'Our internal compliance findings and their reasoning. The compliance STATE is shown; the workings are our assessment and are held in the Compliance Evidence Vault (7.1).',
      'Capital provider recommendations before they are delivered as an approved deliverable (3.4).',
      'Draft deliverables. Only delivered versions appear, so what a client reads is what was approved.',
      'Blocked outbound messages. The client never received them.',
    ],
  });
};

/**
 * A single document, by id.
 *
 * Ownership is checked against the resolved principal, not against an id the caller passed
 * alongside it - a portal that trusted a `clientId` parameter would serve any file to anybody who
 * could guess a document id.
 */
export const documentInRoom = async (
  principal: ClientPrincipal,
  documentId: string,
): Promise<Outcome<DocumentView>> => {
  const documents = await documentsForClient(principal.tenantId, principal.clientId);
  const document = documents.find((entry) => entry.id === documentId);

  if (!document) {
    // Deliberately the same answer as a document that does not exist. Distinguishing them would
    // confirm to a caller that a document id belongs to somebody.
    return noData('No such document in this file.');
  }

  return ok({
    documentId: document.id,
    kind: document.kind,
    filename: document.filename,
    scanStatus: document.scanStatus,
    storedAt: document.retainUntil?.toISOString() ?? null,
  });
};

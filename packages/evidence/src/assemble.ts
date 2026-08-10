/**
 * Assembling a regulator-ready file - blueprint 7.1.
 *
 * > "Regulator-ready file generation in minutes; per-client vault view; per-engagement vault view."
 *
 * The registry below is the module. Each entry names where a kind of evidence lives, and every one
 * of them lives somewhere else - which is why this file reads and never writes. A version that
 * copied these facts into its own tables would produce a second version of each, drifting from the
 * first, and the copy is the one a regulator would be shown.
 *
 * Two sources are deliberately `not_built`. They are in the registry rather than omitted from it,
 * because a file that silently lacks a section asserts a completeness it does not have - and the
 * reader has no way to tell an absent section from an empty one.
 */

import { createHash } from 'node:crypto';
import { read, verifyIntegrity } from '@bwc/ledger';
import { find as findClient, openFindings } from '@bwc/clients';
import { forClient as consentForClient } from '@bwc/consent';
import { forClient as documentsForClient } from '@bwc/vault';
import { forClient as deliverablesForClient } from '@bwc/deliverables';
import { contractsForClient } from '@bwc/contracts';
import { engagementsForClient, recordsFor, refundsDue } from '@bwc/billing';
import { communicationMetadataFor } from '@bwc/comms';
import { timelineFor } from '@bwc/risk';
import { canonicalJson } from '@bwc/deliverables';
import { noData, ok, type Outcome } from '@bwc/core';
import {
  fromRows,
  notBuiltSource,
  runSource,
  type Coverage,
  type EvidenceSource,
  type SourceContext,
} from './sources.js';

/**
 * The registry.
 *
 * Ordered as a reader would work through a file: who the client is and what state they are in,
 * then what they authorized, then what was produced for them, then the money.
 */
export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  {
    key: 'compliance_state_transitions',
    module: '1.1 Client Lifecycle & CRM',
    description:
      'Every compliance categorical state transition, with the reasoning recorded at the time (Decision E).',
    fetch: async (context) => {
      const events = await read({
        tenantId: context.tenantId,
        clientId: context.clientId,
        type: 'client.compliance_state_changed',
      });
      return fromRows(
        events.map((event) => ({
          at: event.createdAt,
          payload: event.payload,
          actor: event.actor,
          seq: event.seq,
        })),
        'No state transition has been recorded; the client is still in the state it was created in.',
      );
    },
  },
  {
    key: 'compliance_findings',
    module: '1.1 Client Lifecycle & CRM',
    description: 'The findings that produced each transition, per Decision E.',
    fetch: async (context) =>
      fromRows(
        await openFindings(context.clientId),
        'No open compliance findings. Resolved findings appear in the transition history above.',
      ),
  },
  {
    key: 'authorizations',
    module: '1.5 Consent & Authorization Center',
    description:
      'Signed authorizations: application, bureau pull, Plaid connection, disclosure. Revoked ones included.',
    fetch: async (context) =>
      fromRows(
        await consentForClient(context.tenantId, context.clientId),
        'No authorizations on file. No application, bureau pull or bank connection may have proceeded.',
      ),
  },
  {
    key: 'documents',
    module: '3.2 Secure Document Vault',
    description:
      'Client-submitted document metadata. The bytes are not included - export goes through the Vault gate, which enforces legal hold.',
    fetch: async (context) => {
      const documents = await documentsForClient(context.tenantId, context.clientId);
      return fromRows(
        documents.map((document) => ({
          id: document.id,
          kind: document.kind,
          filename: document.filename,
          sha256: document.sha256,
          scanStatus: document.scanStatus,
          legalHold: document.legalHold,
          retainUntil: document.retainUntil,
          // `deletedAt` is carried deliberately. A document removed from active use is still part
          // of the client's history, and a file that silently omitted deleted records would
          // present a tidier picture than the one that exists.
          deletedAt: document.deletedAt,
        })),
        'No documents on file for this client.',
      );
    },
  },
  {
    key: 'deliverables',
    module: '3.1 Document & Deliverable Management',
    description:
      'Deliverables produced for the client, with their approval state and content hash.',
    fetch: async (context) => {
      const deliverables = await deliverablesForClient(context.tenantId, context.clientId);
      return fromRows(
        deliverables.map((deliverable) => ({
          id: deliverable.id,
          templateKey: deliverable.templateKey,
          version: deliverable.version,
          status: deliverable.status,
          contentHash: deliverable.contentHash,
        })),
        'No deliverables have been produced for this client.',
      );
    },
  },
  {
    key: 'contracts',
    module: '7.3 Contract & Disclosure Builder',
    description:
      'Contracts and disclosures issued, with the template and state module version each was generated against.',
    fetch: async (context) => {
      const contracts = await contractsForClient(context.tenantId, context.clientId);
      return fromRows(
        contracts.map((contract) => ({
          id: contract.id,
          kind: contract.kind,
          templateKey: contract.templateKey,
          templateVersion: contract.templateVersion,
          state: contract.state,
          stateModuleVersion: contract.stateModuleVersion,
          contentHash: contract.contentHash,
          disclosureKeys: contract.disclosureKeys,
          issuedAt: contract.issuedAt,
        })),
        'No contracts have been issued to this client.',
      );
    },
  },
  {
    key: 'engagements_and_billing',
    module: '1.4 Pricing, Billing & Offer Management',
    description: 'Engagements, and every charge, payment, refund and credit against them.',
    fetch: async (context) => {
      const engagements = await engagementsForClient(context.tenantId, context.clientId);
      const scoped =
        context.engagementId === undefined
          ? engagements
          : engagements.filter((engagement) => engagement.id === context.engagementId);

      const items = await Promise.all(
        scoped.map(async (engagement) => ({
          engagement,
          records: await recordsFor(context.tenantId, engagement.id),
        })),
      );

      return fromRows(items, 'No engagements on file for this client.');
    },
  },
  {
    key: 'refund_entitlements',
    module: '1.4 Pricing, Billing & Offer Management',
    description:
      'Refunds the record entitles the client to, and what was done about each. Derived, so it reflects the record at the moment of assembly.',
    fetch: async (context) => {
      const engagements = await engagementsForClient(context.tenantId, context.clientId);
      const scoped =
        context.engagementId === undefined
          ? engagements
          : engagements.filter((engagement) => engagement.id === context.engagementId);

      const entitlements = (
        await Promise.all(scoped.map((engagement) => refundsDue(context.tenantId, engagement.id)))
      ).flat();

      return fromRows(entitlements, 'The record shows no refund entitlement on this client.');
    },
  },
  {
    key: 'placement_history',
    module: '5.3 Funding Recommendation Engine',
    description:
      'Every placement request and its outcome - recommended, refused, and the reason for each.',
    fetch: async (context) => {
      const events = await read({ tenantId: context.tenantId, clientId: context.clientId });
      const placement = events.filter((event) => event.type.startsWith('placement.'));
      return fromRows(
        placement.map((event) => ({
          type: event.type,
          at: event.createdAt,
          payload: event.payload,
          seq: event.seq,
        })),
        'No placement has been requested for this client.',
      );
    },
  },
  {
    key: 'human_approvals',
    module: '3.4 Deliverable Approval Workflow, 6.4 Human Approval Console',
    description: 'Approvals and refusals recorded by a human actor.',
    fetch: async (context) => {
      const events = await read({ tenantId: context.tenantId, clientId: context.clientId });
      const approvals = events.filter(
        (event) => event.actor.kind === 'human' && /approved|reviewed|refused/.test(event.type),
      );
      return fromRows(
        approvals.map((event) => ({
          type: event.type,
          at: event.createdAt,
          actor: event.actor,
          payload: event.payload,
        })),
        'No human approval has been recorded against this client.',
      );
    },
  },
  {
    key: 'sales_and_attribution',
    module: '1.3 Sales Motion & Engagement Tracking',
    description: 'How the client arrived, and the attribution recorded at first contact.',
    fetch: async (context) => {
      const events = await read({ tenantId: context.tenantId, clientId: context.clientId });
      const sales = events.filter((event) => event.type.startsWith('sales.'));
      return fromRows(
        sales.map((event) => ({ type: event.type, at: event.createdAt, payload: event.payload })),
        'No sales-motion record is linked to this client.',
      );
    },
  },
  {
    key: 'communications',
    module: '4.1 Communications Hub',
    description:
      'Inbound and outbound client communications, including attempts that were blocked and why.',
    fetch: async (context) => {
      // Metadata only. The body lives in the communications log, which is the audit record; an
      // evidence file assembled for export should not carry every message a client was sent
      // inside it by default. A reader who needs the wording asks the log.
      const entries = await communicationMetadataFor(context.tenantId, context.clientId);
      return fromRows(
        entries,
        'No communication has been recorded with this client - nothing sent, nothing blocked, nothing received.',
      );
    },
  },
  {
    key: 'risk_timeline',
    module: '6.5 Risk Event Timeline with 6.4 Do Not Fund Governance',
    description:
      'Every risk-relevant event about this client in time order, with the Do Not Fund determination and the risk facts nothing monitors yet.',
    fetch: async (context) => {
      // Carried as one item rather than flattened into rows, because the timeline's value is the
      // things AROUND the entries: the standing Do Not Fund determination, and the list of risk
      // facts no integration produces. Flattened into a row list, an empty timeline would read as
      // a clean client, which is exactly the reading `unmonitored` exists to prevent.
      const timeline = await timelineFor(context.tenantId, context.clientId);
      return {
        items: [timeline],
        coverage: 'complete',
        note: `${timeline.entries.length} risk event(s), worst severity ${timeline.worst ?? 'none'}. ${timeline.doNotFund === null ? 'Not on the Do Not Fund list.' : 'ON THE DO NOT FUND LIST.'} ${timeline.unmonitored.length} risk fact(s) have no producer - see the section.`,
      };
    },
  },
  notBuiltSource(
    'client_complaints',
    '4.4 Complaint Handling',
    'Complaints raised by this client.',
    'Client complaint handling is not built. Note that 5.4 holds complaints about PROVIDERS, which is a different record and is not a substitute for this one.',
  ),
  notBuiltSource(
    'adverse_action_notices',
    '5.5 Funding Outcome Ledger',
    'Denial and adverse-action notices.',
    'The Funding Outcome Ledger is deferred to V1.5. Approvals and fundings recorded for billing purposes appear under engagements; formal denial notices are not yet captured anywhere.',
  ),
];

export interface CoverageEntry {
  readonly key: string;
  readonly module: string;
  readonly description: string;
  readonly coverage: Coverage;
  readonly note: string;
  readonly itemCount: number;
}

export interface EvidenceFile {
  readonly scope: 'client' | 'engagement';
  readonly clientId: string;
  readonly engagementId: string | null;
  readonly clientLegalName: string;
  readonly complianceState: string;
  readonly assembledAt: string;
  /** Section by section, in registry order. */
  readonly sections: readonly { key: string; module: string; items: readonly unknown[] }[];
  /**
   * What was consulted and what each source returned. The part that makes the file honest: a
   * reader can see which sections are empty and which do not exist.
   */
  readonly coverage: readonly CoverageEntry[];
  /**
   * The Ledger's own integrity result. Without it the file is a set of claims with no evidence
   * they were not edited afterwards; with it, a reader can check rather than trust.
   */
  readonly ledgerIntegrity: {
    readonly intact: boolean;
    readonly checked: number;
    readonly detail: string;
  };
  /** Sources that could not contribute, restated so a reader does not have to scan the map. */
  readonly gaps: readonly string[];
}

export interface AssembleInput {
  readonly tenantId: string;
  readonly clientId: string;
  /** Narrows the billing sections. Sources that cannot narrow say so in their note. */
  readonly engagementId?: string;
  readonly now?: Date;
}

/**
 * Assemble the file.
 *
 * Every source runs; a failure becomes a coverage entry rather than aborting the assembly, because
 * the file is most likely to be wanted at exactly the moment something is already wrong.
 */
export const assembleEvidenceFile = async (
  input: AssembleInput,
): Promise<Outcome<EvidenceFile>> => {
  const client = await findClient(input.tenantId, input.clientId);
  if (client.status !== 'ok') {
    return noData(`No client ${input.clientId} in this tenant, so there is no file to assemble.`);
  }

  const context: SourceContext = {
    tenantId: input.tenantId,
    clientId: input.clientId,
    ...(input.engagementId !== undefined ? { engagementId: input.engagementId } : {}),
  };

  const results = await Promise.all(
    EVIDENCE_SOURCES.map(async (source) => ({
      source,
      result: await runSource(source, context),
    })),
  );

  const integrity = await verifyIntegrity(input.tenantId);

  const coverage: CoverageEntry[] = results.map(({ source, result }) => ({
    key: source.key,
    module: source.module,
    description: source.description,
    coverage: result.coverage,
    note: result.note,
    itemCount: result.items.length,
  }));

  return ok({
    scope: input.engagementId === undefined ? 'client' : 'engagement',
    clientId: input.clientId,
    engagementId: input.engagementId ?? null,
    clientLegalName: client.value.legalName,
    complianceState: client.value.complianceState,
    assembledAt: (input.now ?? new Date()).toISOString(),
    sections: results.map(({ source, result }) => ({
      key: source.key,
      module: source.module,
      items: result.items,
    })),
    coverage,
    ledgerIntegrity: {
      intact: integrity.intact,
      checked: integrity.checked,
      detail:
        integrity.detail ??
        (integrity.intact
          ? `Chain verified across ${integrity.checked} entries.`
          : 'The chain did not verify.'),
    },
    gaps: coverage
      .filter((entry) => entry.coverage === 'not_built' || entry.coverage === 'failed')
      .map((entry) => `${entry.module} (${entry.key}): ${entry.note}`),
  });
};

/**
 * sha256 over the **evidence** in the file - ADR-0005 applied to an evidence package.
 *
 * Two fields are deliberately excluded, and the reason is what the hash is for. It identifies the
 * client's evidence, so that a copy somebody is holding can be compared against the current
 * picture. Neither excluded field is evidence about the client:
 *
 *   - `assembledAt` is when somebody pressed the button. Including it would make every assembly
 *     differ from every other, so no two files could ever be compared.
 *   - `ledgerIntegrity` is a statement about the whole tenant's chain at that moment, and its
 *     `checked` count moves whenever anything happens for *any* client. Worse, exporting appends
 *     an event of its own - so a file could not even match itself a second later.
 *
 * That second case is not hypothetical: it is what the reconciliation test found. A hash that
 * cannot reproduce itself makes reconciliation useless, and the field causing it was not part of
 * what the hash was supposed to identify.
 *
 * Coverage IS included. If a `not_built` module gets built, the file a regulator holds is out of
 * date in a way that matters, and the comparison should say so.
 */
export const hashEvidenceFile = (file: EvidenceFile): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        scope: file.scope,
        clientId: file.clientId,
        engagementId: file.engagementId,
        clientLegalName: file.clientLegalName,
        complianceState: file.complianceState,
        sections: file.sections,
        coverage: file.coverage,
      }),
    )
    .digest('hex');

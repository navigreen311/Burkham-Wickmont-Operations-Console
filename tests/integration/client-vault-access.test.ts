/**
 * Client access to the Vault - 3.2 with 11.10, the follow-on ADR-0021 named.
 *
 * Three properties carry this file.
 *
 * **Ownership replaces the authority level, and nothing else changes.** The test that matters is a
 * client reaching for another client's document: a build that reused the staff path would grant it,
 * because `MINIMUM_LEVEL_TO_READ` puts a bank statement at level 0 and a client has no level to
 * fail.
 *
 * **A document belonging to somebody else answers exactly as one that does not exist.** Anything
 * else confirms that a document id belongs to a client.
 *
 * **A legal hold refuses an export without saying why.** A litigation hold is frequently
 * confidential and may concern a dispute with the client asking; the real reason goes to the
 * access log, where an auditor reads it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read as ledgerRead } from '@bwc/ledger';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  generateKek,
  recordScanResult,
  setLegalHold,
  type VaultConfig,
} from '@bwc/vault';
import { enrolClientUser, inviteClientUser } from '@bwc/identity';
import { buildCapitalCommandBrief, pdfRenderer } from '@bwc/deliverables';
import { downloadDocument, principalFromToken, signIn, uploadDocument } from '@bwc/portal';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';
import { pdfText } from '../helpers/pdf.js';

let fx: Fixture;
let alpha: string;
let beta: string;
let vault: VaultConfig;
let alphaPrincipal: { tenantId: string; clientId: string; actorId: string };
let betaPrincipal: { tenantId: string; clientId: string; actorId: string };

const NOW = new Date('2026-08-11T12:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
/**
 * A real PDF, so the watermark test stamps something rather than asserting on a stub. The existing
 * vault test builds one the same way and for the same reason; a byte string beginning `%PDF` is
 * not a PDF, and `watermarkPdf` correctly declines to stamp one.
 */
let CONTENT: Buffer;

const enrolAndSignIn = async (clientId: string, email: string) => {
  const invited = await inviteClientUser({
    tenantId: fx.tenant.id,
    clientId,
    email,
    displayName: 'A Client Person',
    issuedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (invited.status !== 'ok') throw new Error('setup: invite');

  const enrolled = await enrolClientUser({
    tenantId: fx.tenant.id,
    token: invited.value.token,
    password: PASSWORD,
    actor: HUMAN(),
    now: NOW,
  });
  if (enrolled.status !== 'ok') throw new Error('setup: enrol');

  const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
  if (signedIn.status !== 'ok') throw new Error('setup: sign in');

  const principal = await principalFromToken({
    tenantId: fx.tenant.id,
    token: signedIn.value.token,
    now: NOW,
  });
  if (principal.status !== 'ok') throw new Error('setup: principal');
  return principal.value;
};

beforeAll(async () => {
  fx = await makeFixture('client-vault');
  CONTENT = await pdfRenderer.render(
    buildCapitalCommandBrief({
      clientLegalName: 'Alpha Manufacturing LLC',
      preparedOn: '2026-08-11',
      complianceState: 'pass',
      narrative: 'Synthetic statement page for testing.',
      positionFigures: [],
    }),
  );
  const root = await mkdtemp(join(tmpdir(), 'bwc-client-vault-'));
  process.env['VAULT_CLIENT_KEK'] = generateKek();
  vault = { store: new LocalEncryptedStore(root), kek: new EnvKekProvider('VAULT_CLIENT_KEK') };

  const [a, b] = await Promise.all([
    createClient(fx.tenant.id, 'Alpha Manufacturing LLC', HUMAN()),
    createClient(fx.tenant.id, 'Beta Logistics LLC', HUMAN()),
  ]);
  alpha = a.id;
  beta = b.id;

  alphaPrincipal = await enrolAndSignIn(alpha, 'alpha-user@example.com');
  betaPrincipal = await enrolAndSignIn(beta, 'beta-user@example.com');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('a client uploads to their own file', () => {
  let documentId: string;

  it('stores the document, encrypted and unreadable until scanned', async () => {
    const uploaded = await uploadDocument({
      principal: alphaPrincipal,
      kind: 'bank_statement',
      filename: 'august-statement.pdf',
      contentType: 'application/pdf',
      content: CONTENT,
      vaultConfig: vault,
    });

    expect(uploaded.status).toBe('ok');
    if (uploaded.status !== 'ok') return;
    documentId = uploaded.value.documentId;
    expect(uploaded.value.scanStatus).toBe('pending');

    // 3.2's rule, not a portal check: the client cannot read their own document either.
    const early = await downloadDocument({
      principal: alphaPrincipal,
      documentId,
      vaultConfig: vault,
      now: NOW,
    });
    expect(early.status).toBe('refused');
    if (early.status === 'refused') {
      // Said in words a client can act on, rather than "scan status: pending".
      expect(early.reason).toMatch(/still checking this file/);
      expect(early.reason).toMatch(/do not need to upload it again/);
    }
  });

  it("lands on the uploading client's file, with the client user as uploader", async () => {
    const row = await db().vaultDocument.findUnique({ where: { id: documentId } });
    expect(row?.clientId).toBe(alpha);
    // Not a service account: the client user's own id, so the access record says who.
    expect(row?.uploadedBy).toBe(alphaPrincipal.actorId);
  });

  it('records the upload on the Ledger as kind `client`', async () => {
    const events = await ledgerRead({
      tenantId: fx.tenant.id,
      clientId: alpha,
      type: 'vault.document_stored',
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.actor.kind).toBe('client');
    expect(events.at(-1)?.payload['uploadedByClient']).toBe(true);
  });

  it('reads once the scan clears', async () => {
    const scanned = await recordScanResult(fx.tenant.id, documentId, 'clean', fx.human.id);
    expect(scanned.status).toBe('ok');

    const opened = await downloadDocument({
      principal: alphaPrincipal,
      documentId,
      vaultConfig: vault,
      now: NOW,
    });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    expect(opened.value.content.equals(CONTENT)).toBe(true);
    expect(opened.value.watermarked).toBe(false);
  });

  it("watermarks an export with the client user's identity", async () => {
    const exported = await downloadDocument({
      principal: alphaPrincipal,
      documentId,
      displayName: 'Dana Reyes',
      action: 'export',
      vaultConfig: vault,
      now: NOW,
    });

    expect(exported.status).toBe('ok');
    if (exported.status !== 'ok') return;
    // A copy leaving the system carries who took it. That the client owns the document does not
    // change what the watermark is for, because the copy still leaves.
    expect(exported.value.watermarked).toBe(true);
    expect(exported.value.content.equals(CONTENT)).toBe(false);
    // The claim is that the VIEWER'S IDENTITY IS IN THE DOCUMENT, not that the file got bigger -
    // an assertion on size would pass just as happily if the added bytes said nothing.
    const stamped = pdfText(exported.value.content);
    expect(stamped).toContain('Dana Reyes');
    expect(stamped).toContain(alphaPrincipal.actorId);

    const log = await db().vaultAccessLog.findFirst({
      where: { documentId, action: 'export', granted: true },
      orderBy: { at: 'desc' },
    });
    expect(log?.actorKind).toBe('client');
    expect(log?.actorId).toBe(alphaPrincipal.actorId);
    expect(log?.watermarked).toBe(true);
  });
});

describe('ownership replaces the authority level', () => {
  let alphaDocument: string;

  beforeAll(async () => {
    const uploaded = await uploadDocument({
      principal: alphaPrincipal,
      kind: 'bank_statement',
      filename: 'private.pdf',
      contentType: 'application/pdf',
      content: CONTENT,
      vaultConfig: vault,
    });
    if (uploaded.status !== 'ok') throw new Error('setup');
    alphaDocument = uploaded.value.documentId;
    await recordScanResult(fx.tenant.id, alphaDocument, 'clean', fx.human.id);
  });

  it('refuses another client, and answers as if the document did not exist', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR.
    //
    // `MINIMUM_LEVEL_TO_READ.bank_statement` is 0, and a client holds no level to fail - so a
    // build that reused the staff path would GRANT this. Ownership is the only gate that stops it.
    const asBeta = await downloadDocument({
      principal: betaPrincipal,
      documentId: alphaDocument,
      vaultConfig: vault,
      now: NOW,
    });

    expect(asBeta.status).toBe('no_data');

    // And the same answer as a document that genuinely does not exist - anything else confirms
    // that an id belongs to somebody.
    const missing = await downloadDocument({
      principal: betaPrincipal,
      documentId: '00000000-0000-4000-8000-000000000000',
      vaultConfig: vault,
      now: NOW,
    });
    expect(missing.status).toBe('no_data');
    if (asBeta.status === 'no_data' && missing.status === 'no_data') {
      expect(asBeta.reason).toBe(missing.reason);
    }
  });

  it('logs the refused attempt, because a pattern of them is the signal', async () => {
    const log = await db().vaultAccessLog.findFirst({
      where: { documentId: alphaDocument, granted: false, reason: 'not_owner' },
    });
    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(betaPrincipal.actorId);
    expect(log?.actorKind).toBe('client');

    // On the Ledger too, so it reaches 6.5's risk timeline rather than only a vault table.
    const events = await ledgerRead({ tenantId: fx.tenant.id, type: 'vault.access_refused' });
    expect(events.some((event) => event.payload['reason'] === 'not_owner')).toBe(true);
  });

  it('still lets the owner read it', async () => {
    const asAlpha = await downloadDocument({
      principal: alphaPrincipal,
      documentId: alphaDocument,
      vaultConfig: vault,
      now: NOW,
    });
    expect(asAlpha.status).toBe('ok');
  });
});

describe('legal hold blocks export without saying why', () => {
  let heldDocument: string;

  beforeAll(async () => {
    const uploaded = await uploadDocument({
      principal: alphaPrincipal,
      kind: 'bank_statement',
      filename: 'under-hold.pdf',
      contentType: 'application/pdf',
      content: CONTENT,
      vaultConfig: vault,
    });
    if (uploaded.status !== 'ok') throw new Error('setup');
    heldDocument = uploaded.value.documentId;
    await recordScanResult(fx.tenant.id, heldDocument, 'clean', fx.human.id);
    await setLegalHold(
      fx.tenant.id,
      heldDocument,
      'Preservation notice served 2026-08-09 in the matter of a disputed engagement.',
      fx.human.id,
    );
  });

  it('still lets the client view it', async () => {
    // A hold stops material being destroyed or leaving. Viewing does neither, so the staff rule
    // transfers unchanged.
    const viewed = await downloadDocument({
      principal: alphaPrincipal,
      documentId: heldDocument,
      vaultConfig: vault,
      now: NOW,
    });
    expect(viewed.status).toBe('ok');
  });

  it('refuses the export without disclosing the hold', async () => {
    const exported = await downloadDocument({
      principal: alphaPrincipal,
      documentId: heldDocument,
      action: 'export',
      vaultConfig: vault,
      now: NOW,
    });

    expect(exported.status).toBe('refused');
    if (exported.status !== 'refused') return;

    // THE ASSERTION. A litigation hold is frequently confidential and may concern a dispute with
    // the client asking, so the refusal is truthful and declines to explain.
    expect(exported.reason).not.toMatch(/legal hold/i);
    expect(exported.reason).not.toMatch(/Preservation notice/);
    expect(exported.reason).not.toMatch(/disputed engagement/);
    expect(exported.reason).toMatch(/cannot be downloaded at the moment/);
    // And it offers a route, rather than leaving the client with nothing to do.
    expect(exported.reason).toMatch(/Concierge Desk/);
  });

  it('records the real reason in the access log, where an auditor reads it', async () => {
    const log = await db().vaultAccessLog.findFirst({
      where: { documentId: heldDocument, granted: false, reason: 'legal_hold' },
    });
    expect(log).not.toBeNull();
    expect(log?.actorKind).toBe('client');
  });
});

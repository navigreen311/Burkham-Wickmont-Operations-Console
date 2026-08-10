/**
 * Integration: 3.2 Secure Document Vault access control, scan gating, watermarking, legal hold.
 *
 * The gates are tested by trying to get past them. Specification §10.5 makes "zero cross-tenant
 * data leaks" a success criterion, and a criterion is only meaningful if something attempts the
 * leak.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { buildCapitalCommandBrief, pdfRenderer } from '@bwc/deliverables';
import { read as readLedger } from '@bwc/ledger';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  MINIMUM_LEVEL_TO_READ,
  accessLog,
  forClient,
  generateKek,
  read,
  recordScanResult,
  releaseLegalHold,
  remove,
  setLegalHold,
  setRetention,
  store,
  type VaultConfig,
} from '@bwc/vault';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;
let root: string;
let config: VaultConfig;
let clientId: string;

const CONTENT = Buffer.from('Synthetic bank statement content for testing only.', 'utf8');

/**
 * A real PDF, so the watermark test stamps something rather than asserting on a stub.
 *
 * Built through the deliverables renderer rather than pdfkit directly: it is a real production
 * path, and pdfkit is that package's dependency rather than the vault's.
 */
const makePdf = async (): Promise<Buffer> =>
  pdfRenderer.render(
    buildCapitalCommandBrief({
      clientLegalName: 'Vault Client Co',
      preparedOn: '2026-08-10',
      complianceState: 'pass',
      narrative: 'Synthetic statement page for testing.',
      positionFigures: [],
    }),
  );

/**
 * Extract readable text from a PDF by inflating its content streams.
 *
 * PDF content streams are Flate-compressed, so the watermark text is genuinely present but not
 * as plaintext bytes. Searching the raw file would fail and tempt a weaker assertion - "the
 * export got bigger" - which would pass just as happily if the added bytes said nothing. The
 * claim under test is that the *viewer's identity is in the document*, so the test decompresses
 * and looks.
 */
const pdfText = (pdf: Buffer): string => {
  const raw = pdf.toString('latin1');
  const parts: string[] = [raw];

  const decodeHexStrings = (content: string): void => {
    // pdf-lib writes drawn text as a hex string operand: <48656C6C6F> Tj
    const hexToken = /<([0-9A-Fa-f]+)>/g;
    let token: RegExpExecArray | null;
    while ((token = hexToken.exec(content)) !== null) {
      const hex = token[1];
      if (hex === undefined || hex.length % 2 !== 0) continue;
      parts.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  };

  let cursor = 0;
  for (;;) {
    const streamAt = raw.indexOf('stream', cursor);
    if (streamAt === -1) break;

    const end = raw.indexOf('endstream', streamAt);
    if (end === -1) break;

    // Skip past 'stream' and whatever end-of-line follows it.
    let start = streamAt + 'stream'.length;
    while (start < end && (raw.charCodeAt(start) === 13 || raw.charCodeAt(start) === 10)) {
      start += 1;
    }

    try {
      const inflated = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
      parts.push(inflated);
      decodeHexStrings(inflated);
    } catch {
      // Not a Flate stream. The raw copy above already covers uncompressed content.
    }

    cursor = end + 'endstream'.length;
  }

  decodeHexStrings(raw);
  return parts.join(String.fromCharCode(10));
};

beforeAll(async () => {
  fx = await makeFixture('vault');
  root = await mkdtemp(join(tmpdir(), 'bwc-vault-access-'));
  process.env['VAULT_ACCESS_KEK'] = generateKek();
  config = {
    store: new LocalEncryptedStore(root),
    kek: new EnvKekProvider('VAULT_ACCESS_KEK'),
  };
  clientId = (
    await createClient(fx.tenant.id, 'Vault Client Co', { id: fx.human.id, kind: 'human' })
  ).id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupTenant(fx.tenant.id);
});

/** Store a document and mark it scanned clean, which is the normal readable state. */
const storeClean = async (
  kind: Parameters<typeof store>[1]['kind'] = 'bank_statement',
  content = CONTENT,
) => {
  const stored = await store(config, {
    tenantId: fx.tenant.id,
    clientId,
    kind,
    filename: 'statement.pdf',
    contentType: 'application/pdf',
    content,
    actorId: fx.human.id,
  });
  if (stored.status !== 'ok') throw new Error(`store failed: ${JSON.stringify(stored)}`);
  await recordScanResult(fx.tenant.id, stored.value.id, 'clean', fx.human.id);
  return stored.value;
};

describe('storing and reading', () => {
  it('stores, scans, and reads back the exact bytes', async () => {
    const doc = await storeClean();

    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.content.equals(CONTENT)).toBe(true);
  });

  it('writes a ledger event on store, identifying by digest rather than filename', async () => {
    const doc = await storeClean();
    const events = await readLedger({ tenantId: fx.tenant.id, type: 'vault.document_stored' });
    const mine = events.find((event) => event.payload['documentId'] === doc.id);

    expect(mine).toBeDefined();
    expect(mine?.payload['sha256']).toBe(doc.sha256);
    // The filename is client-supplied and may name a person; the ledger is retained indefinitely.
    expect(JSON.stringify(mine?.payload)).not.toContain('statement.pdf');
  });

  it('logs every successful read', async () => {
    const doc = await storeClean();
    await read(config, { tenantId: fx.tenant.id, documentId: doc.id, actorId: fx.human.id });

    const log = await accessLog(fx.tenant.id, doc.id);
    const granted = log.filter((entry) => entry.granted && entry.action === 'view');
    expect(granted.length).toBeGreaterThan(0);
    expect(granted[0]?.actorId).toBe(fx.human.id);
  });
});

describe('the virus-scan gate', () => {
  it('refuses to read an unscanned document', async () => {
    const stored = await store(config, {
      tenantId: fx.tenant.id,
      clientId,
      kind: 'bank_statement',
      filename: 'unscanned.pdf',
      contentType: 'application/pdf',
      content: CONTENT,
      actorId: fx.human.id,
    });
    if (stored.status !== 'ok') return;

    // `pending` is the honest default: no scanner is wired, and defaulting to clean would
    // assert a check that never ran.
    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: stored.value.id,
      actorId: fx.human.id,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/not been confirmed clean/i);
  });

  it('refuses to read an infected document', async () => {
    const stored = await store(config, {
      tenantId: fx.tenant.id,
      clientId,
      kind: 'bank_statement',
      filename: 'bad.pdf',
      contentType: 'application/pdf',
      content: CONTENT,
      actorId: fx.human.id,
    });
    if (stored.status !== 'ok') return;
    await recordScanResult(fx.tenant.id, stored.value.id, 'infected', fx.human.id, 'EICAR');

    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: stored.value.id,
      actorId: fx.human.id,
    });
    expect(result.status).toBe('refused');
  });

  it('treats scan_unavailable as not-clean rather than as clean', async () => {
    const stored = await store(config, {
      tenantId: fx.tenant.id,
      clientId,
      kind: 'bank_statement',
      filename: 'unknown.pdf',
      contentType: 'application/pdf',
      content: CONTENT,
      actorId: fx.human.id,
    });
    if (stored.status !== 'ok') return;
    await recordScanResult(fx.tenant.id, stored.value.id, 'scan_unavailable', fx.human.id);

    // "We could not check" must never read as "we checked and it was fine".
    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: stored.value.id,
      actorId: fx.human.id,
    });
    expect(result.status).toBe('refused');
  });
});

describe('access control', () => {
  it('refuses a below-level actor and logs the refusal', async () => {
    // A government ID requires level 3; the observer holds 0.
    const doc = await storeClean('government_id');

    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.observer.id,
    });

    expect(result.status).toBe('refused');

    const log = await accessLog(fx.tenant.id, doc.id);
    const denied = log.find((entry) => !entry.granted && entry.reason === 'below_level');
    expect(denied).toBeDefined();
    expect(denied?.actorId).toBe(fx.observer.id);
  });

  it('permits a sufficiently privileged actor to read the same document', async () => {
    const doc = await storeClean('government_id');
    // The human fixture holds level 3.
    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
    });
    expect(result.status).toBe('ok');
  });

  it('ranks the least-recoverable disclosures highest', () => {
    // Least privilege by document class: the documents whose disclosure is least recoverable and
    // least often needed for analytical work sit above the rest.
    expect(MINIMUM_LEVEL_TO_READ.government_id).toBeGreaterThan(
      MINIMUM_LEVEL_TO_READ.bank_statement,
    );
    expect(MINIMUM_LEVEL_TO_READ.tax_return).toBeGreaterThan(MINIMUM_LEVEL_TO_READ.balance_sheet);
    expect(MINIMUM_LEVEL_TO_READ.credit_report).toBeGreaterThan(
      MINIMUM_LEVEL_TO_READ.profit_and_loss,
    );
  });

  it("refuses another tenant's actor and logs the attempt", async () => {
    const other = await makeFixture('vault-other');
    try {
      const doc = await storeClean();

      const result = await read(config, {
        tenantId: other.tenant.id,
        documentId: doc.id,
        actorId: other.human.id,
      });

      expect(result.status).toBe('refused');
      if (result.status === 'refused') expect(result.principle).toMatch(/isolation/i);

      // A pattern of denied cross-tenant attempts is exactly the signal an audit wants, and it
      // exists only if refusals are recorded as carefully as successes.
      const log = await accessLog(fx.tenant.id, doc.id);
      expect(log.some((entry) => !entry.granted && entry.reason === 'cross_tenant')).toBe(true);

      const refusals = await readLedger({ tenantId: fx.tenant.id, type: 'vault.access_refused' });
      expect(refusals.length).toBeGreaterThan(0);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });

  it('refuses an unknown actor', async () => {
    const doc = await storeClean();
    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.status).toBe('refused');
  });
});

describe('watermarking on export', () => {
  it('stamps a PDF with the viewer identity and timestamp', async () => {
    const pdf = await makePdf();
    const doc = await storeClean('bank_statement', pdf);

    const at = new Date('2026-08-10T12:00:00Z');
    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      action: 'export',
      now: at,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.watermarked).toBe(true);
    // Larger than the original: bytes were added, not merely claimed to be.
    expect(result.value.content.length).toBeGreaterThan(pdf.length);

    const text = pdfText(result.value.content);
    expect(text).toContain(fx.human.id);
    expect(text).toContain('2026-08-10');

    const log = await accessLog(fx.tenant.id, doc.id);
    expect(log.some((entry) => entry.action === 'export' && entry.watermarked)).toBe(true);
  });

  it('reports watermarked:false for content that cannot carry a stamp', async () => {
    // Plaid-sourced JSON is stored here too (Decision A) and cannot be visually watermarked.
    const doc = await storeClean('bank_statement', Buffer.from('{"transactions":[]}', 'utf8'));

    const result = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      action: 'export',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Recorded as false rather than implied true - "was this export watermarked?" has a truthful
    // answer for every export.
    expect(result.value.watermarked).toBe(false);

    const log = await accessLog(fx.tenant.id, doc.id);
    expect(log.some((entry) => entry.action === 'export' && !entry.watermarked)).toBe(true);
  });
});

describe('legal hold', () => {
  it('blocks export but still permits viewing', async () => {
    const doc = await storeClean();
    const held = await setLegalHold(fx.tenant.id, doc.id, 'Regulator request 2026-08', fx.human.id);
    expect(held.status).toBe('ok');

    const exported = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      action: 'export',
    });
    expect(exported.status).toBe('refused');
    if (exported.status === 'refused') expect(exported.reason).toMatch(/legal hold/i);

    // Viewing during litigation is normal; taking a copy out of the system is what a hold
    // exists to prevent.
    const viewed = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      action: 'view',
    });
    expect(viewed.status).toBe('ok');
  });

  it('blocks deletion, and the document survives', async () => {
    const doc = await storeClean();
    await setRetention(fx.tenant.id, doc.id, new Date('2020-01-01'));
    await setLegalHold(fx.tenant.id, doc.id, 'Litigation hold', fx.human.id);

    const removed = await remove(fx.tenant.id, doc.id, fx.human.id);
    expect(removed.status).toBe('refused');

    expect((await forClient(fx.tenant.id, clientId)).some((d) => d.id === doc.id)).toBe(true);
  });

  it('refuses an agent placing or releasing a hold', async () => {
    const doc = await storeClean();
    expect((await setLegalHold(fx.tenant.id, doc.id, 'agent says so', fx.agent.id)).status).toBe(
      'refused',
    );
    expect((await releaseLegalHold(fx.tenant.id, doc.id, fx.agent.id)).status).toBe('refused');
  });

  it('requires a stated reason', async () => {
    const doc = await storeClean();
    expect((await setLegalHold(fx.tenant.id, doc.id, '   ', fx.human.id)).status).toBe('refused');
  });

  it('permits export once released', async () => {
    const doc = await storeClean(); // JSON-free plain content is fine here
    await setLegalHold(fx.tenant.id, doc.id, 'temporary', fx.human.id);
    await releaseLegalHold(fx.tenant.id, doc.id, fx.human.id);

    const exported = await read(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      action: 'export',
    });
    expect(exported.status).toBe('ok');
  });
});

describe('retention', () => {
  it('refuses deletion when no schedule has been resolved, reporting the missing module', async () => {
    const doc = await storeClean();

    const removed = await remove(fx.tenant.id, doc.id, fx.human.id);

    // Over-retention is a liability; destroying a document a regulator was entitled to see is
    // irreversible. With no rules available, the safe default is to keep - and to say why.
    expect(removed.status).toBe('not_built');
    if (removed.status === 'not_built') {
      expect(removed.module).toMatch(/Regulatory Engine|Record Retention/i);
    }
  });

  it('refuses deletion before the retention date', async () => {
    const doc = await storeClean();
    await setRetention(fx.tenant.id, doc.id, new Date('2030-01-01'));

    const removed = await remove(fx.tenant.id, doc.id, fx.human.id, new Date('2026-08-10'));
    expect(removed.status).toBe('refused');
  });

  it('permits deletion once retention has elapsed and no hold applies', async () => {
    const doc = await storeClean();
    await setRetention(fx.tenant.id, doc.id, new Date('2020-01-01'));

    const removed = await remove(fx.tenant.id, doc.id, fx.human.id, new Date('2026-08-10'));
    expect(removed.status).toBe('ok');

    // Soft-deleted: gone from listings and unreadable, with the ledger record intact.
    expect((await forClient(fx.tenant.id, clientId)).some((d) => d.id === doc.id)).toBe(false);
    expect(
      (await read(config, { tenantId: fx.tenant.id, documentId: doc.id, actorId: fx.human.id }))
        .status,
    ).toBe('no_data');
  });
});

describe('an actor cannot store into another tenant', () => {
  it('refuses', async () => {
    const other = await makeFixture('vault-store-other');
    try {
      const result = await store(config, {
        tenantId: other.tenant.id,
        clientId,
        kind: 'bank_statement',
        filename: 'x.pdf',
        contentType: 'application/pdf',
        content: CONTENT,
        actorId: fx.human.id,
      });
      expect(result.status).toBe('refused');
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });
});

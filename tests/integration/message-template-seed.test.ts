/**
 * The ordinary sends - 4.1 templates, seeded, and the ordering constraint that makes them sendable.
 *
 * A template is a message that will be sent many times. A banned phrase in one is a banned phrase in
 * every send it produces, and the cheapest moment to catch it is before it is stored - so
 * `seedMessageTemplates` scans every body against 7.4 and publishes nothing unless all of them
 * pass.
 *
 * **Which means seeding templates into a tenant with no claim library refuses.** That is asserted
 * first in this file, because it is also the proof that this slice did not make the empty case
 * pass. Filling the library was the point; weakening the refusal that made the empty library
 * visible would have been the easy version of the same task and the wrong one.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { seedFoundingClaims, publish } from '@bwc/claims';
import {
  SEED_TEMPLATES,
  currentTemplate,
  render,
  seedMessageTemplates,
  unresolvedPlaceholders,
} from '@bwc/comms';
import { scanForTenant } from '@bwc/scanner';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

const human = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('template-seed');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('a template is not sendable until there is something to check it against', () => {
  it('refuses to seed templates for a tenant with an empty claim library, and publishes none', async () => {
    const empty = await makeFixture('template-seed-empty');
    try {
      const result = await seedMessageTemplates(empty.tenant.id, 'concierge_desk', {
        id: empty.human.id,
        kind: 'human',
      });

      // The scanner's own refusal, propagated rather than swallowed.
      expect(result.status).toBe('refused');
      if (result.status === 'refused') expect(result.reason).toMatch(/empty/i);

      // And nothing was written. A half-seeded template set is discovered by a client not
      // receiving a message.
      for (const template of SEED_TEMPLATES) {
        expect((await currentTemplate(empty.tenant.id, template.key)).status).toBe('no_data');
      }
    } finally {
      await cleanupTenant(empty.tenant.id);
    }
  });

  it('publishes every template once the library exists', async () => {
    await seedFoundingClaims(fx.tenant.id, 'compliance_review_board', human());

    const result = await seedMessageTemplates(fx.tenant.id, 'concierge_desk', human());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.published.length).toBe(SEED_TEMPLATES.length);
    // A pass that says how much it checked, the same distinction the scanner draws.
    expect(result.value.libraryEntriesChecked).toBeGreaterThan(90);
  });
});

describe('every seeded template scans clean against the library this slice wrote', () => {
  it.each(SEED_TEMPLATES.map((template) => [template.key, template] as const))(
    '%s is not blocked and carries every disclosure it obliges',
    async (_key, template) => {
      const text = `${template.subject ?? ''}\n${template.body}`;

      const scan = await scanForTenant({
        tenantId: fx.tenant.id,
        text,
        actor: human(),
        context: 'template seed test',
      });

      expect(scan.status).toBe('ok');
      if (scan.status !== 'ok') return;

      expect(scan.value.verdict).not.toBe('blocked');

      // The stricter rule 8.1 and 4.5 both apply: the disclosure has to be IN the body. "Somebody
      // will attach it" is a hope rather than a control, and for a template there is no later step
      // that could.
      const missing = scan.value.requiredDisclosures.filter(
        (disclosure) => !text.includes(disclosure),
      );
      expect(missing).toEqual([]);
    },
  );

  it('demonstrates the rule with the one template that uses disclosure-gated language', async () => {
    const offer = SEED_TEMPLATES.find((template) => template.key === 'offer-received');
    expect(offer).toBeDefined();
    if (!offer) return;

    const scan = await scanForTenant({
      tenantId: fx.tenant.id,
      text: `${offer.subject ?? ''}\n${offer.body}`,
      actor: human(),
      context: 'template seed test',
    });
    if (scan.status !== 'ok') throw new Error('scan refused');

    // It really does use the phrase - this is not a template that passes by saying nothing.
    expect(scan.value.verdict).toBe('requires_disclosure');
    expect(scan.value.findings.map((finding) => finding.phrase)).toContain('up to');
    expect(scan.value.requiredDisclosures.length).toBeGreaterThan(0);

    // And the disclosure is in the body, character for character. It is imported rather than
    // retyped precisely because this check is exact string inclusion.
    for (const disclosure of scan.value.requiredDisclosures) {
      expect(offer.body).toContain(disclosure);
    }
  });
});

describe('a template that would fail the scanner is not published, and neither are the others', () => {
  it('refuses the whole batch and names the offending template', async () => {
    // Rather than mutating the seed, this bans a phrase the templates genuinely contain. The code
    // path exercised is the real one: scan first, publish nothing on a finding.
    const hostile = await makeFixture('template-seed-hostile');
    try {
      await seedFoundingClaims(hostile.tenant.id, 'compliance_review_board', {
        id: hostile.human.id,
        kind: 'human',
      });
      await publish({
        tenantId: hostile.tenant.id,
        phrase: 'what happens next',
        disposition: 'banned',
        rationale:
          'Banned in this tenant only, to prove the template seed refuses rather than publishing around a finding.',
        approvedBy: 'crb',
        actor: { id: hostile.human.id, kind: 'human' },
      });

      const result = await seedMessageTemplates(hostile.tenant.id, 'concierge_desk', {
        id: hostile.human.id,
        kind: 'human',
      });

      expect(result.status).toBe('refused');
      if (result.status === 'refused') {
        expect(result.reason).toContain('client-onboarding-welcome');
        expect(result.reason).toContain('what happens next');
      }

      // Not one template was published - including the eight that had nothing wrong with them.
      for (const template of SEED_TEMPLATES) {
        expect((await currentTemplate(hostile.tenant.id, template.key)).status).toBe('no_data');
      }
    } finally {
      await cleanupTenant(hostile.tenant.id);
    }
  });
});

describe('the templates are the ordinary sends, and they are usable', () => {
  it('covers the moments a file actually generates', async () => {
    const keys = SEED_TEMPLATES.map((template) => template.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'client-onboarding-welcome',
        'document-request',
        'application-authorization-request',
        'application-submitted',
        'offer-received',
        'provider-declined',
        'post-funding-checkin',
      ]),
    );
  });

  it('gives every email a subject and every SMS a way out of the channel', () => {
    for (const template of SEED_TEMPLATES) {
      expect(template.purpose.trim().length).toBeGreaterThan(20);
      if (template.channel === 'email') {
        expect((template.subject ?? '').trim()).not.toBe('');
      } else {
        // 4.4's preference record is a gate, not a courtesy. A client who cannot find the way out
        // of a channel has not meaningfully chosen it.
        expect(template.body).toContain('Reply STOP');
      }
    }
    // Voice is deliberately absent: 4.1 routes it through VoiceForge and 4.3 reads transcripts of
    // calls that already happened. A voice template here would be a script nothing reads.
    expect(SEED_TEMPLATES.some((template) => template.channel === 'voice')).toBe(false);
  });

  it('renders with variables, and leaves an unfilled one visible rather than blank', async () => {
    const stored = await currentTemplate(fx.tenant.id, 'provider-declined');
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok') return;

    const rendered = render(stored.value, {
      firstName: 'Dana',
      clientLegalName: 'Acme Operating LLC',
      providerName: 'Navy Federal',
      applicationReference: 'APP-1001',
      declineReason: 'time in business',
      advisorName: 'R. Vance',
    });

    expect(rendered.body).toContain('Dana');
    expect(rendered.body).toContain('Navy Federal');
    expect(unresolvedPlaceholders(rendered.body)).toEqual([]);

    // And a caller that forgets one can tell. "Hello ," looks like a formatting slip and gets sent.
    const partial = render(stored.value, { firstName: 'Dana' });
    expect(unresolvedPlaceholders(partial.body).length).toBeGreaterThan(0);
  });

  it('leaves an existing template alone when seeded again', async () => {
    const before = await currentTemplate(fx.tenant.id, 'document-request');
    if (before.status !== 'ok') throw new Error('expected a published template');

    const again = await seedMessageTemplates(fx.tenant.id, 'concierge_desk', human());
    if (again.status !== 'ok') throw new Error('expected the re-run to succeed');

    // THE ASSERTION THIS TEST EXISTS FOR, and it replaces one that asserted the opposite.
    //
    // Re-running a seed is the ordinary case - a half-finished first run, a new template added to
    // the list, an operator unsure whether it took. Publishing unconditionally walked every key to
    // version 2 with an identical body, and would have superseded an owner's edit with the seeded
    // draft. Nine templates are named, and on a second run nine are skipped and none published.
    expect(again.value.skipped).toContain('document-request');
    expect(again.value.published).toEqual([]);

    const after = await currentTemplate(fx.tenant.id, 'document-request');
    if (after.status !== 'ok') throw new Error('expected a published template');
    expect(after.value.version).toBe(before.value.version);
  });

  it('supersedes rather than edits when a republish is what was meant', async () => {
    const before = await currentTemplate(fx.tenant.id, 'application-submitted');
    if (before.status !== 'ok') throw new Error('expected a published template');

    const again = await seedMessageTemplates(
      fx.tenant.id,
      'concierge_desk',
      human(),
      undefined,
      true,
    );
    if (again.status !== 'ok') throw new Error('expected the republish to succeed');

    const after = await currentTemplate(fx.tenant.id, 'application-submitted');
    if (after.status !== 'ok') throw new Error('expected a published template');

    // Asked for explicitly, the versioning rule still holds: a message sent in March has to stay
    // explicable, so the old version is superseded and kept rather than overwritten.
    expect(after.value.version).toBe(before.value.version + 1);
    expect(after.value.body).toBe(before.value.body);
  });

  it('says nothing a client would have to be talked out of later', async () => {
    // The templates promise process, never outcome. This is the sentence-level version of the
    // whole library: no send commits the firm to a decision a provider makes.
    for (const template of SEED_TEMPLATES) {
      const body = template.body.toLowerCase();
      for (const forbidden of [
        'guarantee',
        'approved for you today',
        'no risk',
        'pre-approved',
        'fastest',
      ]) {
        expect(body).not.toContain(forbidden);
      }
    }
  });
});

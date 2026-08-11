/**
 * Message templates - blueprint 4.1's "email / SMS templates".
 *
 * Versioned and superseded rather than edited, for the reason that recurs across this codebase: a
 * message sent in March has to remain explicable when somebody asks what the client was told. The
 * communication log stores the rendered body, so a template edit cannot rewrite history - but the
 * template a message came from should still be readable at the version that produced it.
 *
 * Deliberately thin. Blueprint 4.1 also lists onboarding sequences, document-chase workflows and
 * check-in cadence; all three are SEQUENCING, and 2.2 already owns playbooks, scheduling, wait
 * states and escalation. A second scheduler here would drift from it and give the operator two
 * places to look.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import type { Channel } from './windows.js';

export interface TemplateRecord {
  readonly key: string;
  readonly version: number;
  readonly channel: Channel;
  readonly subject: string | null;
  readonly body: string;
}

interface TemplateRow {
  key: string;
  version: number;
  channel: string;
  subject: string | null;
  body: string;
}

const toTemplate = (row: TemplateRow): TemplateRecord => ({
  key: row.key,
  version: row.version,
  channel: row.channel as Channel,
  subject: row.subject,
  body: row.body,
});

export const publishTemplate = async (input: {
  tenantId: string;
  key: string;
  channel: Channel;
  subject?: string;
  body: string;
  publishedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<TemplateRecord>> => {
  if (input.body.trim() === '') {
    return refused(
      `Template '${input.key}' was published with no body.`,
      'Blueprint 4.1 - a template with no content cannot be sent or reviewed',
    );
  }
  if (input.channel === 'email' && (input.subject ?? '').trim() === '') {
    return refused(
      `Email template '${input.key}' needs a subject. An email with none arrives looking like something a client should delete.`,
      'Blueprint 4.1 - email / SMS templates',
    );
  }

  const now = input.now ?? new Date();
  const current = await db().messageTemplate.findFirst({
    where: { tenantId: input.tenantId, key: input.key, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });

  const row = await db().$transaction(async (tx) => {
    if (current) {
      await tx.messageTemplate.update({ where: { id: current.id }, data: { supersededAt: now } });
    }
    return tx.messageTemplate.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        version: (current?.version ?? 0) + 1,
        channel: input.channel as never,
        subject: input.subject ?? null,
        body: input.body,
        createdBy: input.publishedBy,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'comms.template.published',
    actor: input.actor,
    payload: { templateKey: input.key, version: row.version, channel: input.channel },
  });

  return ok(toTemplate(row));
};

export const currentTemplate = async (
  tenantId: string,
  key: string,
): Promise<Outcome<TemplateRecord>> => {
  const row = await db().messageTemplate.findFirst({
    where: { tenantId, key, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });
  return row ? ok(toTemplate(row)) : noData(`No message template published under '${key}'.`);
};

/**
 * Render a template.
 *
 * Unresolved placeholders are left visible rather than blanked - the same choice 7.3 makes for a
 * contract, and for the same reason: "Hello {{firstName}}," is obviously broken and gets caught,
 * while "Hello ," looks like a formatting slip and gets sent.
 */
export const render = (
  template: TemplateRecord,
  variables: Readonly<Record<string, string>>,
): { subject: string | null; body: string } => {
  const substitute = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => variables[name] ?? match);

  return {
    subject: template.subject === null ? null : substitute(template.subject),
    body: substitute(template.body),
  };
};

/** Placeholders a rendered message still carries, so a caller can refuse to send it. */
export const unresolvedPlaceholders = (text: string): readonly string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) found.add(match[1] as string);
  return [...found].sort();
};

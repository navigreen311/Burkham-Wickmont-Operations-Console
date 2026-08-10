/**
 * Playbook definition lookup.
 *
 * Extracted so the engine and the listener share one implementation rather than each resolving
 * a definition its own way. A tool that reimplements the rule it checks drifts from that rule
 * and keeps answering - and here the rule is "which graph is this instance actually running",
 * which must be the pinned version and not the latest.
 */

import { db } from '@bwc/db';
import type { PlaybookDefinition } from './playbook.js';

export const definitionFor = async (
  key: string,
  version: number,
): Promise<PlaybookDefinition | null> => {
  const row = await db().playbook.findUnique({ where: { key_version: { key, version } } });
  return row ? (row.definition as unknown as PlaybookDefinition) : null;
};

/** The latest published version, used only when starting a new instance. */
export const latestActive = async (
  key: string,
): Promise<{ version: number; definition: PlaybookDefinition } | null> => {
  const row = await db().playbook.findFirst({
    where: { key, status: 'active' },
    orderBy: { version: 'desc' },
  });
  return row
    ? { version: row.version, definition: row.definition as unknown as PlaybookDefinition }
    : null;
};

/**
 * The graph an instance is running - its pinned version, never the latest. Publishing a new
 * version must not change the rules under a client already midway through an engagement.
 */
export const definitionForInstance = async (instance: {
  playbookKey: string;
  playbookVersion: number;
}): Promise<PlaybookDefinition | null> =>
  definitionFor(instance.playbookKey, instance.playbookVersion);

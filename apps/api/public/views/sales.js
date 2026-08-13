/**
 * 1.3 Sales Motion & Engagement Tracking on the page.
 *
 * A pipeline nobody can move from here, and the panel says so rather than leaving an operator
 * hunting for the button. Every write in 1.3 emits a Ledger event and so needs a declared action;
 * none is declared. `writes.blocked` carries the reason and this file renders it.
 *
 * **The conversion rate refuses below its minimum, and the refusal is rendered as a sentence.**
 * `conversionByChannel` returns `rate: null` under ten decided leads with a note saying how many
 * more are needed. Rendering that as `0%` would be the same failure the dashboards panel guards
 * against, arriving through a different module: a channel that converted two of three would read as
 * a channel that converts nobody.
 *
 * Every value reaches the DOM through `textContent`.
 */

import { renderAvailable, renderWrites } from './writes.js';
const call = async (path) => {
  const response = await fetch(path, { credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));
  return payload.status === 'ok'
    ? { ok: true, data: payload.data }
    : { ok: false, reason: payload.reason ?? 'Something went wrong.', status: payload.status };
};

const $ = (id) => document.getElementById(id);

const line = (parent, text) => {
  const li = document.createElement('li');
  li.textContent = text;
  parent.append(li);
};

const render = (data) => {
  const stages = $('sales-pipeline');
  stages.replaceChildren();
  if (data.leads.length === 0) {
    line(stages, 'No lead is on the pipeline.');
  } else {
    for (const lead of data.leads) {
      line(
        stages,
        `${lead.prospectName} — ${lead.stage}, source ${lead.sourceChannel}${
          lead.referrerName ? ` via ${lead.referrerName}` : ''
        }`,
      );
    }
  }

  const stale = $('sales-stale');
  stale.replaceChildren();
  if (data.stale.length === 0) {
    line(stale, `Nothing has been idle longer than ${data.inactivityDays} days.`);
  } else {
    for (const entry of data.stale) line(stale, entry.summary);
  }

  /**
   * Per-channel conversion, with the module's refusal intact.
   *
   * `rate === null` renders as the sentence that says how many more decided leads would make it a
   * rate. The counts are shown either way, because they are real.
   */
  const channels = $('sales-channels');
  channels.replaceChildren();
  if (data.conversionByChannel.length === 0) {
    line(channels, 'No channel has a lead on record.');
  } else {
    for (const channel of data.conversionByChannel) {
      const decided = channel.converted + channel.lost;
      line(
        channels,
        channel.conversionRate === null
          ? // The module's own sentence, which says how many more decided leads would make it a
            // rate. Rendering `0%` here would make a channel that converted every lead it decided
            // read as a channel that converts nobody.
            `${channel.sourceChannel}: ${channel.converted} converted of ${decided} decided — rate withheld. ${channel.note}`
          : `${channel.sourceChannel}: ${(channel.conversionRate * 100).toFixed(1)}% (${channel.converted} of ${decided} decided).`,
      );
    }
  }

  const losses = $('sales-losses');
  losses.replaceChildren();
  if (data.lossReasons.length === 0) {
    line(losses, 'No lead has been closed lost.');
  } else {
    for (const entry of data.lossReasons) line(losses, `${entry.reason}: ${entry.count}`);
  }

  renderAvailable('sales-available', data.writes?.available);
  const blocked = $('sales-blocked');
  blocked.replaceChildren();
  for (const entry of data.writes?.blocked ?? []) {
    const item = document.createElement('li');
    const what = document.createElement('strong');
    what.textContent = entry.capability;
    item.append(what);
    const why = document.createElement('div');
    why.textContent = entry.why;
    item.append(why);
    blocked.append(item);
  }
};

const renderExpansion = (data) => {
  const signals = $('sales-expansion');
  signals.replaceChildren();
  if (data.signals.length === 0) {
    line(signals, 'No expansion trigger has fired.');
  } else {
    for (const signal of data.signals) {
      line(signals, `${signal.prospectName ?? signal.leadId} — ${signal.reason ?? signal.trigger}`);
    }
  }

  const renewals = $('sales-renewals');
  renewals.replaceChildren();
  if (data.renewals.length === 0) {
    line(renewals, 'No engagement is inside a renewal window.');
  } else {
    for (const renewal of data.renewals) {
      line(
        renewals,
        `${renewal.engagementId} — ${renewal.state}${renewal.detail ? ` (${renewal.detail})` : ''}`,
      );
    }
  }
};

let loaded = false;

const load = async () => {
  const status = $('sales-status');
  status.textContent = 'Loading…';

  const [pipeline, expansion] = await Promise.all([
    call('/api/console/sales/pipeline'),
    call('/api/console/sales/expansion'),
  ]);

  if (!pipeline.ok) {
    status.textContent = pipeline.reason;
    return;
  }

  render(pipeline.data);
  if (expansion.ok) renderExpansion(expansion.data);

  status.textContent = `${pipeline.data.leads.length} lead(s), ${pipeline.data.stale.length} idle beyond ${pipeline.data.inactivityDays} days.`;
  loaded = true;
};

$('panel-sales').addEventListener('toggle', () => {
  if ($('panel-sales').open && !loaded) void load();
});

$('sales-refresh').addEventListener('click', () => {
  loaded = false;
  void load();
});

/**
 * The lead lifecycle, and conversion apart from it.
 *
 * Conversion is marked as the heavier act because it is one: a client is created and an engagement
 * may start. Grouping it with "close this lead" on the page would have made the level look
 * arbitrary, when it is the most defensible one in the batch.
 */
renderWrites('sales-writes', [
  {
    id: 'sales-create',
    capability: 'Create a lead',
    action: 'manage_lead',
    note: 'A prospect, not a client. No client record exists yet.',
    buttonLabel: 'Create the lead',
    done: 'Lead created.',
    fields: [
      { name: 'prospectName', label: 'Prospect name' },
      { name: 'sourceChannel', label: 'Source channel', placeholder: 'referral' },
    ],
    path: () => '/api/console/sales/leads',
    body: (v) => v,
  },
  {
    id: 'sales-qualify',
    capability: 'Qualify a lead',
    action: 'manage_lead',
    note: 'A note is required. Unexplained, a qualification is a filter nobody can improve and a decision the salesperson who disagrees cannot appeal.',
    buttonLabel: 'Record the qualification',
    done: 'Qualification recorded.',
    fields: [
      { name: 'leadId', label: 'Lead id' },
      { name: 'qualification', label: 'Qualification', placeholder: 'qualified' },
      { name: 'note', label: 'Note' },
      { name: 'occurredAt', label: 'Occurred at', type: 'date' },
    ],
    path: (v) => `/api/console/sales/leads/${encodeURIComponent(v.leadId)}/qualification`,
    body: (v) => ({ qualification: v.qualification, note: v.note, occurredAt: v.occurredAt }),
  },
  {
    id: 'sales-convert',
    capability: 'Convert a lead',
    action: 'convert_lead',
    note: 'LEVEL 3, unlike the rest of the lifecycle. Converting creates a client and may start an engagement, so a lower level here would be a way round the gate on both. All-or-nothing: a half-done conversion leaves an orphan client nobody can see.',
    danger: true,
    buttonLabel: 'Convert',
    done: 'Converted. The client starts in pending_assessment.',
    fields: [
      { name: 'leadId', label: 'Lead id' },
      { name: 'offerKey', label: 'Offer key (blank for no engagement)' },
      { name: 'convertedOn', label: 'Converted on', type: 'date' },
    ],
    path: (v) => `/api/console/sales/leads/${encodeURIComponent(v.leadId)}/conversion`,
    body: (v) => ({
      ...(v.offerKey ? { offerKey: v.offerKey } : {}),
      convertedOn: v.convertedOn,
    }),
  },
]);

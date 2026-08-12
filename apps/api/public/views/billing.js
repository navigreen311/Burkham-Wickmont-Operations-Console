/**
 * 1.4 Pricing, Billing & Offers on the page.
 *
 * **The published ladder sits beside the engagement, always.** A deviation from the published price
 * is only visible when both are on the screen, and ADR-0018 needs Gardner approval for one in
 * either direction - a discount moves profit out of this firm, a premium moves it in, and a page
 * that showed only the charged figure would make the second invisible.
 *
 * **Cents are rendered, never summed.** Every figure arrives as an integer number of cents and is
 * divided by 100 exactly once, for display. ADR-0011 exists because the alternative rounds the
 * wrong way at the half-cent and produces refunds nobody can pay; a page that added two of these
 * together would reintroduce all of it one layer up.
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

/**
 * Render the writes a surface cannot offer, with the reason.
 *
 * **Shown, not omitted.** A panel with no buttons is indistinguishable from one whose buttons were
 * forgotten, and the reason is the part an operator needs: "no declared action" is a decision
 * somebody can take, and "refused by design" is one they should not try to.
 */
const blocked = (parent, writes) => {
  parent.replaceChildren();
  for (const entry of writes?.blocked ?? []) {
    line(parent, `${entry.capability} - ${entry.missingAction} - ${entry.why}`);
  }
};


/** Cents to a readable amount. Display only - nothing here is added to anything. */
const money = (cents) =>
  typeof cents === 'number'
    ? `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'not recorded';

const loadLadder = async () => {
  const status = $('billing-ladder-status');
  const list = $('billing-ladder-list');
  list.replaceChildren();

  const result = await call('/api/console/billing/ladder');
  if (!result.ok) {
    // `no_data` here is the module saying nobody has published a price list. It is not a free
    // service and it is not an error, so it is shown as the sentence the module wrote.
    status.textContent = result.reason;
    return;
  }

  for (const rung of result.data.rungs) {
    line(list, `${rung.key} - ${rung.name ?? 'unnamed'} - ${money(rung.retainerCents)}`);
  }
  status.textContent = `${result.data.rungs.length} published rung(s).`;
  blocked($('billing-blocked'), result.data.writes);
  renderAvailable('billing-available', result.data.writes?.available);
};

const loadClient = async () => {
  const clientId = $('billing-client-id').value.trim();
  const status = $('billing-client-status');
  const list = $('billing-engagements');
  list.replaceChildren();

  if (clientId === '') {
    status.textContent = 'Give a client id.';
    return;
  }

  const result = await call(`/api/console/billing/clients/${encodeURIComponent(clientId)}`);
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  const { engagements, ladder, ladderAbsent, availableCreditCents } = result.data;

  if (engagements.length === 0) {
    line(list, 'No engagement on this file. That is not a client who owes nothing - it is a client nobody has started.');
  }
  for (const engagement of engagements) {
    // Cancelled ones are shown too: a client's history is two commercial relationships, and 7.1
    // assembles a regulator-facing file from exactly this.
    line(
      list,
      `${engagement.offerKey ?? 'no offer key'} - started ${String(engagement.startedOn).slice(0, 10)}${
        engagement.cancelledOn ? ` - CANCELLED ${String(engagement.cancelledOn).slice(0, 10)}` : ''
      }`,
    );
  }

  status.textContent = [
    `${engagements.length} engagement(s).`,
    `Available credit ${money(availableCreditCents)}.`,
    ladderAbsent ?? `${ladder.length} published rung(s) to compare against.`,
  ].join(' ');

  blocked($('billing-blocked'), result.data.writes);
  renderAvailable('billing-available', result.data.writes?.available);
};

$('billing-ladder-load').addEventListener('click', () => void loadLadder());
$('billing-client-load').addEventListener('click', () => void loadClient());

/**
 * The money controls.
 *
 * Amounts are integer cents everywhere in this system, and the field asks for cents rather than
 * accepting a decimal and rounding it. A page that quietly turned 1234.56 into cents would be the
 * one place a rounding rule lived outside the module that owns money.
 */
renderWrites('billing-writes', [
  {
    id: 'billing-engage',
    capability: 'Start an engagement',
    action: 'manage_engagement',
    note: 'Commits this client to a fee on the rung named.',
    buttonLabel: 'Start the engagement',
    done: 'Engagement started.',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'offerKey', label: 'Offer key', placeholder: 'foundation' },
      { name: 'startedOn', label: 'Started on', type: 'date' },
    ],
    path: () => '/api/console/billing/engagements',
    body: (v) => v,
  },
  {
    id: 'billing-cancel',
    capability: 'Cancel an engagement',
    action: 'manage_engagement',
    note: 'Ends the commercial relationship, so it carries a reason.',
    danger: true,
    buttonLabel: 'Cancel the engagement',
    done: 'Engagement cancelled.',
    fields: [
      { name: 'engagementId', label: 'Engagement id' },
      { name: 'reason', label: 'Reason' },
      { name: 'cancelledOn', label: 'Cancelled on', type: 'date' },
    ],
    path: (v) =>
      `/api/console/billing/engagements/${encodeURIComponent(v.engagementId)}/cancellation`,
    body: (v) => ({ reason: v.reason, cancelledOn: v.cancelledOn }),
  },
  {
    id: 'billing-credit',
    capability: 'Apply a credit',
    action: 'manage_engagement',
    note: 'Money. Integer CENTS, and the module refuses anything that is not a positive whole number of them.',
    buttonLabel: 'Apply the credit',
    done: 'Credit applied.',
    fields: [
      { name: 'engagementId', label: 'Engagement id' },
      { name: 'amountCents', label: 'Amount in CENTS' },
      { name: 'reason', label: 'Reason' },
    ],
    path: (v) => `/api/console/billing/engagements/${encodeURIComponent(v.engagementId)}/credit`,
    body: (v) => ({ amountCents: Number(v.amountCents), reason: v.reason }),
  },
]);

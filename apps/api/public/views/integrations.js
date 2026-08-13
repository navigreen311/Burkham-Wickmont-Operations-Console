/**
 * Vendor activation board - ADR-0065.
 *
 * Read-only, and there is no form on this page. That is the decision, not an unfinished screen:
 * a text box beside "SOC 2 cleared" is how the control becomes a checkbox, and the recording path
 * needs the document itself in front of a Level 3 human. The page says so where a form would be,
 * rather than leaving a gap somebody fills in later.
 *
 * No inline style and no inline script, like every other view in this app.
 */

/**
 * **This file exported a render function that nothing imported, and no script tag loaded it.**
 * `#integrations-board` rendered an empty box under a "Vendor activation" heading from the day it
 * merged - on one of the two screens that gate launch. It is now wired like the other sixteen
 * views: it finds its own container and loads itself. One idiom, because a second one is how a view
 * ends up unreachable.
 */
const call = async (path) => {
  const response = await fetch(path, { credentials: 'same-origin' });
  return response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));
};

const renderIntegrations = async (root, api) => {
  root.replaceChildren();

  const result = await api('/api/integrations/activation');

  if (result.status !== 'ok' || !result.data) {
    const failure = document.createElement('p');
    failure.textContent =
      result.reason ??
      'The activation board could not be read. That is not the same as every gate being clear.';
    root.append(failure);
    return;
  }

  const { clientOnboarding, vendors, mode, recording } = result.data;

  // The headline, first, because it is the question the page exists to answer.
  const headline = document.createElement('p');
  headline.className = clientOnboarding.permitted ? 'ok' : 'blocked';
  headline.textContent = clientOnboarding.permitted
    ? `Client onboarding is permitted. ${clientOnboarding.explanation}`
    : `Client onboarding is BLOCKED. ${clientOnboarding.explanation}`;
  root.append(headline);

  const modeLine = document.createElement('p');
  modeLine.textContent = `INTEGRATION_MODE is ${mode}.`;
  root.append(modeLine);

  /**
   * C2. Two groups, because these are two kinds of processor.
   *
   * `email`, `sms` and `voice` are the carriers underneath the platform seams - Twilio, Sendgrid or
   * whoever is eventually picked. Blueprint 4.3 routes voice through CapitalForge to VoiceForge, so
   * it is tempting to read them as covered by CapitalForge's gate. They are not: CapitalForge's
   * SOC 2 says nothing about the carrier that actually moves the message, and that carrier holds
   * client names, application status and document requests.
   *
   * Grouping rather than removing, and the header says which is which.
   */
  const COMMUNICATIONS = ['email', 'sms', 'voice'];
  const groups = [
    {
      heading: 'Client financial data vendors',
      note: 'Each holds or transmits client financial data. All four evidence items are required before any client onboards.',
      members: vendors.filter((v) => !COMMUNICATIONS.includes(v.vendor)),
    },
    {
      heading: 'Communications infrastructure',
      note: 'The carriers underneath the platform seams. CapitalForge routes voice to VoiceForge, but the provider that moves the message is a separate processor with its own SOC 2 - so each carries its own four items rather than inheriting the platform gate above.',
      members: vendors.filter((v) => COMMUNICATIONS.includes(v.vendor)),
    },
  ];

  for (const group of groups) {
    if (group.members.length === 0) continue;

    const groupHeading = document.createElement('h3');
    groupHeading.textContent = group.heading;
    root.append(groupHeading);

    const groupNote = document.createElement('p');
    groupNote.className = 'muted';
    groupNote.textContent = group.note;
    root.append(groupNote);

    for (const vendor of group.members) {
    const block = document.createElement('section');

    const title = document.createElement('h3');
    title.textContent = `${vendor.vendor} - ${vendor.activated ? 'activated' : 'not activated'}`;
    block.append(title);

    const explanation = document.createElement('p');
    explanation.textContent = vendor.explanation;
    block.append(explanation);

    if (vendor.outstanding.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Outstanding';
      block.append(heading);

      const list = document.createElement('ul');
      for (const item of vendor.outstanding) {
        const entry = document.createElement('li');
        entry.textContent = `${item.label} - ${item.why}`;
        list.append(entry);
      }
      block.append(list);
    }

    if (vendor.accepted.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Accepted';
      block.append(heading);

      const table = document.createElement('table');
      const header = document.createElement('tr');
      for (const label of [
        'Evidence',
        'Document',
        'Issued by',
        'Valid until',
        'Accepted by',
        'Accepted at',
      ]) {
        const cell = document.createElement('th');
        cell.textContent = label;
        header.append(cell);
      }
      table.append(header);

      for (const entry of vendor.accepted) {
        const row = document.createElement('tr');
        // The document reference is shown, always. A green tick with nothing beside it is the
        // thing this whole design refuses to be.
        for (const value of [
          entry.kind,
          entry.documentReference,
          entry.issuedBy,
          entry.validUntil ? entry.validUntil.slice(0, 10) : 'does not expire',
          entry.acceptedBy,
          entry.acceptedAt.slice(0, 10),
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        table.append(row);
      }
      block.append(table);
    }

    root.append(block);
    }
  }

  /**
   * C1. The Forge platforms, present with a stated reason rather than silently absent.
   *
   * Blueprint 11.5 lists these among the Integration Layer's configurations, so a reader who knows
   * the blueprint and does not find them here concludes the board is incomplete. They follow a
   * different gate because they carry no client financial data: FunnelForge is an external
   * marketing funnel, and the content Forges publish the firm's own material.
   *
   * FunnelForge does carry prospect contact details, which is personal data even though it is not
   * financial - said here rather than smoothed over, because "not financial" is not "not personal".
   *
   * ChamberForge is V2 scope and is listed as such: a reader should not have to work out whether
   * its absence from the evidence board is an omission or a roadmap.
   */
  const nonFinancial = [
    ['FunnelForge', 'External marketing funnel. Carries prospect contact details - personal data, though not financial - and no client file.'],
    ['SelfPublisherForge', "Publishes the firm's own long-form content. No client data."],
    ['AnimaForge', "Generates the firm's own motion content. No client data."],
    ['VideoEditForge', "Edits the firm's own video content. No client data."],
    ['ChamberForge', 'V2 scope - the bridge integration is not built. Listed so its absence reads as a roadmap rather than an omission.'],
  ];

  const nfHeading = document.createElement('h3');
  nfHeading.textContent = 'Non-financial-data integrations';
  root.append(nfHeading);

  const nfNote = document.createElement('p');
  nfNote.className = 'muted';
  nfNote.textContent =
    'Named in blueprint 11.5 and not on the evidence board above, because none holds client financial data. They are shown here so their absence from the four-item gate is a stated position rather than a gap. None is activated, and none has a vendor gate in this system today.';
  root.append(nfNote);

  const nfList = document.createElement('ul');
  for (const [name, why] of nonFinancial) {
    const entry = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = name;
    entry.append(strong, document.createTextNode(` — ${why}`));
    nfList.append(entry);
  }
  root.append(nfList);

  // Where a form would be.
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = recording.reason;
  root.append(note);
};

/**
 * Bound to a button, not run on load.
 *
 * A view that fetches when its module executes fetches while nobody is signed in - the panel then
 * renders "Sign in to continue." and never re-renders, which is how a wired view looks exactly like
 * an unwired one. Every other view in this directory is button-triggered for the same reason.
 */
const trigger = document.getElementById('integrations-load');
const board = document.getElementById('integrations-board');
if (trigger !== null && board !== null) {
  trigger.addEventListener('click', () => void renderIntegrations(board, call));
}

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
 * Render the board into a container.
 *
 * @param {HTMLElement} root
 * @param {(path: string) => Promise<{status: string, data?: unknown, reason?: string}>} api
 */
export const renderIntegrations = async (root, api) => {
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

  for (const vendor of vendors) {
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

  // Where a form would be.
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = recording.reason;
  root.append(note);
};

/**
 * 5.1 and 5.6 on the page.
 *
 * **This panel is a calculator, and it says so on every answer.**
 *
 * There is no capital position store - Plaid is ungated under Decision A - so the per-client stack
 * route refuses, and this panel renders that refusal at the top rather than showing an empty table.
 * An empty stack reads as "this client has no debt", which is the most reassuring possible way to
 * be wrong here.
 *
 * What works is the model: the operator states a stack from a statement and gets 5.1's health, PG
 * exposure, payment calendar and promo runway, plus 5.6's per-product and blended cost and a
 * refinance comparison. Every answer carries `basis`, which says the figures came from what
 * somebody typed - principle 8 is not satisfied by the arithmetic being right.
 *
 * **The health score renders with its components, never alone.** `capitalStackHealth` has no
 * constructor that produces a score without them, precisely so the number cannot travel by itself
 * into a deliverable, and a page that showed only the number would undo that.
 *
 * Every value reaches the DOM through `textContent`.
 */

const call = async (path, body) => {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
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

const money = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'not computed';

const percent = (value) =>
  value === null || value === undefined ? 'not computed' : `${(value * 100).toFixed(2)}%`;

const render = (data) => {
  $('capital-basis').textContent = data.basis.detail;
  $('capital-asof').textContent =
    data.asOf === null
      ? 'No observation date on the stated stack.'
      : `Stack is only as current as its stalest position: ${data.asOf}.`;

  // Score AND components. The module refuses to produce one without the other; so does this.
  $('capital-health-score').textContent = `Stack health: ${data.health.band ?? data.health.score}`;
  const components = $('capital-health-components');
  components.replaceChildren();
  for (const component of data.health.components ?? []) {
    line(
      components,
      `${component.name ?? component.key}: ${component.band ?? component.score} — ${component.detail ?? ''}`,
    );
  }

  const blended = data.blendedCostOfCapital;
  $('capital-blended').textContent =
    blended.blendedApr === null
      ? `Blended cost: not computed. ${blended.uncostedBalance} of ${blended.totalOutstanding} outstanding could not be costed.`
      : `Blended cost: ${percent(blended.blendedApr.value)} across ${money(blended.totalOutstanding)}, coverage ${percent(blended.coverage)}${
          blended.uncostedBalance > 0 ? ` (${money(blended.uncostedBalance)} uncosted)` : ''
        }.`;

  $('capital-obligation').textContent =
    `Total monthly obligation: ${money(data.totalMonthlyObligation)}.`;

  const perPosition = $('capital-positions');
  perPosition.replaceChildren();
  for (const entry of data.perPosition) {
    line(
      perPosition,
      `${entry.label} (${entry.provider}, ${entry.kind}): effective APR ${percent(entry.cost.effectiveApr)}, total cost ${money(entry.cost.totalCost)} on ${money(entry.cost.netProceeds)} net proceeds — term derived from balance and payment, not contractual.`,
    );
  }

  const alerts = $('capital-alerts');
  alerts.replaceChildren();
  if ((data.promoAlerts ?? []).length === 0) {
    line(alerts, 'No promotional window is inside its alert horizon.');
  } else {
    for (const alert of data.promoAlerts) {
      line(
        alerts,
        `${alert.label ?? alert.positionId}: ${alert.detail ?? `${alert.daysRemaining} days remaining`}`,
      );
    }
  }

  const restack = $('capital-restack');
  restack.replaceChildren();
  if ((data.restackWindows ?? []).length === 0) {
    line(restack, 'No re-stack window is open.');
  } else {
    for (const window of data.restackWindows) {
      line(
        restack,
        `${window.label ?? window.positionId}: ${window.detail ?? window.opensOn ?? ''}`,
      );
    }
  }

  const exposure = $('capital-pg');
  exposure.replaceChildren();
  if ((data.pgExposure ?? []).length === 0) {
    line(exposure, 'No personal guarantee is stated on this stack.');
  } else {
    for (const owner of data.pgExposure) {
      line(
        exposure,
        `${owner.ownerName}: ${money(owner.exposureAmount.value)} across ${owner.guaranteedPositions} position(s)${
          owner.hasUnlimitedGuarantee ? ' — UNLIMITED guarantee' : ''
        }`,
      );
    }
  }

  const refinance = $('capital-refinance');
  refinance.replaceChildren();
  if (data.refinance === null) {
    line(refinance, 'No refinance was proposed.');
  } else {
    line(
      refinance,
      data.refinance.worthwhile
        ? `Worthwhile: saves ${money(data.refinance.savings)} in total cost.`
        : `NOT worthwhile: costs ${money(-data.refinance.savings)} more in total cost.`,
    );
    line(
      refinance,
      `Compared on TOTAL COST, not rate. Current ${money(data.refinance.currentTotalCost)} versus proposed ${money(data.refinance.proposedTotalCost)}.`,
    );
    if (data.refinance.caveat) line(refinance, data.refinance.caveat);
  }
};

const loadStackRefusal = async () => {
  const clientId = $('capital-client-id').value.trim();
  const target = $('capital-stack-refusal');
  if (clientId === '') {
    target.textContent = 'Enter a client id to see what the stack route says.';
    return;
  }
  const result = await call(`/api/console/clients/${encodeURIComponent(clientId)}/stack`);
  // Expected to refuse. The reason is the content: it names Decision A and the Integration Layer.
  target.textContent = result.ok ? 'A stack was returned.' : result.reason;
};

const readStack = () => {
  const raw = $('capital-stack-json').value.trim();
  if (raw === '') return { problem: 'Paste a stack first.' };
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { positions: parsed }
      : { problem: 'Expected a JSON array of positions.' };
  } catch {
    return { problem: 'That is not valid JSON.' };
  }
};

const model = async () => {
  const status = $('capital-status');
  const stack = readStack();
  if ('problem' in stack) {
    status.textContent = stack.problem;
    return;
  }

  status.textContent = 'Computing…';
  const result = await call('/api/console/capital/model', { positions: stack.positions });
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  render(result.data);
  status.textContent = `Modelled ${result.data.positionCount} position(s).`;
  $('capital-result').hidden = false;
};

$('capital-model').addEventListener('click', () => void model());
$('capital-check-stack').addEventListener('click', () => void loadStackRefusal());

/**
 * 11.11 Founder / Executive Workbench on the page.
 *
 * **The queue is decisions, not a feed.** Every item carries a cost of inaction, and this panel
 * renders it beside the item rather than behind a click - a list of things that are wrong with no
 * stated consequence is a source of anxiety rather than a surface.
 *
 * **An empty queue is a sentence, not a blank panel.** "Nothing needs you" and "this did not load"
 * look identical when both render nothing, so the module sends the sentence and this shows it.
 *
 * Nothing here is ranked by a number. Urgency is categorical, worst first, and rendered as a word.
 *
 * Every value reaches the DOM through `textContent`.
 */

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


const loadDecisions = async () => {
  const status = $('workbench-status');
  const list = $('workbench-decisions');
  list.replaceChildren();

  const result = await call('/api/console/workbench/decisions');
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const decision of result.data.decisions) {
    line(
      list,
      `${decision.urgency} - ${decision.kind} - ${decision.summary ?? ''} - cost of inaction: ${
        decision.costOfInaction
      }`,
    );
  }

  // The module's own sentence, whether the queue is empty or not.
  status.textContent = result.data.detail;
};

const loadWorkbench = async () => {
  const status = $('workbench-summary');
  const list = $('workbench-health');
  list.replaceChildren();

  const result = await call('/api/console/workbench');
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  const health = result.data.health;
  for (const component of health.components ?? []) {
    // `unmonitored` is a state and it is not green (ADR-0019). Words, never a colour.
    line(list, `${component.label}: ${component.state} - ${component.detail}`);
  }

  status.textContent = `Overall ${health.overall}. ${result.data.decisions.length} decision(s) waiting.`;
};

$('workbench-load').addEventListener('click', () => void loadWorkbench());
$('workbench-decisions-load').addEventListener('click', () => void loadDecisions());

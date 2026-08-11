/**
 * One function per Console route.
 *
 * No logic beyond the shape of the `Outcome` envelope: `{status, data}` on success, `{status,
 * reason}` otherwise. The status NAME is in the body as well as the code (ADR-0002), and this file
 * reads the name rather than inferring meaning from a number.
 *
 * `credentials: 'same-origin'` is the default for a same-origin request and is written out anyway,
 * because the session cookie is the whole of the authentication and a reader should not have to
 * remember a default to know that.
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

  // `trace` rides on every envelope a write produces, refusals included. It names the middleware
  // step that blocked the action, which is the difference between a dead end and an instruction.
  return payload.status === 'ok'
    ? { ok: true, data: payload.data, trace: payload.trace }
    : {
        ok: false,
        reason: payload.reason ?? 'Something went wrong.',
        status: payload.status,
        trace: payload.trace,
      };
};

export const signIn = (email, password, code) =>
  call('/api/console/sign-in', { email, password, code });
export const signOut = () => call('/api/console/sign-out', {});
export const me = () => call('/api/console/me');

export const overview = () => call('/api/console/overview');
export const queue = () => call('/api/console/queue');
export const obligations = () => call('/api/console/obligations');

export const clients = (search, limit, offset) => {
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  query.set('limit', String(limit));
  query.set('offset', String(offset));
  return call(`/api/console/clients?${query.toString()}`);
};

// Path segments are encoded rather than interpolated raw. A client id is a UUID today, and a route
// that only works because its inputs happen to be URL-safe is one input away from not working.
export const client = (clientId) => call(`/api/console/clients/${encodeURIComponent(clientId)}`);
export const clientRisk = (clientId) =>
  call(`/api/console/clients/${encodeURIComponent(clientId)}/risk`);

/* --- writes ---------------------------------------------------------------
 *
 * Every one of these is refused by the middleware chain unless the signed-in actor holds the
 * Authority Level the action declares. The page hides what it cannot do as a courtesy; the server
 * is what makes it true.
 */

export const createClient = (legalName) => call('/api/clients', { legalName });

export const transitionCompliance = (clientId, to, reason, findings) =>
  call(`/api/clients/${encodeURIComponent(clientId)}/compliance`, {
    to,
    reason,
    ...(findings && findings.length > 0 ? { findings } : {}),
  });

export const triggerFirewall = (clientId, reason) =>
  call(`/api/clients/${encodeURIComponent(clientId)}/firewall/trigger`, { reason });

export const recordConsent = (clientId, kind, scope) =>
  call(`/api/clients/${encodeURIComponent(clientId)}/consents`, { kind, scope });

export const vocabulary = () => call('/api/console/vocabulary');

export const inviteStaff = (actorId, email) =>
  call('/api/console/invitations', { actorId, email });

/* --- enrolment, for somebody who has no credential yet --------------------- */

export const enrol = (token, password) => call('/api/console/enrolment', { token, password });
export const confirmEnrolment = (actorId, password, code) =>
  call('/api/console/enrolment/confirm', { actorId, password, code });

/**
 * Ask 5.3 for a recommendation.
 *
 * `applicationRef` is not optional and is not a convenience: authorisation is scoped to a specific
 * application, never blanket, and the reference is what ties the consent to the request.
 */
export const requestPlacement = (clientId, applicationRef, need, requestedAmount) =>
  call(`/api/clients/${encodeURIComponent(clientId)}/placements`, {
    applicationRef,
    need,
    requestedAmount,
  });

/* --- reads only, and deliberately -----------------------------------------
 *
 * Everything below this line is a GET. The five modules these reach into all expose writes -
 * resolving a checkpoint, generating a contract, paying a refund - and none of those writes has an
 * action in `ACTION_MINIMUM_LEVEL`, which is what the middleware chain checks at step 3. An
 * undeclared action is refused, never assumed permitted, so there is nothing to call. ADR-0037.
 */

/* --- 2.4 Human Approval Console -------------------------------------------- */

/**
 * The approval queue.
 *
 * `queue` is typed by the operator rather than chosen from a served list, which is the one place
 * this page departs from the closed-vocabulary rule. Queue names live inside playbook definitions
 * and nothing enumerates them; a select filled from a list this file invented would offer choices
 * the system has never heard of.
 */
export const approvals = (queue) => {
  const query = new URLSearchParams();
  if (queue) query.set('queue', queue);
  return call(`/api/console/approvals?${query.toString()}`);
};

export const approval = (taskId) => call(`/api/console/approvals/${encodeURIComponent(taskId)}`);

/* --- 7.3 Contract & Disclosure Builder ------------------------------------- */

export const contracts = (clientId) =>
  call(`/api/console/clients/${encodeURIComponent(clientId)}/contracts`);
export const contract = (contractId) =>
  call(`/api/console/contracts/${encodeURIComponent(contractId)}`);
export const contractStaleness = () => call('/api/console/contract-staleness');

/* --- 3.2 Secure Document Vault --------------------------------------------- */

/**
 * Metadata and the access log. **There is no route here that returns a document.**
 *
 * `read` exists in the Vault and decrypts; it is not exposed to this page, because a staff session
 * reaches every file in the firm and this is the data class where that costs the most.
 */
export const documents = (clientId) =>
  call(`/api/console/clients/${encodeURIComponent(clientId)}/documents`);
export const documentAccessLog = (documentId) =>
  call(`/api/console/documents/${encodeURIComponent(documentId)}/access-log`);

/* --- 1.4 Pricing, Billing & Offer Management ------------------------------- */

export const offers = () => call('/api/console/offers');
export const billing = (clientId) =>
  call(`/api/console/clients/${encodeURIComponent(clientId)}/billing`);
export const engagement = (engagementId) =>
  call(`/api/console/engagements/${encodeURIComponent(engagementId)}`);

/* --- 11.11 Founder / Executive Workbench ----------------------------------- */

export const workbench = () => call('/api/console/workbench');

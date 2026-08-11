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

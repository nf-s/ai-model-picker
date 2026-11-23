import { requireAccess, response } from './auth/index.mjs';

const METHODS = ['GET', 'HEAD'];

/**
 * A JSON body serialised once, when the Function starts. A large payload sent
 * this way costs a request only the copy, not a serialisation.
 */
export function preparedJson(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Serves server-only data to signed-in, granted accounts. */
export async function handleProtectedJson(request, env, payload, dependencies) {
  if (!METHODS.includes(request.method))
    return response(
      { error: 'method_not_allowed', message: 'Method not allowed.' },
      405,
      { Allow: METHODS.join(', ') },
    );
  const access = await requireAccess(request, env, dependencies);
  if (access.response) return access.response;
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (!(payload instanceof Uint8Array))
    return response(request.method === 'HEAD' ? null : payload, 200, headers);
  const { status, headers: prepared } = response(null, 200, headers);
  return new Response(request.method === 'HEAD' ? null : payload, {
    status,
    headers: prepared,
  });
}

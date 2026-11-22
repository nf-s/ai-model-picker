import { requireAccess, response } from './auth/index.mjs';

const METHODS = ['GET', 'HEAD'];

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
  return response(request.method === 'HEAD' ? null : payload, 200, {
    'Cache-Control': 'private, no-store',
    Vary: 'Cookie',
  });
}

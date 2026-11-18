import { requireAccess, response } from './auth/index.mjs';

const METHODS = ['GET', 'HEAD'];

/**
 * Serves benchmarks whose source terms do not allow republishing, to
 * signed-in, granted accounts only. `dependencies.payload` is read by the Pages
 * Function from the ignored .local/restricted/payload.json.
 */
export async function handleRestrictedRequest(
  request,
  env,
  { payload, ...dependencies },
) {
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

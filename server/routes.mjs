import { handleAuthRequest, response } from './auth/index.mjs';
import { handleRestrictedRequest } from './restricted.mjs';

function notFound() {
  return response({ error: 'not_found', message: 'Not found.' }, 404);
}

export async function routeAuth(request, env) {
  return (await handleAuthRequest(request, env)) ?? notFound();
}

export async function routeApi(request, env, { results, ...dependencies }) {
  if (new URL(request.url).pathname === '/api/restricted')
    return handleRestrictedRequest(request, env, { results, ...dependencies });
  return (await handleAuthRequest(request, env, dependencies)) ?? notFound();
}

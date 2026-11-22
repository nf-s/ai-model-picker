import { handleAuthRequest, response } from './auth/index.mjs';
import { handleProtectedJson } from './restricted.mjs';

function notFound() {
  return response({ error: 'not_found', message: 'Not found.' }, 404);
}

export async function routeAuth(request, env) {
  return (await handleAuthRequest(request, env)) ?? notFound();
}

export async function routeApi(
  request,
  env,
  { payload, expertArticles, ...dependencies },
) {
  const path = new URL(request.url).pathname;
  if (path === '/api/restricted')
    return handleProtectedJson(request, env, payload, dependencies);
  if (path === '/api/expert-articles')
    return handleProtectedJson(request, env, expertArticles, dependencies);
  return (await handleAuthRequest(request, env, dependencies)) ?? notFound();
}

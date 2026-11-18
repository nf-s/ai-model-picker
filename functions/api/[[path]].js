import restricted from '../../.local/restricted/results.json' with { type: 'json' };
import { routeApi } from '../../server/routes.mjs';

export const onRequest = (context) =>
  routeApi(context.request, context.env, { results: restricted.results });

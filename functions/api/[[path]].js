import payload from '../../.local/restricted/payload.json' with { type: 'json' };
import expertArticles from '../../.local/expert-articles/catalog.json' with { type: 'json' };
import { routeApi } from '../../server/routes.mjs';

export const onRequest = (context) =>
  routeApi(context.request, context.env, { payload, expertArticles });

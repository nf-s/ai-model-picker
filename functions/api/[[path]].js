import payload from '../../.local/restricted/payload.json' with { type: 'json' };
import expertArticles from '../../.local/expert-articles/catalog.json' with { type: 'json' };
import namedPrivate from '../../build/records/named-private.json' with { type: 'json' };
import { namedParts } from '../../server/named.mjs';
import { preparedJson } from '../../server/restricted.mjs';
import { routeApi } from '../../server/routes.mjs';

// Serialised once per instance; each request only sends the bytes.
const parts = namedParts(namedPrivate);
const named = preparedJson(parts.named);
const namedAdvice = preparedJson(parts.advice);

export const onRequest = (context) =>
  routeApi(context.request, context.env, {
    payload,
    expertArticles,
    named,
    namedAdvice,
  });

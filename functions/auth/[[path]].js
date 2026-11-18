import { routeAuth } from '../../server/routes.mjs';

export const onRequest = (context) => routeAuth(context.request, context.env);

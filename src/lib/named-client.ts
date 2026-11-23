import { useEffect, useState } from 'react';
import type { Access } from './access.ts';
import { indexNamed, namedAdviceSchema, namedPayloadSchema } from './named.ts';
import type { AdviceRecord, NamedIndex } from './named.ts';

// Named records come from Pages Functions that serve them to signed-in,
// granted accounts only (`/api/named`, `/api/named/advice`); the dev server
// serves the records build's file to loopback requests. A visitor without a
// session requests nothing: the app knows there is no session from the
// missing sign-in cookie (`loadAccess`).

export type Loaded<T> =
  // Nothing was requested: no session.
  | { status: 'none' }
  | { status: 'loading' }
  // The server refused: the session ended or the grant was revoked.
  | { status: 'sign-in' }
  | { status: 'failed' }
  | { status: 'ready'; value: T };
export type NamedState = Loaded<NamedIndex>;
export type AdviceState = Loaded<AdviceRecord[]>;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Answer<T> = { kind: 'sign-in' } | { kind: 'ready'; value: T };

export const canLoadNamed = (access: Access) =>
  access.kind === 'signed-in' || access.kind === 'local';

async function readProtected(path: string, fetcher: Fetcher) {
  const response = await fetcher(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('The named records are unavailable.');
  const body: unknown = await response.json();
  return body;
}

// The people and use records, or null (no request made) without a session.
export function requestNamed(
  access: Access,
  fetcher: Fetcher = fetch,
): Promise<Answer<NamedIndex>> | null {
  if (!canLoadNamed(access)) return null;
  return readProtected('/api/named', fetcher).then((body) =>
    body === null
      ? { kind: 'sign-in' }
      : { kind: 'ready', value: indexNamed(namedPayloadSchema.parse(body)) },
  );
}

// Method advice, or null (no request made) without a session.
export function requestAdvice(
  access: Access,
  fetcher: Fetcher = fetch,
): Promise<Answer<AdviceRecord[]>> | null {
  if (!canLoadNamed(access)) return null;
  return readProtected('/api/named/advice', fetcher).then((body) =>
    body === null
      ? { kind: 'sign-in' }
      : { kind: 'ready', value: namedAdviceSchema.parse(body).advice },
  );
}

// Each part is requested once per page load, by the first view that needs it.
function once<T>(request: (access: Access) => Promise<Answer<T>> | null) {
  let shared: Promise<Answer<T>> | null = null;
  return (access: Access) => {
    if (shared) return shared;
    const started = request(access);
    if (started === null) return null;
    shared = started.catch((error: unknown) => {
      shared = null;
      throw error;
    });
    return shared;
  };
}
const loadNamed = once((access) => requestNamed(access));
const loadAdvice = once((access) => requestAdvice(access));

function useLoaded<T>(
  load: (access: Access) => Promise<Answer<T>> | null,
  access: Access,
  enabled: boolean,
): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: 'none' });
  useEffect(() => {
    if (!enabled) return;
    const promise = load(access);
    if (promise === null) return;
    let current = true;
    setState({ status: 'loading' });
    promise.then(
      (answer) => {
        if (current)
          setState(
            answer.kind === 'ready'
              ? { status: 'ready', value: answer.value }
              : { status: 'sign-in' },
          );
      },
      () => {
        if (current) setState({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [load, access, enabled]);
  return state;
}

export function useNamedData(access: Access): NamedState {
  return useLoaded(loadNamed, access, true);
}

// Method advice, requested only by a view that shows it.
export function useNamedAdvice(access: Access, enabled: boolean): AdviceState {
  return useLoaded(loadAdvice, access, enabled);
}

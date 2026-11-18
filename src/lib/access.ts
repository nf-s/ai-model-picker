import { z } from 'zod';
import { addRestrictedResults, restrictedRemote } from './data';

// The readable CSRF cookie is set with every session, so a browser without it
// has no session and the app skips the session request.
const csrfCookie = '__Host-picker-csrf';

const sessionSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    email: z.string().min(1).max(254),
    isAdmin: z.boolean(),
    csrfToken: z.string().min(1).nullable(),
    expiresAt: z.number().int().positive(),
  }),
]);
const errorSchema = z.object({ message: z.string().min(1) });
const enrollmentSchema = z.object({
  enrollment: z
    .object({
      email: z.string().min(1).max(254),
      subject: z.string().min(1).max(255),
      expiresAt: z.number().int().positive(),
    })
    .nullable(),
});
export const grantsSchema = z.object({
  adminEmail: z.string().min(1),
  grants: z.array(
    z.object({
      email: z.string().min(1),
      subject: z.string().nullable(),
      enabled: z.boolean(),
      isAdmin: z.boolean(),
      updatedAt: z.number().int(),
    }),
  ),
});
const okSchema = z.object({ ok: z.literal(true) });

export type Grant = z.infer<typeof grantsSchema>['grants'][number];
export type Enrollment = NonNullable<
  z.infer<typeof enrollmentSchema>['enrollment']
>;
export type Access =
  | { kind: 'local' }
  | { kind: 'anonymous' }
  | { kind: 'unavailable' }
  | {
      kind: 'signed-in';
      email: string;
      isAdmin: boolean;
      csrfToken: string | null;
      restricted: boolean;
    };

export const signInMessages: Record<string, string> = {
  access_denied:
    'This account does not have access. Ask the administrator to add your email address.',
  authentication_required: 'Sign in to continue.',
  enrollment_required:
    'This account needs the administrator to approve its Google account ID before it can sign in.',
  invalid_state: 'This sign-in attempt expired. Try again.',
  invalid_request: 'This sign-in attempt could not be completed. Try again.',
  login_cancelled: 'Sign-in was cancelled.',
  invalid_identity:
    'This Google account could not be verified. Try another account.',
  configuration_error: 'Sign-in is not configured yet.',
  storage_unavailable: 'Sign-in is temporarily unavailable. Try again later.',
  google_unavailable:
    'Google sign-in is temporarily unavailable. Try again later.',
  authentication_unavailable:
    'Sign-in is temporarily unavailable. Try again later.',
};

function hasSessionCookie() {
  return document.cookie
    .split(';')
    .some((part) => part.trim().startsWith(`${csrfCookie}=`));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('The account service returned an unreadable response.');
  }
}

function failure(payload: unknown, status: number) {
  const parsed = errorSchema.safeParse(payload);
  return new Error(
    parsed.success
      ? parsed.data.message
      : status === 401
        ? 'Your session expired. Sign in again.'
        : 'The account request could not be completed.',
  );
}

/** Reads the session and, for an approved account, the restricted results. */
export async function loadAccess(): Promise<Access> {
  if (!restrictedRemote) return { kind: 'local' };
  if (!hasSessionCookie()) return { kind: 'anonymous' };
  try {
    const response = await fetch('/api/session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { kind: 'unavailable' };
    const session = sessionSchema.safeParse(await readJson(response));
    if (!session.success) return { kind: 'unavailable' };
    if (!session.data.authenticated) return { kind: 'anonymous' };
    const restricted = await fetch('/api/restricted', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return {
      kind: 'signed-in',
      email: session.data.email,
      isAdmin: session.data.isAdmin,
      csrfToken: session.data.csrfToken,
      restricted:
        restricted.ok && addRestrictedResults(await readJson(restricted)),
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function signInHref(next: string) {
  return `/auth/google/start?${new URLSearchParams({ next })}`;
}

async function send(
  path: string,
  csrfToken: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  body?: object,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (!csrfToken) throw new Error('Sign in again to restore these controls.');
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw failure(payload, response.status);
  return payload;
}

export async function signOut(csrfToken: string | null) {
  okSchema.parse(await send('/auth/logout', csrfToken, 'POST'));
}

export async function listGrants(csrfToken: string | null) {
  return grantsSchema.parse(await send('/api/admin/access', csrfToken, 'GET'));
}

export async function grantAccess(
  csrfToken: string | null,
  email: string,
  subject: string | null,
) {
  okSchema.parse(
    await send('/api/admin/access', csrfToken, 'POST', {
      email,
      ...(subject ? { subject } : {}),
    }),
  );
}

export async function revokeAccess(csrfToken: string | null, email: string) {
  okSchema.parse(
    await send('/api/admin/access', csrfToken, 'DELETE', { email }),
  );
}

export async function loadEnrollment(): Promise<Enrollment | null> {
  return enrollmentSchema.parse(await send('/api/enrollment', null, 'GET'))
    .enrollment;
}

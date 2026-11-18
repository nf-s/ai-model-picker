import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  grantAccess,
  listGrants,
  loadEnrollment,
  revokeAccess,
  signInHref,
  signInMessages,
  signOut,
} from '../lib/access';
import type { Access, Enrollment, Grant } from '../lib/access';
import { routeHref } from '../lib/route';
import './account.css';

const accountHref = `/${routeHref({ view: 'account', error: null })}`;

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The account request could not be completed.';
}

function EnrollmentDetails() {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [status, setStatus] = useState('Loading approval details…');
  useEffect(() => {
    loadEnrollment().then(
      (details) => {
        setEnrollment(details);
        setStatus(
          details
            ? ''
            : 'This approval request expired. Sign in again to create a new one.',
        );
      },
      () => setStatus('Approval details could not be loaded. Sign in again.'),
    );
  }, []);
  if (!enrollment) return <p className="rd-note">{status}</p>;
  const details = `Email: ${enrollment.email}\nGoogle account ID: ${enrollment.subject}`;
  return (
    <div className="rd-ac-enrollment">
      <p>Send these details to the administrator:</p>
      <dl>
        <dt>Email</dt>
        <dd>{enrollment.email}</dd>
        <dt>Google account ID</dt>
        <dd>
          <code>{enrollment.subject}</code>
        </dd>
      </dl>
      <button
        type="button"
        className="rd-button"
        onClick={() =>
          navigator.clipboard.writeText(details).then(
            () => setStatus('Approval details copied.'),
            () => setStatus('Select and copy the details above.'),
          )
        }
      >
        Copy details
      </button>
      {status && (
        <p className="rd-note" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function AccessManager({ csrfToken }: { csrfToken: string | null }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const refresh = useCallback(
    () =>
      listGrants(csrfToken).then(
        (data) => setGrants(data.grants),
        (error: unknown) => setStatus(message(error)),
      ),
    [csrfToken],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function change(action: () => Promise<void>, done: string) {
    setBusy(true);
    setStatus('Saving…');
    try {
      await action();
      await refresh();
      setStatus(done);
      return true;
    } catch (error) {
      setStatus(message(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = email.trim();
    const id = subject.trim();
    if (
      await change(
        () => grantAccess(csrfToken, target, id || null),
        `Access granted to ${target}.`,
      )
    ) {
      setEmail('');
      setSubject('');
    }
  }

  const disabled = busy || !csrfToken;
  return (
    <section className="rd-section" aria-labelledby="rd-ac-access-title">
      <h2 className="rd-h" id="rd-ac-access-title">
        Manage access
      </h2>
      <form className="rd-panel rd-ac-form" onSubmit={submit}>
        <label>
          Google email
          <input
            className="rd-input"
            type="email"
            name="email"
            required
            maxLength={254}
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          Google account ID (optional)
          <input
            className="rd-input"
            name="subject"
            maxLength={255}
            autoComplete="off"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            disabled={disabled}
          />
        </label>
        <p className="rd-note">
          Gmail and Google Workspace addresses need only the email. Other
          addresses also need the account ID shown after their first sign-in.
        </p>
        <div>
          <button
            type="submit"
            className="rd-button rd-button-primary"
            disabled={disabled}
          >
            Grant access
          </button>
        </div>
      </form>
      <p className="rd-note" role="status">
        {status}
      </p>
      {grants === null ? (
        <p className="rd-note">Loading the access list…</p>
      ) : (
        <ul className="rd-panel rd-ac-grants">
          {grants.map((grant) => (
            <li key={grant.email}>
              <span>
                <strong>{grant.email}</strong>
                <span className="rd-muted">
                  {grant.isAdmin
                    ? 'Administrator'
                    : grant.enabled
                      ? 'Allowed'
                      : 'Revoked'}
                </span>
              </span>
              {!grant.isAdmin && (
                <button
                  type="button"
                  className="rd-button"
                  disabled={disabled}
                  onClick={() =>
                    grant.enabled
                      ? change(
                          () => revokeAccess(csrfToken, grant.email),
                          `Access revoked for ${grant.email}.`,
                        )
                      : change(
                          () => grantAccess(csrfToken, grant.email, null),
                          `Access restored for ${grant.email}.`,
                        )
                  }
                >
                  {grant.enabled ? 'Revoke' : 'Restore'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Account({
  access,
  error,
}: {
  access: Access;
  error: string | null;
}) {
  const [status, setStatus] = useState('');
  const known = error !== null && Object.hasOwn(signInMessages, error);
  const signIn = (
    <a className="rd-button rd-button-primary" href={signInHref(accountHref)}>
      Sign in with Google
    </a>
  );
  return (
    <div className="rd-page rd-ac">
      <header className="rd-page-head">
        <h1>Account</h1>
      </header>
      {access.kind === 'local' && (
        <p className="rd-note">Sign-in is available on the published site.</p>
      )}
      {access.kind === 'unavailable' && (
        <>
          <p className="rd-alert rd-ac-alert" role="alert">
            The account service could not be reached. Public data is still
            shown.
          </p>
          <div>{signIn}</div>
        </>
      )}
      {access.kind === 'anonymous' && (
        <>
          {error !== null && (
            <p className="rd-alert rd-ac-alert" role="alert">
              {known
                ? signInMessages[error]
                : 'Sign-in could not be completed. Try again.'}
            </p>
          )}
          {error === 'enrollment_required' && <EnrollmentDetails />}
          <div>{signIn}</div>
        </>
      )}
      {access.kind === 'signed-in' && (
        <>
          <section className="rd-panel rd-ac-session">
            <p>
              Signed in as <strong>{access.email}</strong>
              {access.isAdmin && ' · Administrator'}
            </p>
            {!access.restricted && (
              <p className="rd-alert rd-ac-alert" role="alert">
                Some benchmark results could not be loaded. Reload the page to
                try again.
              </p>
            )}
            <div>
              <button
                type="button"
                className="rd-button"
                disabled={!access.csrfToken}
                onClick={() => {
                  setStatus('Signing out…');
                  signOut(access.csrfToken).then(
                    () => window.location.replace('/'),
                    (failure: unknown) => setStatus(message(failure)),
                  );
                }}
              >
                Sign out
              </button>
            </div>
            {status && (
              <p className="rd-note" role="status">
                {status}
              </p>
            )}
          </section>
          {access.isAdmin && <AccessManager csrfToken={access.csrfToken} />}
        </>
      )}
    </div>
  );
}

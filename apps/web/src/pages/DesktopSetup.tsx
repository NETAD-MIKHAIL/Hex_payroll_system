import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

/** Uses ordinary HTTP interfaces; no privileged Electron bridge is exposed to React. */
export function DesktopSetup({ children }: { children: ReactNode }) {
  const [required, setRequired] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (window.location.protocol !== 'hexpayroll:') {
      setRequired(false);
      return;
    }
    void fetch('hexpayroll://app/api/desktop/setup', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = (await response.json()) as { required: boolean };
        if (typeof result.required !== 'boolean') throw new Error();
        setRequired(result.required);
      })
      .catch(() => setError('Unable to check local setup. Close and reopen Hex Payroll.'));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    if (data.get('password') !== data.get('confirmation')) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const email = String(data.get('email') ?? '').trim();
      const response = await fetch('hexpayroll://app/api/desktop/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: String(data.get('username')).trim(),
          displayName: String(data.get('displayName')).trim(),
          password: data.get('password'),
          ...(email ? { email } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        setError(
          response.status === 409
            ? 'Setup is already complete. Reopen Hex Payroll to sign in.'
            : 'Check account details. Your password must contain 15–128 characters.',
        );
        return;
      }
      setRequired(false);
    } catch {
      setError(
        'Local setup could not finish. Reopen Hex Payroll and check whether you can sign in.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (required === false) return children;
  return (
    <main style={{ maxWidth: 480, margin: '8vh auto', padding: 32 }}>
      <h1>Hex Payroll</h1>
      {required === null ? (
        <p>{error || 'Checking local setup…'}</p>
      ) : (
        <>
          <h2>Create your administrator account</h2>
          <p>
            This account manages payroll on this computer. You can complete company setup after
            signing in.
          </p>
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            style={{ display: 'grid', gap: 14 }}
          >
            <label>
              Username
              <input name="username" required autoComplete="username" />
            </label>
            <label>
              Display name
              <input name="displayName" required autoComplete="name" />
            </label>
            <label>
              Email (optional)
              <input name="email" type="email" autoComplete="email" />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                minLength={15}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <label>
              Confirm password
              <input
                name="confirmation"
                type="password"
                required
                minLength={15}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button disabled={busy} type="submit">
              {busy ? 'Creating account…' : 'Create administrator'}
            </button>
          </form>
        </>
      )}
    </main>
  );
}

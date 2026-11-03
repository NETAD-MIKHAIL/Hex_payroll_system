import { useEffect, useState, type ReactNode, type FormEvent } from 'react';

export function DesktopSetup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'setup' | 'ready'>(
    window.hexpayroll?.privateRuntime ? 'checking' : 'ready',
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!window.hexpayroll?.privateRuntime) return;
    void fetch('/api/desktop/status', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value) => setStatus(value.needsAdministrator ? 'setup' : 'ready'))
      .catch(() => setError('Local setup could not be checked. Close and reopen Hex Payroll.'));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const fields = new FormData(event.currentTarget);
    if (fields.get('password') !== fields.get('confirm')) {
      setError('Passwords must match.');
      setBusy(false);
      return;
    }
    try {
      const response = await fetch('/api/desktop/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: fields.get('username'),
          displayName: fields.get('displayName'),
          password: fields.get('password'),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const value = await response.json();
        throw new Error(value.error ?? 'Setup failed');
      }
      setStatus('ready');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }
  if (status === 'ready') return children;
  return (
    <main className="p-8 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold">Set up Hex Payroll</h1>
      {status === 'checking' ? (
        <p>Checking local installation...</p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 mt-6">
          <p>
            Create this PC's first administrator. Keep the password in a safe place, then sign in to
            complete company setup.
          </p>
          <label>
            Username
            <input
              className="credential-input"
              name="username"
              required
              pattern="[A-Za-z0-9._-]{3,64}"
              autoComplete="username"
            />
          </label>
          <label>
            Display name
            <input className="credential-input" name="displayName" required maxLength={128} />
          </label>
          <label>
            Password
            <input
              className="credential-input"
              type="password"
              name="password"
              required
              minLength={14}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <label>
            Confirm password
            <input
              className="credential-input"
              type="password"
              name="confirm"
              required
              minLength={14}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <button
            className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={busy}
          >
            {busy ? 'Creating administrator...' : 'Create administrator'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

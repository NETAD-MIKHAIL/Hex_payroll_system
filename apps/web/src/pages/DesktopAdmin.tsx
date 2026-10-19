import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';

export function DesktopAdmin() {
  const { session } = useAuth();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    setMessage('');
    try {
      const form = new FormData(event.currentTarget);
      const file = form.get('credential');
      if (!(file instanceof File) || file.size > 16384) throw new Error();
      const response = await fetch('hexpayroll://app/api/desktop/admin/import', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: String(form.get('endpoint')).trim(),
          credential: JSON.parse(await file.text()),
          enable: form.get('enable') === 'on',
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) throw new Error();
      setMessage(
        'Configuration saved. Close this utility and launch Hex Payroll normally. Remove the transferred credential file securely.',
      );
    } catch {
      setMessage(
        'Import failed. Check your administrator session, HTTPS endpoint, organization identity and credential file. Retry with the same credential after reviewing configuration.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!session?.user.roles?.includes('administrator'))
    return <p role="alert">Sign in as a local administrator to configure this installation.</p>;
  return (
    <section>
      <h1>Desktop administration</h1>
      <p>
        Import a device credential issued through the existing central administration workflow.
        Background workers are paused in this utility.
      </p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        style={{ display: 'grid', gap: 16, maxWidth: 600 }}
      >
        <label>
          Central HTTPS endpoint
          <input name="endpoint" type="url" required placeholder="https://payroll.example.com" />
        </label>
        <label>
          Device credential file
          <input name="credential" type="file" accept="application/json,.json" required />
        </label>
        <label>
          <input type="checkbox" name="enable" /> Enable synchronization on the next normal launch
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Import configuration'}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { foundationRequest } from '../api/foundation';

export function DesktopEnrollment() {
  const { session } = useAuth();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  if (!window.hexpayroll?.privateRuntime || !session?.user.roles?.includes('administrator'))
    return null;
  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    setBusy(true);
    const form = event.currentTarget;
    try {
      const fields = new FormData(form);
      const file = fields.get('registration') as File;
      if (!file || file.size > 8192)
        throw new Error('Choose a per-PC registration file smaller than 8 KB.');
      await foundationRequest(
        'desktop/enroll',
        session!.accessToken,
        'POST',
        { ...JSON.parse(await file.text()), url: fields.get('endpoint') },
        20_000,
      );
      form.reset();
      setNotice(
        'Registration stored securely. Close and reopen Hex Payroll to start synchronization.',
      );
    } catch {
      setNotice('Registration failed. Check the file, local organization and existing enrollment.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel p-5 space-y-3">
      <h2>Enroll this PC</h2>
      <p>
        Obtain a separate registration file for this PC from your central administrator. The
        organization must match this installation. Keep the file private and remove your transfer
        copy after enrollment.
      </p>
      <form onSubmit={(event) => void enroll(event)}>
        <label>
          Central HTTPS API endpoint
          <input
            className="credential-input"
            name="endpoint"
            type="url"
            required
            placeholder="https://payroll.example.com"
            disabled={busy}
          />
        </label>
        <label>
          Per-PC registration{' '}
          <input
            name="registration"
            type="file"
            accept="application/json,.json"
            required
            disabled={busy}
          />
        </label>
        <button
          className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Enroll PC'}
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

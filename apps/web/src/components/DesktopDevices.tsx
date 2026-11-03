import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { foundationRequest } from '../api/foundation';

export function DesktopDevices() {
  const { session } = useAuth();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  if (!window.hexpayroll?.privateRuntime || !session?.user.roles?.includes('administrator'))
    return null;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    const fields = new FormData(event.currentTarget);
    try {
      await foundationRequest(
        'desktop/device-connections',
        session!.accessToken,
        'POST',
        {
          deviceId: fields.get('deviceId'),
          ipAddress: fields.get('ipAddress'),
          port: Number(fields.get('port')),
          protocol: 'manual-unverified',
          captureEnabled: false,
        },
        20_000,
      );
      setNotice(
        'Connection details saved on this PC. Capture remains disabled pending protocol verification and authorization.',
      );
    } catch {
      setNotice(
        'Could not save. Check the active device UUID, IP address, port and administrator permissions.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel p-5 space-y-3">
      <h2>Manual device connection</h2>
      <p>
        No discovery protocol has been verified on supported hardware. Register a device above, then
        save its connection details. This does not start polling or certify the device.
      </p>
      <form className="grid gap-3" onSubmit={(event) => void save(event)}>
        <label>
          Registered device UUID
          <input className="credential-input" name="deviceId" required />
        </label>
        <label>
          IPv4 address
          <input className="credential-input" name="ipAddress" required />
        </label>
        <label>
          Port
          <input
            className="credential-input"
            name="port"
            type="number"
            min={1}
            max={65535}
            required
          />
        </label>
        <button
          className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={busy}
        >
          Save connection details
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

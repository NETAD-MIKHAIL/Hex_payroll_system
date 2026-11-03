import { safeStorage } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface PrivateSettings {
  installationId: string;
  administratorPassword: string;
  migratorPassword: string;
  applicationPassword: string;
  sync?: { url: string; nodeId: string; token: string; organizationId: string; deviceName: string };
  deviceConnections?: {
    deviceId: string;
    ipAddress: string;
    port: number;
    protocol: 'manual-unverified';
    captureEnabled: false;
  }[];
}

export async function protectDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') throw new Error('Private runtime requires Windows');
  // Use the token's SID, rather than an ambiguous/localized account name.
  const { stdout } = await promisify(execFile)('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  });
  const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
  if (!sid) throw new Error('Cannot identify Windows account');
  await promisify(execFile)(
    'icacls.exe',
    [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { windowsHide: true },
  );
}

export async function saveSettings(directory: string, settings: PrivateSettings): Promise<void> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows credential protection unavailable');
  const target = join(directory, 'credentials.dpapi');
  await writeFile(target + '.new', safeStorage.encryptString(JSON.stringify(settings)), {
    mode: 0o600,
  });
  await rename(target + '.new', target);
}

export async function loadSettings(directory: string): Promise<PrivateSettings> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows credential protection unavailable');
  try {
    const settings = JSON.parse(
      safeStorage.decryptString(await readFile(join(directory, 'credentials.dpapi'))),
    ) as PrivateSettings;
    if (
      !/^[a-f0-9-]{36}$/.test(settings.installationId) ||
      ![
        settings.administratorPassword,
        settings.migratorPassword,
        settings.applicationPassword,
      ].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value))
    )
      throw new Error('Invalid protected settings');
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Cannot read protected credentials; no data was reset', { cause: error });
    // A lost credential file must never silently adopt or reinitialize an existing cluster.
    try {
      await readFile(join(directory, 'cluster-owner.json'));
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      const secret = () => randomBytes(32).toString('base64url');
      const settings: PrivateSettings = {
        installationId: randomUUID(),
        administratorPassword: secret(),
        migratorPassword: secret(),
        applicationPassword: secret(),
      };
      await saveSettings(directory, settings);
      return settings;
    }
    throw new Error(
      'Cluster credentials are missing; restore protected credentials with operator assistance',
      { cause: error },
    );
  }
}

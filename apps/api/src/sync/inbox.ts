import type { Pool, PoolClient } from 'pg';
import { requireBroadStreamsDisabled } from './pilot-scope.js';
import { transaction } from '../foundation/repository.js';
import { applyOrganizationEvent } from './organization-inbox.js';
import { applyDepartmentEvent } from './department-inbox.js';
import { applyPositionEvent } from './position-inbox.js';
import { applyEmployeeEvent } from './employee-inbox.js';
import { applyBiometricDeviceEvent } from './biometric-device-inbox.js';
import { applyBiometricMappingEvent } from './biometric-mapping-inbox.js';
import { applyTimeRecordEvent } from './time-record-inbox.js';
import { applyTimeRecordCorrectionEvent } from './time-record-correction-inbox.js';

interface InboxEvent {
  entity_type: string;
  organization_id: string;
  sequence: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}
class ApplicationRejected extends Error {}
const reject = (message: string): never => {
  throw new ApplicationRejected(message);
};

export async function applyAccountEvent(client: PoolClient, event: InboxEvent) {
  void event;
  void client;
  reject('Generic account distribution is suspended; use trusted identity publication');
}

export async function applyInboxBatch(pool: Pool, organizationId: string) {
  await requireBroadStreamsDisabled(pool);
  return transaction(pool, async (client) => {
    const setup = await client.query(
      'SELECT organization_id FROM application_setup WHERE singleton',
    );

    if (setup.rows[0]?.organization_id !== organizationId)
      throw new Error('Inbox organization does not match installation');

    // Serialize inbox application for this organization.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'sync_inbox:' + organizationId,
    ]);

    // Select a bounded candidate set once per batch.
    // An earlier unapplied event for the same entity blocks
    // later revisions, but not independent entities.
    const batch = await client.query<InboxEvent>(
      `SELECT i.*
       FROM sync_inbox i
       WHERE i.organization_id = $1
         AND i.applied_at IS NULL
         AND (i.entity_type<>'auth_users' OR i.apply_error IS DISTINCT FROM 'Generic account distribution is suspended; use trusted identity publication')
         AND i.entity_type IN ('organizations', 'auth_users', 'departments', 'positions', 'employees', 'biometric_devices', 'biometric_mappings', 'time_records', 'time_record_corrections')
         AND NOT EXISTS (
           SELECT 1
           FROM sync_inbox earlier
           WHERE earlier.organization_id = i.organization_id
             AND earlier.entity_type = i.entity_type
             AND earlier.entity_id = i.entity_id
             AND earlier.applied_at IS NULL
             AND earlier.sequence < i.sequence
         )
       ORDER BY i.sequence
       LIMIT 20
       FOR UPDATE OF i`,
      [organizationId],
    );

    let applied = 0;
    let deferred = 0;

    for (const event of batch.rows) {
      await client.query('SAVEPOINT apply_event');

      let error: string | null = null;

      try {
        if (event.entity_type === 'organizations') {
          await applyOrganizationEvent(client, event);
        } else if (event.entity_type === 'auth_users') {
          await applyAccountEvent(client, event);
        } else if (event.entity_type === 'departments') {
          await applyDepartmentEvent(client, event);
        } else if (event.entity_type === 'positions') {
          await applyPositionEvent(client, event);
        } else if (event.entity_type === 'employees') {
          await applyEmployeeEvent(client, event);
        } else if (event.entity_type === 'biometric_devices') {
          await applyBiometricDeviceEvent(client, event);
        } else if (event.entity_type === 'biometric_mappings') {
          await applyBiometricMappingEvent(client, event);
        } else if (event.entity_type === 'time_records') {
          await applyTimeRecordEvent(client, event);
        } else if (event.entity_type === 'time_record_corrections') {
          await applyTimeRecordCorrectionEvent(client, event);
        }

        await client.query(
          `UPDATE sync_inbox
           SET applied_at = now(),
               apply_error = NULL
           WHERE organization_id = $1
             AND sequence = $2`,
          [organizationId, event.sequence],
        );

        applied++;
      } catch (cause) {
        await client.query('ROLLBACK TO SAVEPOINT apply_event');

        error =
          cause instanceof ApplicationRejected
            ? cause.message
            : 'Inbox event application failed; review local constraints and retry';

        deferred++;
      }

      await client.query('RELEASE SAVEPOINT apply_event');

      await client.query(
        `UPDATE sync_inbox
         SET apply_attempt_count = apply_attempt_count + 1,
             last_apply_attempt_at = now(),
             apply_error = $3
         WHERE organization_id = $1
           AND sequence = $2`,
        [organizationId, event.sequence, error],
      );
    }

    return {
      applied,
      pending: batch.rows.length - applied,
      deferred,
    };
  });
}

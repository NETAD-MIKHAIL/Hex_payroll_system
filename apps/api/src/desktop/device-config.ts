import { z } from 'zod';

/** Inventory only. No protocol is certified and this does not enable capture. */
export const manualDeviceConnectionSchema = z
  .object({
    deviceId: z.uuid(),
    ipAddress: z.ipv4(),
    port: z.number().int().min(1).max(65535),
    protocol: z.literal('manual-unverified'),
    captureEnabled: z.literal(false),
  })
  .strict();
export type ManualDeviceConnection = z.infer<typeof manualDeviceConnectionSchema>;
export interface DesktopDeviceConfiguration {
  list(): ManualDeviceConnection[];
  save(input: ManualDeviceConnection): Promise<void>;
}

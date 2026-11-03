import { z } from 'zod';
import type { Pool } from 'pg';
import { nodeCredentialSchema } from '../sync/administration.js';
import { importLocalNode } from '../sync/import-node.js';

export const desktopEnrollmentSchema = nodeCredentialSchema
  .extend({ url: z.url() })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /\s/.test(value.url)
    )
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Use an HTTPS central API without embedded credentials',
      });
  });
export type DesktopEnrollment = z.infer<typeof desktopEnrollmentSchema>;

export async function recordDesktopEnrollment(pool: Pool, input: DesktopEnrollment) {
  const { url: _endpoint, ...credential } = input;
  await importLocalNode(pool, credential);
}

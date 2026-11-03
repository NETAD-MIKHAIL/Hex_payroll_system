import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * `dotenv` resolves `.env` relative to the process working directory. pnpm runs
 * package scripts with the working directory set to the package folder, so this
 * reads `apps/api/.env`, which is gitignored. `apps/api/.env.example` is the
 * committed template.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** Loopback by default: the desktop API must not be reachable from the network. */
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(0).max(65535).default(4311),
    HEX_PRIVATE_API_TOKEN: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    HEX_RENDERER_ORIGIN: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/)
      .optional(),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Runtime role: DML only, no DDL privileges. */
    DATABASE_URL: z.string().min(1),

    /**
     * Migration role: owns the schema and applies `database/migrations/*.sql`.
     * Optional because the running API never needs it — only the Phase 1 runner does.
     */
    MIGRATION_DATABASE_URL: z.string().min(1).optional(),
    SYNC_MODE: z.enum(['disabled', 'local', 'central']).default('disabled'),
    ATTENDANCE_FINALIZATION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CENTRAL_ATTENDANCE_WRITER_DATABASE_URL: z.string().min(1).optional(),
    SYNC_BIOMETRIC_EVIDENCE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SYNC_TRUSTED_EVIDENCE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SYNC_CENTRAL_URL: z.url().optional(),
    SYNC_NODE_ID: z.uuid().optional(),
    SYNC_NODE_TOKEN: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
  })
  .superRefine((value, ctx) => {
    if (
      value.HEX_PRIVATE_API_TOKEN &&
      (value.API_HOST !== '127.0.0.1' ||
        !value.HEX_RENDERER_ORIGIN ||
        value.SYNC_MODE === 'central')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['HEX_PRIVATE_API_TOKEN'],
        message: 'Private API requires loopback, renderer origin and local mode',
      });
    if (value.API_PORT === 0 && !value.HEX_PRIVATE_API_TOKEN)
      ctx.addIssue({
        code: 'custom',
        path: ['API_PORT'],
        message: 'Ephemeral port requires private desktop mode',
      });
    if (value.ATTENDANCE_FINALIZATION_ENABLED) {
      if (value.SYNC_MODE === 'disabled')
        ctx.addIssue({
          code: 'custom',
          path: ['ATTENDANCE_FINALIZATION_ENABLED'],
          message: 'Requires local or central sync mode',
        });
      if (!value.SYNC_BIOMETRIC_EVIDENCE_ENABLED)
        ctx.addIssue({
          code: 'custom',
          path: ['SYNC_BIOMETRIC_EVIDENCE_ENABLED'],
          message: 'Required for source certification',
        });
      if (value.SYNC_MODE === 'local' && !value.SYNC_TRUSTED_EVIDENCE_ENABLED)
        ctx.addIssue({
          code: 'custom',
          path: ['SYNC_TRUSTED_EVIDENCE_ENABLED'],
          message: 'Required for trusted attendance delivery',
        });
      if (value.SYNC_MODE === 'central' && !value.CENTRAL_ATTENDANCE_WRITER_DATABASE_URL)
        ctx.addIssue({
          code: 'custom',
          path: ['CENTRAL_ATTENDANCE_WRITER_DATABASE_URL'],
          message: 'Separate central attendance writer required',
        });
    }
    if (value.SYNC_MODE !== 'local') return;
    for (const key of ['SYNC_CENTRAL_URL', 'SYNC_NODE_ID', 'SYNC_NODE_TOKEN'] as const)
      if (!value[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'Required for local sync' });
    if (value.SYNC_CENTRAL_URL) {
      const u = new URL(value.SYNC_CENTRAL_URL);
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        (u.protocol !== 'https:' &&
          !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['SYNC_CENTRAL_URL'],
          message:
            'Use HTTPS, or loopback HTTP for development, without URL credentials/query/fragment',
        });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Report every problem at once. An API that boots half-configured and fails
    // later, mid-payroll, is far worse than one that refuses to start.
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    process.stderr.write(`Invalid environment configuration:\n${details}\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

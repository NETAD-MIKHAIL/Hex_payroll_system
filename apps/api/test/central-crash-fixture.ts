import { createServer } from 'node:http';
import pg from 'pg';
import { pushEvents } from '../src/sync/service.js';
// Child-process fault injection: exit after durable commit, before HTTP receipt.
const pool = new pg.Pool({
  connectionString: process.env.CRASH_TEST_DATABASE_URL,
  options: process.env.CRASH_TEST_DATABASE_OPTIONS,
});
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    await pushEvents(pool, token, JSON.parse(Buffer.concat(chunks).toString()));
    process.exit(0);
  } catch {
    res.statusCode = 500;
    res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  const a = server.address();
  if (a && typeof a !== 'string') process.stdout.write(String(a.port) + '\n');
});

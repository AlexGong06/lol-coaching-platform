// Applies every migrations/*.sql not yet recorded in schema_migrations, in order,
// each inside its own transaction. No framework: an engineer reading this repo can
// see exactly what runs against the database.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is unset. Copy .env.example and point it at any PostgreSQL 16+.');
  process.exit(2);
}

const dir = join(import.meta.dirname, '..', 'migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
const applied = new Set(rows.map((r) => r.filename));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(join(dir, file), 'utf8');
  process.stdout.write(`applying ${file} ... `);
  try {
    // Each migration file carries its own BEGIN/COMMIT.
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log('ok');
    count++;
  } catch (err) {
    console.log('FAILED');
    console.error(`\n${(err as Error).message}\n`);
    await client.end();
    process.exit(1);
  }
}

console.log(count === 0 ? 'nothing to apply' : `${count} migration(s) applied`);
await client.end();

/**
 * Print migration instructions and list migration files.
 * Run SQL in Supabase Dashboard: Project → SQL Editor → paste contents of each file in order.
 * Or use Supabase CLI: supabase db push (with migrations in supabase/migrations/).
 */
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'supabase', 'migrations');

async function run() {
  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();
  console.log('Run these migrations in order in Supabase Dashboard → SQL Editor:\n');
  for (const f of sqlFiles) {
    const path = join(migrationsDir, f);
    const sql = await readFile(path, 'utf8');
    console.log('---', f, '---');
    console.log(sql.slice(0, 300) + (sql.length > 300 ? '...' : ''));
    console.log('');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

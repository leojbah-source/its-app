// backend/scripts/run-migrations.js
// Applies every SQL file in db/migrations/ (in name order) to the database
// configured in backend/.env. All migrations are idempotent, so re-running
// this script is always safe.
//
// Usage:  cd C:\ITS-APP\backend
//         node scripts/run-migrations.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) { console.log('No migration files found.'); return; }

  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  console.log(`Connected to ${process.env.DB_NAME} at ${process.env.DB_HOST}:${process.env.DB_PORT || 5432}`);

  for (const f of files) {
    process.stdout.write(`Applying ${f} ... `);
    try {
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log('OK');
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${err.message}`);
      await client.query('ROLLBACK').catch(() => null);
      process.exitCode = 1;
      break;
    }
  }
  await client.end();
})();

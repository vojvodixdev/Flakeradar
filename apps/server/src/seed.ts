/**
 * Loads demo projects so the dashboard has something to show.
 *
 *   npm run seed            add demo projects to the configured database
 *   npm run seed -- --reset delete the database first
 */
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { seedDemo } from './demo-data.js';

const config = loadConfig();
if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.databasePath + suffix, { force: true });
}
const db = openDatabase(config.databasePath);

const started = Date.now();
const seeded = seedDemo(db);
db.close();

console.log(`Seeded demo data into ${config.databasePath} in ${Date.now() - started} ms\n`);
console.log('Upload tokens (shown once):');
for (const { project, token } of seeded) console.log(`  ${project.name.padEnd(18)} ${token}`);

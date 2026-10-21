/**
 * Captures the API responses of a freshly seeded server into one JSON file,
 * so the dashboard can be published as a static demo without a backend.
 *
 *   tsx src/export-demo.ts [output.json]
 *
 * Used by `npm run build:demo` at the repository root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoSnapshot } from '@flakeradar/core';
import { openDatabase } from './db.js';
import { seedDemo } from './demo-data.js';
import { listProjects, listRuns, listTests, projectOverview, testDetail } from './queries.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(here, '../../web/src/demo/snapshot.json'));

const db = openDatabase(':memory:');
const seeded = seedDemo(db);
const generatedAt = Date.now();

const snapshot: DemoSnapshot = { generatedAt, projects: listProjects(db), byProject: {} };
for (const { project } of seeded) {
  const tests = listTests(db, project.id, { sort: 'attention', limit: 1000 });
  snapshot.byProject[project.slug] = {
    overview: projectOverview(db, project, 30, generatedAt),
    tests,
    runs: listRuns(db, project.id, 100),
    details: Object.fromEntries(tests.map((t) => [String(t.id), testDetail(db, project.id, t.id, 100)])),
  };
}
db.close();

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(snapshot));
console.log(`Wrote demo snapshot (${Math.round(fs.statSync(output).size / 1024)} KB) to ${output}`);

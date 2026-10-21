// FlakeRadar uploader.
//
// Finds JUnit XML reports, sends them to a FlakeRadar server and, on GitHub
// pull requests, posts or updates a comment with the verdicts.
//
// Plain Node (>= 18) with no dependencies. The FlakeRadar server serves this
// file at /api/uploader.mjs, so a CI job only needs:
//
//   curl -fsSL "$FLAKERADAR_SERVER_URL/api/uploader.mjs" -o flakeradar.mjs
//   node flakeradar.mjs
//
// Configuration (environment variables):
//   FLAKERADAR_SERVER_URL     required  base URL of the server
//   FLAKERADAR_TOKEN          required  the project's upload token
//   FLAKERADAR_JUNIT_PATHS    optional  globs, newline or comma separated (default **/junit*.xml)
//   FLAKERADAR_GITHUB_TOKEN   optional  enables the pull request comment on GitHub Actions
//   FLAKERADAR_COMMENT        optional  "false" disables the comment
//   FLAKERADAR_DEFAULT_BRANCH optional  e.g. main (detected on GitHub and GitLab)
//   FLAKERADAR_FAIL_ON_ERROR  optional  "true" makes upload errors fail the job
//   FLAKERADAR_COMMIT, FLAKERADAR_BRANCH  optional, for CI systems that are not detected
import fs from 'node:fs';
import path from 'node:path';

const COMMENT_MARKER = '<!-- flakeradar-comment -->';
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.gradle']);

const env = process.env;
const onGitHub = env.GITHUB_ACTIONS === 'true';
const failOnError = env.FLAKERADAR_FAIL_ON_ERROR === 'true';

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (failOnError) {
    log('error', message);
    process.exit(1);
  }
  log('warning', `${message} (the build continues; set FLAKERADAR_FAIL_ON_ERROR=true to change this)`);
});

async function main() {
  const serverUrl = (env.FLAKERADAR_SERVER_URL ?? '').replace(/\/+$/, '');
  if (!serverUrl) throw new Error('FLAKERADAR_SERVER_URL is not set');
  if (!env.FLAKERADAR_TOKEN) throw new Error('FLAKERADAR_TOKEN is not set');

  const ci = detectCi();
  if (!ci.commitSha || !ci.branch) {
    throw new Error('Could not detect the commit and branch. Set FLAKERADAR_COMMIT and FLAKERADAR_BRANCH.');
  }

  const workspace = env.GITHUB_WORKSPACE ?? env.CI_PROJECT_DIR ?? process.cwd();
  const patterns = (env.FLAKERADAR_JUNIT_PATHS || '**/junit*.xml')
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const files = findFiles(workspace, patterns);
  if (files.length === 0) {
    throw new Error(`No JUnit files matched ${patterns.join(', ')}. Is your test runner writing JUnit XML?`);
  }
  console.log(`Found ${files.length} JUnit report(s):\n  ${files.map((f) => path.relative(workspace, f)).join('\n  ')}`);

  const body = JSON.stringify({ ...ci, reports: files.map((f) => fs.readFileSync(f, 'utf8')) });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new Error('The reports are larger than 24 MB. Narrow FLAKERADAR_JUNIT_PATHS to the files you need.');
  }

  const res = await fetch(`${serverUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.FLAKERADAR_TOKEN}` },
    body,
  });
  const result = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Upload failed with ${res.status}: ${result?.message ?? res.statusText}`);
  }

  const noise = result.failures.filter(
    (f) => f.quarantined || f.verdict === 'known-flaky' || f.verdict === 'flaky-retry-passed',
  ).length;
  const real = result.failures.length - noise;
  console.log(
    `Uploaded run ${result.runId}: ${result.summary.total} tests, ${real} real failure(s), ${noise} flaky failure(s).`,
  );

  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `real-failures=${real}\nflaky-failures=${noise}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.comment}\n`);

  if (ci.prNumber && onGitHub && env.FLAKERADAR_COMMENT !== 'false') {
    await upsertGitHubComment(ci.prNumber, result.comment);
  }
}

/** Reads run metadata from the CI environment. */
function detectCi() {
  if (onGitHub) {
    const event = readJson(env.GITHUB_EVENT_PATH);
    return {
      // For pull_request events GITHUB_SHA is the merge commit that was
      // actually tested, which is what "same code" should mean for flakiness.
      commitSha: env.FLAKERADAR_COMMIT || env.GITHUB_SHA,
      branch: env.FLAKERADAR_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      defaultBranch: env.FLAKERADAR_DEFAULT_BRANCH || event?.repository?.default_branch || undefined,
      repository: env.GITHUB_REPOSITORY,
      ciRunId: env.GITHUB_RUN_ID,
      ciRunAttempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
      prNumber: event?.pull_request?.number,
      workflow: env.GITHUB_WORKFLOW,
    };
  }
  if (env.GITLAB_CI === 'true') {
    return {
      commitSha: env.FLAKERADAR_COMMIT || env.CI_COMMIT_SHA,
      branch: env.FLAKERADAR_BRANCH || env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME,
      defaultBranch: env.FLAKERADAR_DEFAULT_BRANCH || env.CI_DEFAULT_BRANCH || undefined,
      ciRunId: env.CI_PIPELINE_ID,
      ciRunAttempt: 1,
      workflow: env.CI_JOB_NAME,
    };
  }
  return {
    commitSha: env.FLAKERADAR_COMMIT,
    branch: env.FLAKERADAR_BRANCH,
    defaultBranch: env.FLAKERADAR_DEFAULT_BRANCH || undefined,
  };
}

/** Updates our previous comment on the pull request, or creates one. */
async function upsertGitHubComment(prNumber, markdown) {
  const token = env.FLAKERADAR_GITHUB_TOKEN;
  if (!token) {
    console.log('No FLAKERADAR_GITHUB_TOKEN, skipping the pull request comment.');
    return;
  }
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const repo = env.GITHUB_REPOSITORY;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };

  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const res = await fetch(`${api}/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) break;
    const comments = await res.json();
    existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER)) ?? null;
    if (comments.length < 100) break;
  }

  const url = existing
    ? `${api}/repos/${repo}/issues/comments/${existing.id}`
    : `${api}/repos/${repo}/issues/${prNumber}/comments`;
  const res = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers,
    body: JSON.stringify({ body: markdown }),
  });

  if (res.status === 403 || res.status === 404) {
    // Pull requests from forks get a read-only token. The results are still
    // in the job summary and the dashboard.
    log(
      'notice',
      'Could not comment on the pull request (missing pull-requests: write permission, or a fork). Results are in the job summary.',
    );
    return;
  }
  if (!res.ok) throw new Error(`Commenting on the pull request failed with ${res.status}`);
  console.log(`${existing ? 'Updated' : 'Posted'} the pull request comment.`);
}

function log(level, message) {
  console.log(onGitHub ? `::${level} title=FlakeRadar::${message}` : `FlakeRadar ${level}: ${message}`);
}

function readJson(file) {
  try {
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Minimal glob support: `**`, `*`, `?`. Enough for report paths, no dependency needed. */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function findFiles(root, patterns) {
  const regexes = patterns.map((p) => globToRegExp(p.replace(/^\.\//, '')));
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (regexes.some((r) => r.test(rel))) found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

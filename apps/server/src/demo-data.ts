/**
 * Realistic demo data, used by `npm run seed` and by the static demo build.
 *
 * The data is produced the same way real data is: by generating JUnit XML
 * reports and feeding them through the normal ingestion pipeline.
 */
import type { DB } from './db.js';
import { ingestRun } from './ingest.js';
import { createProject, type ProjectRow } from './projects.js';

type Behaviour =
  | { kind: 'stable' }
  | { kind: 'flaky'; p: number }
  /** Fails deterministically from this main-branch run onwards. */
  | { kind: 'broken'; from: number }
  /** Failed for a while on main, then got fixed. */
  | { kind: 'regression'; from: number; to: number };

interface DemoTest {
  classname: string;
  name: string;
  file: string;
  e2e: boolean;
  baseMs: number;
  behaviour: Behaviour;
  messages: string[];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261021);
const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
const sha = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');

const TIMEOUTS = [
  "TimeoutError: locator.click: Timeout 5000ms exceeded waiting for getByRole('button', { name: 'Pay now' })",
  "TimeoutError: page.waitForURL: Timeout 10000ms exceeded waiting for '**/order/confirmed'",
];
const NETWORK = ['Error: socket hang up (ECONNRESET)', 'FetchError: request to http://localhost:4010/stock failed, reason: ECONNREFUSED'];
const RACES = [
  "AssertionError: expected order status 'paid' but got 'pending'",
  'AssertionError: expected [ 3 items ] to have a length of 4 but got 3',
  'Error: Unique constraint failed on the fields: (`email`)',
];
const CLOCK = ['AssertionError: expected "2026-03-29T01:00:00Z" to equal "2026-03-29T02:00:00Z"'];

function storefrontTests(): DemoTest[] {
  const t = (
    classname: string,
    file: string,
    names: string[],
    opts: Partial<Pick<DemoTest, 'e2e' | 'baseMs'>> = {},
  ): DemoTest[] =>
    names.map((name) => ({
      classname,
      name,
      file,
      e2e: opts.e2e ?? false,
      baseMs: opts.baseMs ?? 20 + Math.floor(rand() * 120),
      behaviour: { kind: 'stable' },
      messages: [],
    }));

  const tests = [
    ...t('CartService', 'src/cart/cart.service.test.ts', [
      'adds an item to an empty cart',
      'merges duplicate items',
      'removes an item',
      'applies a percentage coupon',
      'rejects an expired coupon',
      'recalculates totals after currency change',
      'persists the cart for logged-in users',
    ]),
    ...t('PricingEngine', 'src/pricing/engine.test.ts', [
      'applies VAT by shipping country',
      'rounds half to even',
      'stacks volume discounts',
      'computes free shipping threshold',
      'handles daylight saving switch in flash sales',
    ]),
    ...t('InventorySync', 'src/inventory/sync.test.ts', [
      'reserves stock on checkout',
      'releases reservation after timeout',
      'handles concurrent reservations',
      'reconciles with warehouse feed',
    ], { baseMs: 400 }),
    ...t('AuthController', 'src/auth/auth.controller.test.ts', [
      'logs in with email and password',
      'rejects a wrong password',
      'locks account after 5 failed attempts',
      'refreshes an expired access token',
      'registers a new customer',
      'sends a password reset email',
    ]),
    ...t('SearchIndex', 'src/search/index.test.ts', [
      'finds products by partial name',
      'ranks exact matches first',
      'filters by price range',
      'reindexes after product update',
    ], { baseMs: 250 }),
    ...t('OrderHistory', 'src/orders/history.test.ts', [
      'lists orders newest first',
      'paginates with a cursor',
      'hides cancelled orders by default',
    ]),
    ...t('Webhooks', 'src/webhooks/stripe.test.ts', [
      'verifies the Stripe signature',
      'marks order as paid on payment_intent.succeeded',
      'is idempotent for duplicate events',
      'retries on 5xx from the order service',
    ]),
    ...t('checkout.spec.ts', 'e2e/checkout.spec.ts', [
      'guest can complete checkout with card',
      'logged-in user can reorder',
      'shows an error for a declined card',
      'applies a coupon on the payment step',
    ], { e2e: true, baseMs: 6500 }),
    ...t('catalog.spec.ts', 'e2e/catalog.spec.ts', [
      'filters products by category',
      'opens the product quick view',
      'infinite scroll loads the next page',
    ], { e2e: true, baseMs: 4200 }),
    ...t('account.spec.ts', 'e2e/account.spec.ts', [
      'updates the shipping address',
      'downloads an invoice PDF',
    ], { e2e: true, baseMs: 5100 }),
  ];

  const set = (name: string, behaviour: Behaviour, messages: string[] = []) => {
    const test = tests.find((x) => x.name === name)!;
    test.behaviour = behaviour;
    test.messages = messages;
  };

  set('guest can complete checkout with card', { kind: 'flaky', p: 0.18 }, TIMEOUTS);
  set('applies a coupon on the payment step', { kind: 'flaky', p: 0.09 }, TIMEOUTS);
  set('infinite scroll loads the next page', { kind: 'flaky', p: 0.12 }, ['AssertionError: expected 24 product cards, found 12']);
  set('downloads an invoice PDF', { kind: 'flaky', p: 0.05 }, TIMEOUTS);
  set('handles concurrent reservations', { kind: 'flaky', p: 0.14 }, RACES);
  set('reconciles with warehouse feed', { kind: 'flaky', p: 0.06 }, NETWORK);
  set('marks order as paid on payment_intent.succeeded', { kind: 'flaky', p: 0.1 }, RACES);
  set('handles daylight saving switch in flash sales', { kind: 'flaky', p: 0.035 }, CLOCK);
  set('reindexes after product update', { kind: 'flaky', p: 0.025 }, ['AssertionError: expected 1 hit, received 0']);
  set('filters by price range', { kind: 'flaky', p: 0.008 }, ['AssertionError: expected 7 results, received 6']);
  set('locks account after 5 failed attempts', { kind: 'broken', from: 132 }, [
    'AssertionError: expected response status 423 but received 401',
  ]);
  set('rounds half to even', { kind: 'regression', from: 70, to: 76 }, [
    'AssertionError: expected 10.12 to equal 10.13',
  ]);
  return tests;
}

function mobileApiTests(): DemoTest[] {
  const groups: Array<[string, string[]]> = [
    ['test_devices.DeviceRegistration', ['test_register_ios', 'test_register_android', 'test_rotate_push_token', 'test_rejects_unknown_platform']],
    ['test_feed.HomeFeed', ['test_returns_personalised_items', 'test_caches_for_60_seconds', 'test_falls_back_when_ranker_down', 'test_respects_locale']],
    ['test_sync.OfflineSync', ['test_applies_queued_mutations', 'test_resolves_conflicts_last_write_wins', 'test_handles_clock_skew', 'test_large_payload']],
    ['test_auth.Tokens', ['test_issue_token', 'test_refresh_token', 'test_revoke_all_sessions']],
  ];
  const tests: DemoTest[] = groups.flatMap(([classname, names]) =>
    names.map((name) => ({
      classname,
      name,
      file: `tests/${classname.split('.')[0]}.py`,
      e2e: false,
      baseMs: 30 + Math.floor(rand() * 200),
      behaviour: { kind: 'stable' } as Behaviour,
      messages: [],
    })),
  );
  tests.find((x) => x.name === 'test_handles_clock_skew')!.behaviour = { kind: 'flaky', p: 0.2 };
  tests.find((x) => x.name === 'test_handles_clock_skew')!.messages = CLOCK;
  tests.find((x) => x.name === 'test_caches_for_60_seconds')!.behaviour = { kind: 'flaky', p: 0.07 };
  tests.find((x) => x.name === 'test_caches_for_60_seconds')!.messages = ['AssertionError: assert 2 == 1 (ranker called twice)'];
  return tests;
}

function outcome(test: DemoTest, mainIndex: number, prBroken: Set<string>): { failed: boolean; message?: string } {
  if (prBroken.has(test.name)) return { failed: true, message: 'AssertionError: expected true to be false' };
  const b = test.behaviour;
  switch (b.kind) {
    case 'stable':
      return { failed: false };
    case 'flaky':
      return rand() < b.p ? { failed: true, message: pick(test.messages) } : { failed: false };
    case 'broken':
      return mainIndex >= b.from ? { failed: true, message: test.messages[0] } : { failed: false };
    case 'regression':
      return mainIndex >= b.from && mainIndex <= b.to ? { failed: true, message: test.messages[0] } : { failed: false };
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function report(results: Array<{ test: DemoTest; failed: boolean; message?: string }>): string {
  const bySuite = new Map<string, typeof results>();
  for (const r of results) {
    const list = bySuite.get(r.test.file) ?? [];
    list.push(r);
    bySuite.set(r.test.file, list);
  }
  const suites = [...bySuite.entries()].map(([file, list]) => {
    const cases = list.map(({ test, failed, message }) => {
      const time = ((test.baseMs * (0.8 + rand() * 0.5)) / 1000).toFixed(3);
      const attrs = `classname="${esc(test.classname)}" name="${esc(test.name)}" time="${time}"`;
      return failed
        ? `<testcase ${attrs}><failure message="${esc(message ?? 'failed')}">${esc(message ?? '')}</failure></testcase>`
        : `<testcase ${attrs}/>`;
    });
    return `<testsuite name="${esc(file)}" file="${esc(file)}" tests="${list.length}">${cases.join('')}</testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><testsuites>${suites.join('')}</testsuites>`;
}

function seedProject(
  db: DB,
  opts: { name: string; repository: string; tests: DemoTest[]; mainRuns: number; prRuns: number; e2eRetries: boolean },
): { project: ProjectRow; token: string } {
  const { project, token } = createProject(db, { name: opts.name, repository: opts.repository, defaultBranch: 'main' });

  const end = Date.now() - 20 * 60_000;
  const start = end - 42 * 86_400_000;
  const totalRuns = opts.mainRuns + opts.prRuns;
  let ciRun = 9_000_000 + Math.floor(rand() * 100_000);
  let mainIndex = 0;
  let pr = 40;
  let prCommit = sha();
  let prPushes = 0;
  let prBroken = new Set<string>();

  for (let i = 0; i < totalRuns; i++) {
    const at = start + Math.floor(((end - start) * i) / totalRuns) + Math.floor(rand() * 30 * 60_000);
    const isMain = rand() < opts.mainRuns / totalRuns;
    let branch = 'main';
    let commit = sha();
    let prNumber: number | undefined;

    if (isMain) {
      mainIndex++;
      prBroken = new Set();
    } else {
      if (prPushes === 0 || rand() < 0.35) {
        pr++;
        prPushes = 0;
        // Roughly one PR in four breaks a test on its first push and fixes it later.
        prBroken = rand() < 0.25 ? new Set([pick(opts.tests.filter((x) => !x.e2e)).name]) : new Set();
      } else if (prPushes >= 1) {
        prBroken = new Set();
      }
      prPushes++;
      prCommit = sha();
      commit = prCommit;
      branch = `feature/pr-${pr}`;
      prNumber = pr;
    }

    // A workflow can be re-run on the same commit (attempt 2) when it went red.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const results = opts.tests.map((test) => ({ test, ...outcome(test, mainIndex, prBroken) }));
      const reports = [report(results)];

      if (opts.e2eRetries) {
        // Playwright-style retries: failed e2e tests run again in the same job.
        const retried = results
          .filter((r) => r.failed && r.test.e2e)
          .map((r) => ({ test: r.test, ...outcome(r.test, mainIndex, prBroken) }));
        if (retried.length) reports.push(report(retried));
      }

      const result = ingestRun(
        db,
        project,
        {
          commitSha: commit,
          branch,
          defaultBranch: 'main',
          repository: opts.repository,
          ciRunId: String(ciRun),
          ciRunAttempt: attempt,
          prNumber,
          workflow: 'CI',
          timestamp: new Date(at + (attempt - 1) * 9 * 60_000).toISOString(),
          reports,
        },
        null,
      );

      const failedFinal = result.summary.failed > 0;
      // Developers hit "Re-run failed jobs" about half the time when CI is red.
      if (!failedFinal || attempt === 2 || rand() < 0.5) break;
    }
    ciRun++;
  }

  return { project, token };
}

/** Creates the two demo projects. Returns each project with its upload token. */
export function seedDemo(db: DB): Array<{ project: ProjectRow; token: string }> {
  return [
    seedProject(db, {
      name: 'Acme Storefront',
      repository: 'acme/storefront',
      tests: storefrontTests(),
      mainRuns: 150,
      prRuns: 110,
      e2eRetries: true,
    }),
    seedProject(db, {
      name: 'Acme Mobile API',
      repository: 'acme/mobile-api',
      tests: mobileApiTests(),
      mainRuns: 60,
      prRuns: 30,
      e2eRetries: false,
    }),
  ];
}

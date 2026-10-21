import type { ProjectOverview, RunListItem, TestListItem, TestStatus } from '@flakeradar/core';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, PROJECTS_PATH } from '../api';
import { Empty, ErrorState, Loading } from '../components/Common';
import { OutcomeStrip } from '../components/OutcomeStrip';
import { SetupInstructions } from '../components/Setup';
import { ScoreMeter, StatusDistribution, StatusPill, STATUS_LABEL, STATUS_ORDER } from '../components/Status';
import { TrendChart } from '../components/TrendChart';
import { commitUrl, dateTime, duration, percent, plural, pullUrl, shortSha, timeAgo } from '../format';
import { useAsync, useDebounced, useDocumentTitle } from '../hooks';

type Filter = TestStatus | 'quarantined' | '';

export function ProjectPage() {
  const { slug = '' } = useParams();
  const overview = useAsync(() => api.overview(slug), [slug]);
  const [params, setParams] = useSearchParams();
  useDocumentTitle(overview.data?.project.name ?? '');

  const tab = params.get('tab') === 'runs' ? 'runs' : 'tests';
  const status = (params.get('status') ?? '') as Filter;

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.reload} />;
  if (!overview.data) return <Loading what="project" />;
  const o = overview.data;
  const hasRuns = o.window.runs > 0 || o.testCount > 0;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={PROJECTS_PATH}>Projects</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1 className="page-title">{o.project.name}</h1>
          <p className="project-meta">
            {o.project.repository ? (
              <a href={`https://github.com/${o.project.repository}`} target="_blank" rel="noreferrer">
                {o.project.repository}
              </a>
            ) : (
              'No repository linked'
            )}
            <span>
              default branch <code>{o.project.defaultBranch}</code>
            </span>
          </p>
        </div>
      </div>

      {!hasRuns ? (
        <section className="panel" aria-labelledby="setup-title">
          <h2 id="setup-title">Waiting for the first run</h2>
          <SetupInstructions />
        </section>
      ) : (
        <>
          <Headline overview={o} />

          <section className="overview-grid" aria-label="Overview">
            <div className="panel">
              <h2 className="panel-title">How the suite behaves</h2>
              <StatusDistribution
                counts={o.counts}
                active={STATUS_ORDER.includes(status as TestStatus) ? (status as TestStatus) : null}
                onSelect={(s) => update({ status: s, tab: null })}
              />
            </div>
            <div className="panel">
              <TrendChart points={o.trend} />
            </div>
          </section>

          <div className="tabs" role="tablist" aria-label="Project data">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'tests'}
              className="tab"
              onClick={() => update({ tab: null })}
            >
              Tests <span className="tab-count">{o.testCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'runs'}
              className="tab"
              onClick={() => update({ tab: 'runs' })}
            >
              Runs
            </button>
          </div>

          {tab === 'tests' ? (
            <TestsTab
              slug={slug}
              status={status}
              quarantinedCount={o.quarantined}
              query={params.get('q') ?? ''}
              sort={params.get('sort') ?? 'attention'}
              onChange={update}
            />
          ) : (
            <RunsTab slug={slug} repository={o.project.repository} />
          )}
        </>
      )}
    </div>
  );
}

/** The one sentence a team lead wants to read: what flakiness cost us. */
function Headline({ overview: o }: { overview: ProjectOverview }) {
  const { runs, runsFailedByNoise, wastedMs, days } = o.window;
  const needsWork = o.counts.flaky + o.counts.broken;

  const main =
    runsFailedByNoise > 0
      ? `Flaky tests turned ${plural(runsFailedByNoise, 'run')} red in the last ${days} days, wasting about ${duration(wastedMs)} of CI time.`
      : runs > 0
        ? `No run in the last ${days} days failed because of flakiness.`
        : `No runs in the last ${days} days.`;

  const parts: string[] = [];
  if (o.counts.flaky) parts.push(`${plural(o.counts.flaky, 'test is', 'tests are')} flaky`);
  if (o.counts.broken) parts.push(`${plural(o.counts.broken, 'test is', 'tests are')} broken`);
  if (o.quarantined) parts.push(`${o.quarantined} quarantined`);
  const detail =
    needsWork > 0
      ? `${parts.join(', ')}. Fixing the top few usually removes most of the noise.`
      : `All ${plural(o.testCount, 'test')} look healthy.`;

  return (
    <section className="headline" aria-label="Summary">
      <p className="headline-main">{main}</p>
      <p className="headline-detail">{detail}</p>
    </section>
  );
}

function TestsTab({
  slug,
  status,
  quarantinedCount,
  query,
  sort,
  onChange,
}: {
  slug: string;
  status: Filter;
  quarantinedCount: number;
  query: string;
  sort: string;
  onChange: (changes: Record<string, string | null>) => void;
}) {
  const q = useDebounced(query);
  const tests = useAsync(() => api.tests(slug, { status, q, sort }), [slug, status, q, sort]);

  return (
    <section role="tabpanel" aria-label="Tests">
      <div className="toolbar">
        <label className="field field-inline field-grow">
          <span className="visually-hidden">Search tests</span>
          <input
            type="search"
            placeholder="Search by test, class or file"
            value={query}
            onChange={(e) => onChange({ q: e.target.value || null })}
          />
        </label>
        <label className="field field-inline">
          <span>Show</span>
          <select value={status} onChange={(e) => onChange({ status: e.target.value || null })}>
            <option value="">All tests</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
            {quarantinedCount > 0 && <option value="quarantined">Quarantined</option>}
          </select>
        </label>
        <label className="field field-inline">
          <span>Sort by</span>
          <select
            value={sort}
            onChange={(e) => onChange({ sort: e.target.value === 'attention' ? null : e.target.value })}
          >
            <option value="attention">Needs attention</option>
            <option value="score">Flakiness score</option>
            <option value="failures">Failures</option>
            <option value="recent">Last failed</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      {tests.error ? (
        <ErrorState error={tests.error} onRetry={tests.reload} />
      ) : !tests.data ? (
        <Loading what="tests" />
      ) : tests.data.length === 0 ? (
        <Empty title={query ? `No tests match “${query}”.` : 'No tests in this view.'} />
      ) : (
        <div className={`table-wrap${tests.loading ? ' is-refreshing' : ''}`}>
          <table className="table tests-table">
            <thead>
              <tr>
                <th scope="col">Test</th>
                <th scope="col">Status</th>
                <th scope="col">Recent runs</th>
                <th scope="col" className="num">
                  Flakiness
                </th>
                <th scope="col" className="num">
                  Failed
                </th>
                <th scope="col">Last failure</th>
              </tr>
            </thead>
            <tbody>
              {tests.data.map((t) => (
                <TestRow key={t.id} slug={slug} test={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TestRow({ slug, test: t }: { slug: string; test: TestListItem }) {
  return (
    <tr>
      <th scope="row" className="test-cell">
        <Link to={`/projects/${slug}/tests/${t.id}`} className="test-name stretched">
          {t.name}
        </Link>
        <span className="test-class">{t.classname}</span>
      </th>
      <td>
        <span className="status-cell">
          <StatusPill status={t.status} />
          {t.quarantined && <span className="tag">Quarantined</span>}
        </span>
      </td>
      <td>
        <OutcomeStrip outcomes={t.recent} />
      </td>
      <td className="num">
        <ScoreMeter score={t.score} />
      </td>
      <td className="num">
        <span title={`${t.failures} of ${t.runs} runs`}>{t.failures > 0 ? percent(t.failureRate) : '–'}</span>
      </td>
      <td className="muted">{t.lastFailedAt ? timeAgo(t.lastFailedAt) : 'Never'}</td>
    </tr>
  );
}

function RunsTab({ slug, repository }: { slug: string; repository: string | null }) {
  const runs = useAsync(() => api.runs(slug), [slug]);
  if (runs.error) return <ErrorState error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <Loading what="runs" />;

  return (
    <section role="tabpanel" aria-label="Runs">
      <div className="table-wrap">
        <table className="table runs-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Branch</th>
              <th scope="col">Commit</th>
              <th scope="col">Result</th>
              <th scope="col">Diagnosis</th>
              <th scope="col" className="num">
                Test time
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <RunRow key={r.id} run={r} repository={repository} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RunRow({ run: r, repository }: { run: RunListItem; repository: string | null }) {
  const commit = commitUrl(repository, r.commitSha);
  const pr = r.prNumber ? pullUrl(repository, r.prNumber) : null;
  const failedTests = r.noiseFailures + r.realFailures;

  let diagnosis: { text: string; tone: string };
  if (failedTests === 0) diagnosis = { text: 'All passed', tone: 'ok' };
  else if (r.realFailures === 0) diagnosis = { text: `Only flakiness (${failedTests})`, tone: 'noise' };
  else if (r.noiseFailures === 0) diagnosis = { text: plural(r.realFailures, 'real failure'), tone: 'real' };
  else diagnosis = { text: `${plural(r.realFailures, 'real failure')}, ${r.noiseFailures} flaky`, tone: 'real' };

  return (
    <tr>
      <td title={dateTime(r.createdAt)}>
        {timeAgo(r.createdAt)}
        {r.ciRunAttempt > 1 && <span className="tag">re-run {r.ciRunAttempt}</span>}
      </td>
      <td>
        <span className="branch">
          <code>{r.branch}</code>
          {r.prNumber &&
            (pr ? (
              <a href={pr} target="_blank" rel="noreferrer">
                #{r.prNumber}
              </a>
            ) : (
              <span>#{r.prNumber}</span>
            ))}
        </span>
      </td>
      <td>
        {commit ? (
          <a href={commit} target="_blank" rel="noreferrer" className="sha">
            {shortSha(r.commitSha)}
          </a>
        ) : (
          <code className="sha">{shortSha(r.commitSha)}</code>
        )}
      </td>
      <td>
        <span className="run-result">
          <span className={r.failed > 0 ? 'result-red' : 'result-green'}>{r.failed > 0 ? 'Failed' : 'Passed'}</span>
          <span className="muted">
            {r.passed}/{r.total}
          </span>
        </span>
      </td>
      <td>
        <span className={`diagnosis diagnosis-${diagnosis.tone}`}>{diagnosis.text}</span>
      </td>
      <td className="num muted">{duration(r.durationMs)}</td>
    </tr>
  );
}

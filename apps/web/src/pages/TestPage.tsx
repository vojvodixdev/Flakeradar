import type { HistoryEntry, TestDetail } from '@flakeradar/core';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, PROJECTS_PATH } from '../api';
import { ErrorState, Loading } from '../components/Common';
import { ScoreMeter, StatusPill, STATUS_HELP } from '../components/Status';
import { commitUrl, dateTime, duration, percent, plural, pullUrl, shortSha, timeAgo } from '../format';
import { useAsync, useDocumentTitle } from '../hooks';

const VERDICT_TEXT: Record<NonNullable<HistoryEntry['verdict']>, string> = {
  'likely-regression': 'Reported as a likely regression',
  'possibly-flaky': 'Reported as possibly flaky',
  'known-broken': 'Reported as already broken',
  'known-flaky': 'Reported as known flakiness',
  'flaky-retry-passed': 'Passed on retry in the same run',
};

export function TestPage() {
  const { slug = '', testId = '' } = useParams();
  const id = Number(testId);
  const test = useAsync(() => api.test(slug, id), [slug, id]);
  const overview = useAsync(() => api.overview(slug), [slug]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useDocumentTitle(test.data?.name ?? '');

  if (test.error) return <ErrorState error={test.error} onRetry={test.reload} />;
  if (!test.data) return <Loading what="test" />;
  const t = test.data;
  const project = overview.data?.project;
  const repository = project?.repository ?? null;

  const toggleQuarantine = async () => {
    setBusy(true);
    setActionError(null);
    try {
      test.setData(await api.setQuarantine(slug, t.id, !t.quarantined));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update the test.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={PROJECTS_PATH}>Projects</Link>
        <Link to={`/projects/${slug}`}>{project?.name ?? slug}</Link>
      </nav>

      <header className="test-head">
        <p className="test-class">{t.classname}</p>
        <h1 className="page-title test-title">{t.name}</h1>
        {t.file && <p className="test-file">{t.file}</p>}
        <div className="test-head-row">
          <StatusPill status={t.status} />
          <span className="muted">{STATUS_HELP[t.status]}</span>
          {t.quarantined && <span className="tag">Quarantined</span>}
          <button type="button" className="btn btn-small" onClick={toggleQuarantine} disabled={busy}>
            {t.quarantined ? 'Release from quarantine' : 'Quarantine'}
          </button>
        </div>
        {actionError && (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        )}
        {!t.quarantined && (t.status === 'flaky' || t.status === 'suspect') && (
          <p className="hint">
            Quarantining keeps running the test but stops its failures from being reported as real in pull requests.
          </p>
        )}
      </header>

      <div className="detail-grid">
        <section className="panel" aria-labelledby="why-title">
          <h2 id="why-title" className="panel-title">
            Why it is {t.status === 'new' ? 'not rated yet' : t.status}
          </h2>
          <ul className="reasons">
            {t.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="score-row">
            <span>Flakiness score</span>
            <ScoreMeter score={t.score} />
          </div>
        </section>

        <section className="panel" aria-labelledby="numbers-title">
          <h2 id="numbers-title" className="panel-title">
            By the numbers
          </h2>
          <dl className="facts">
            <div>
              <dt>Runs analysed</dt>
              <dd>{t.runs}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd>
                {t.failures} <span className="muted">({percent(t.failureRate)})</span>
              </dd>
            </div>
            <div>
              <dt>Outcome changes on the default branch</dt>
              <dd>
                {t.flips} <span className="muted">({percent(t.flipRate)})</span>
              </dd>
            </div>
            <div>
              <dt>Commits with both a pass and a fail</dt>
              <dd>{t.conflictingCommits}</dd>
            </div>
            <div>
              <dt>Typical duration</dt>
              <dd>{t.avgDurationMs ? duration(t.avgDurationMs) : '–'}</dd>
            </div>
            <div>
              <dt>First seen</dt>
              <dd>{timeAgo(t.firstSeenAt)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <Timeline history={t.history} repository={repository} />

      {t.topMessages.length > 0 && (
        <section className="panel" aria-labelledby="messages-title">
          <h2 id="messages-title" className="panel-title">
            How it fails
          </h2>
          <ul className="messages">
            {t.topMessages.map((m) => (
              <li key={m.message}>
                <pre>{m.message}</pre>
                <span className="muted">
                  {plural(m.count, 'time')}, last {timeAgo(m.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Full history, oldest on the left. Commits that both passed and failed are
 * bracketed underneath: that bracket is the proof of flakiness.
 */
function Timeline({ history, repository }: { history: TestDetail['history']; repository: string | null }) {
  const entries = useMemo(() => [...history].reverse(), [history]);
  const [selected, setSelected] = useState<number | null>(null);

  const conflicted = useMemo(() => {
    const outcomes = new Map<string, Set<string>>();
    for (const e of entries) {
      if (e.status === 'skipped') continue;
      const set = outcomes.get(e.commitSha) ?? new Set();
      set.add(e.status);
      outcomes.set(e.commitSha, set);
    }
    return new Set([...outcomes].filter(([, s]) => s.size > 1).map(([sha]) => sha));
  }, [entries]);

  if (entries.length === 0) return null;
  const current = selected !== null ? entries[selected] : entries[entries.length - 1];

  return (
    <section className="panel timeline" aria-labelledby="timeline-title">
      <div className="timeline-head">
        <h2 id="timeline-title" className="panel-title">
          Last {plural(entries.length, 'execution')}
        </h2>
        <span className="muted">
          {conflicted.size > 0
            ? `Brackets mark ${plural(conflicted.size, 'commit')} where the same code both passed and failed.`
            : 'Select a run to see its details.'}
        </span>
      </div>

      <div className="timeline-track" role="listbox" aria-label="Executions, oldest first">
        {entries.map((e, i) => {
          const prev = entries[i - 1];
          const next = entries[i + 1];
          const isConflict = conflicted.has(e.commitSha);
          const bracket = isConflict
            ? [
                prev?.commitSha === e.commitSha ? '' : 'start',
                next?.commitSha === e.commitSha ? '' : 'end',
              ].join(' ')
            : '';
          return (
            <button
              key={`${e.runId}-${e.attempt}`}
              type="button"
              role="option"
              aria-selected={current === e}
              className={`bar bar-${e.status}${isConflict ? ` is-conflict ${bracket}` : ''}${
                e.trusted ? '' : ' is-branch'
              }`}
              onClick={() => setSelected(i)}
              onMouseEnter={() => setSelected(i)}
              aria-label={`${e.status} on ${shortSha(e.commitSha)}, ${dateTime(e.createdAt)}`}
            />
          );
        })}
      </div>
      <div className="timeline-axis muted" aria-hidden="true">
        <span>{dateTime(entries[0]!.createdAt)}</span>
        <span>{dateTime(entries[entries.length - 1]!.createdAt)}</span>
      </div>
      <p className="timeline-key muted">
        Faded bars ran on feature branches. They only count as evidence when the same commit both passed and failed.
      </p>

      {current && <ExecutionDetail entry={current} repository={repository} conflict={conflicted.has(current.commitSha)} />}
    </section>
  );
}

function ExecutionDetail({
  entry: e,
  repository,
  conflict,
}: {
  entry: HistoryEntry;
  repository: string | null;
  conflict: boolean;
}) {
  const commit = commitUrl(repository, e.commitSha);
  const pr = e.prNumber ? pullUrl(repository, e.prNumber) : null;
  return (
    <div className="execution" aria-live="polite">
      <div className="execution-row">
        <span className={`result-${e.status === 'failed' ? 'red' : e.status === 'passed' ? 'green' : 'grey'}`}>
          {e.status === 'failed' ? 'Failed' : e.status === 'passed' ? 'Passed' : 'Skipped'}
        </span>
        <span>{dateTime(e.createdAt)}</span>
        <span>
          <code>{e.branch}</code>
          {e.prNumber &&
            (pr ? (
              <>
                {' '}
                <a href={pr} target="_blank" rel="noreferrer">
                  #{e.prNumber}
                </a>
              </>
            ) : (
              ` #${e.prNumber}`
            ))}
        </span>
        <span>
          commit{' '}
          {commit ? (
            <a href={commit} target="_blank" rel="noreferrer" className="sha">
              {shortSha(e.commitSha)}
            </a>
          ) : (
            <code className="sha">{shortSha(e.commitSha)}</code>
          )}
        </span>
        {e.attempt > 1 && <span>attempt {e.attempt}</span>}
        {e.durationMs > 0 && <span>{duration(e.durationMs)}</span>}
      </div>
      {conflict && <p className="execution-note">This commit also has the opposite outcome in another attempt.</p>}
      {e.verdict && <p className="execution-note">{VERDICT_TEXT[e.verdict]}.</p>}
      {e.message && <pre className="execution-message">{e.message}</pre>}
    </div>
  );
}

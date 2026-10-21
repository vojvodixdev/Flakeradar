import type { CreatedProject, ProjectListItem } from '@flakeradar/core';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, IS_DEMO } from '../api';
import { Empty, ErrorState, Loading } from '../components/Common';
import { SetupInstructions } from '../components/Setup';
import { StatusDistribution } from '../components/Status';
import { plural, timeAgo } from '../format';
import { useAsync, useDocumentTitle } from '../hooks';

export function ProjectsPage() {
  useDocumentTitle('Projects');
  const projects = useAsync(() => api.projects(), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedProject | null>(null);

  if (created) {
    return (
      <div className="page page-narrow">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/">Projects</Link>
        </nav>
        <h1 className="page-title">{created.project.name} is ready</h1>
        <p className="lede">Connect it to your CI in three steps.</p>
        <SetupInstructions token={created.token} />
        <div className="actions">
          <Link to={`/projects/${created.project.slug}`} className="btn btn-primary">
            Open {created.project.name}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="lede">Each project tracks the tests of one repository.</p>
        </div>
        {!creating && !IS_DEMO && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      </div>

      {creating && (
        <NewProjectForm
          onCancel={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            setCreated(p);
          }}
        />
      )}

      {projects.error ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : !projects.data ? (
        <Loading what="projects" />
      ) : projects.data.length === 0 ? (
        !creating && (
          <Empty title="No projects yet">
            <p>Create a project to get an upload token for your CI, or load demo data with <code>npm run seed</code>.</p>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </Empty>
        )
      ) : (
        <ul className="project-list">
          {projects.data.map((p) => (
            <ProjectRow key={p.slug} project={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectRow({ project: p }: { project: ProjectListItem }) {
  const attention = p.counts.flaky + p.counts.broken;
  return (
    <li className="project-row">
      <div className="project-row-main">
        <Link to={`/projects/${p.slug}`} className="project-name stretched">
          {p.name}
        </Link>
        <span className="project-repo">{p.repository ?? 'No repository linked'}</span>
      </div>
      <div className="project-row-dist">
        {p.testCount > 0 ? (
          <StatusDistribution counts={p.counts} />
        ) : (
          <span className="muted">Waiting for the first run</span>
        )}
      </div>
      <div className="project-row-meta">
        <span className={attention > 0 ? 'attention' : 'muted'}>
          {attention > 0 ? `${plural(attention, 'test')} need attention` : 'Nothing needs attention'}
        </span>
        <span className="muted">
          {plural(p.runCount, 'run')}, last {timeAgo(p.lastRunAt)}
        </span>
      </div>
    </li>
  );
}

function NewProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (p: CreatedProject) => void }) {
  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createProject({ name, repository: repository || undefined, defaultBranch }));
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.code === 'validation_error'
          ? 'Check the fields: the repository must look like owner/repo.'
          : err instanceof Error
            ? err.message
            : 'Could not create the project.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel form" onSubmit={submit} aria-labelledby="new-project-title">
      <h2 id="new-project-title">New project</h2>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
        </label>
        <label className="field">
          <span>GitHub repository</span>
          <input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="owner/repo"
            pattern="[\w.\-]+/[\w.\-]+"
            title="owner/repo"
          />
          <small>Optional. Used to link commits and pull requests.</small>
        </label>
        <label className="field">
          <span>Default branch</span>
          <input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} required />
          <small>Flip-rate evidence only comes from this branch.</small>
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}

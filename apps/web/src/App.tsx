import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { onAdminTokenNeeded } from './api';
import { AdminTokenDialog, Empty } from './components/Common';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { TestPage } from './pages/TestPage';

export function App() {
  const [askingToken, setAskingToken] = useState(false);
  const resolver = useRef<((token: string | null) => void) | null>(null);

  useEffect(() => {
    onAdminTokenNeeded(
      () =>
        new Promise((resolve) => {
          resolver.current = resolve;
          setAskingToken(true);
        }),
    );
  }, []);

  const finish = useCallback((token: string | null) => {
    setAskingToken(false);
    resolver.current?.(token);
    resolver.current = null;
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="wordmark" aria-label="FlakeRadar, all projects">
          <Logo />
          <span>FlakeRadar</span>
        </Link>
      </header>

      <main id="main" className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/:slug" element={<ProjectPage />} />
          <Route path="/projects/:slug/tests/:testId" element={<TestPage />} />
          <Route
            path="*"
            element={
              <Empty title="This page does not exist.">
                <Link to="/" className="btn">
                  Go to projects
                </Link>
              </Empty>
            }
          />
        </Routes>
      </main>

      <AdminTokenDialog open={askingToken} onSubmit={(t) => finish(t)} onCancel={() => finish(null)} />
    </div>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="logo">
      <rect x="1" y="13" width="3" height="6" rx="1" className="logo-pass" />
      <rect x="6" y="13" width="3" height="6" rx="1" className="logo-pass" />
      <rect x="11" y="3" width="3" height="16" rx="1" className="logo-fail" />
      <rect x="16" y="13" width="3" height="6" rx="1" className="logo-pass" />
    </svg>
  );
}

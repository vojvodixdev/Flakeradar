import { CopyBlock } from './Common';

/** The two things a team needs to do to start sending data. */
export function SetupInstructions({ token }: { token?: string }) {
  const serverUrl = window.location.origin;
  const workflow = `      - name: Report results to FlakeRadar
        if: \${{ !cancelled() }}
        run: |
          curl -fsSL "$FLAKERADAR_SERVER_URL/api/uploader.mjs" -o "$RUNNER_TEMP/flakeradar.mjs"
          node "$RUNNER_TEMP/flakeradar.mjs"
        env:
          FLAKERADAR_SERVER_URL: ${serverUrl}
          FLAKERADAR_TOKEN: \${{ secrets.FLAKERADAR_TOKEN }}
          FLAKERADAR_JUNIT_PATHS: "**/junit*.xml"
          FLAKERADAR_GITHUB_TOKEN: \${{ github.token }}`;

  return (
    <ol className="setup">
      <li>
        <h3>Save the upload token as a repository secret</h3>
        <p>
          In GitHub, open <em>Settings › Secrets and variables › Actions</em> and add a secret named{' '}
          <code>FLAKERADAR_TOKEN</code>.
          {token ? ' This is the only time the token is shown.' : ' Use the token you got when the project was created.'}
        </p>
        {token && <CopyBlock text={token} label="Upload token" />}
      </li>
      <li>
        <h3>Add a step after your tests</h3>
        <p>
          Your test runner needs to write JUnit XML (Jest, Vitest, Playwright, pytest, Go, JUnit and most others can).
          Add this step at the end of the job that runs the tests. It downloads a small script from this server, so
          there is nothing to install:
        </p>
        <CopyBlock text={workflow} label="GitHub Actions workflow step" />
        <p className="hint">
          Using GitLab CI or another system? Run the same two commands with the same variables. The README has a GitLab
          example.
        </p>
      </li>
      <li>
        <h3>Push a commit</h3>
        <p>
          The first run appears here within seconds. Pull requests get a comment that separates real failures from known
          flakiness.
        </p>
      </li>
    </ol>
  );
}

/**
 * The signature visual of FlakeRadar: a test's recent history drawn like a
 * seismograph. Passes are short calm ticks, failures spike up in red, so the
 * difference between "fails at random" and "started failing on Tuesday" is
 * visible at a glance.
 */
export function OutcomeStrip({ outcomes, label }: { outcomes: string; label?: string }) {
  if (!outcomes) return <span className="strip strip-empty">No runs yet</span>;
  const failures = [...outcomes].filter((c) => c === 'f').length;
  const description =
    label ?? `Last ${outcomes.length} runs, oldest first: ${failures} failed, ${outcomes.length - failures} did not`;

  return (
    <span className="strip" role="img" aria-label={description}>
      {[...outcomes].map((c, i) => (
        <span key={i} className={`tick tick-${c}`} />
      ))}
    </span>
  );
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'never';
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86_400 * 30) return relative.format(Math.round(seconds / 86_400), 'day');
  return new Date(ms).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('en', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

export function percent(ratio: number): string {
  if (ratio > 0 && ratio < 0.01) return '<1%';
  return `${Math.round(ratio * 100)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function commitUrl(repository: string | null, sha: string): string | null {
  return repository ? `https://github.com/${repository}/commit/${sha}` : null;
}

export function pullUrl(repository: string | null, pr: number): string | null {
  return repository ? `https://github.com/${repository}/pull/${pr}` : null;
}

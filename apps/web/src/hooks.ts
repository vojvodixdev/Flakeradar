import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  /** Replace the data locally, e.g. after a mutation returned the new value. */
  setData: (data: T) => void;
}

/**
 * Minimal data-fetching hook. Ignores responses that arrive after the inputs
 * changed, so fast typing in a search box never shows stale results.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    setLoading(true);
    load()
      .then((value) => {
        if (id !== latest.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (id !== latest.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (id === latest.current) setLoading(false);
      });
    // `load` is recreated on every render; `deps` says when it actually changes.
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · FlakeRadar` : 'FlakeRadar';
  }, [title]);
}

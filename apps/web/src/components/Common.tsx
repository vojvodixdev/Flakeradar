import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiRequestError } from '../api';

export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text is still selectable.
    }
  };
  return (
    <div className="copy-block">
      <pre aria-label={label}>
        <code>{text}</code>
      </pre>
      <button type="button" className="btn btn-quiet btn-small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="state" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const notFound = error instanceof ApiRequestError && error.status === 404;
  return (
    <div className="state state-error" role="alert">
      <p>{notFound ? error.message : `Could not load this page: ${error.message}`}</p>
      {!notFound && onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children}
    </div>
  );
}

/** Asks for the admin token when the server rejects an admin-only action. */
export function AdminTokenDialog({
  open,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  onSubmit: (token: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValue('');
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" onCancel={onCancel} aria-labelledby="admin-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h2 id="admin-title">Admin token required</h2>
        <p>
          This server only lets admins create projects and quarantine tests. Enter the value of{' '}
          <code>ADMIN_TOKEN</code> it was started with. It is remembered in this browser.
        </p>
        <label className="field">
          <span>Admin token</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}

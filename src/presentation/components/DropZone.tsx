'use client';

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';
import { Upload } from 'lucide-react';
import type { TreeNode } from '../../application/tree/build-tree.js';
import { Badge } from './Badge.js';
import { formatBytes, recordTypeLabel } from '../lib/format.js';

interface Outcome {
  state: string;
  recordId: string | null;
  detail: string;
  warnings: string[];
}

interface DropZoneProps {
  readonly node: TreeNode;
  readonly onOpenRecord: (id: string) => void;
  readonly onIngested: (message: string) => void;
}

/**
 * Category view and drop target.
 *
 * Drag and drop is not the only way in: the same action is reachable by
 * keyboard through a real file input, because a pointer-only affordance would
 * make ingestion impossible for anyone who does not use a mouse.
 */
export function DropZone({ node, onOpenRecord, onIngested }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ name: string; size: number }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const category = node.id.startsWith('category:') ? node.id.slice('category:'.length) : node.label;

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      setBusy(true);
      setError('');
      setOutcomes([]);
      setPending(list.map((f) => ({ name: f.name, size: f.size })));

      const form = new FormData();
      form.set('category', category);
      for (const file of list) form.append('files', file);

      try {
        const res = await fetch('/api/ingest', { method: 'POST', body: form });
        const data = (await res.json()) as {
          error?: string;
          accepted?: number;
          duplicates?: number;
          quarantined?: number;
          outcomes?: Outcome[];
        };

        if (!res.ok) {
          setError(data.error ?? `Import failed (${res.status}).`);
          return;
        }

        setOutcomes(data.outcomes ?? []);
        const parts: string[] = [];
        if ((data.accepted ?? 0) > 0) parts.push(`${data.accepted} added`);
        if ((data.duplicates ?? 0) > 0) parts.push(`${data.duplicates} already present`);
        if ((data.quarantined ?? 0) > 0) parts.push(`${data.quarantined} held for review`);
        onIngested(parts.length > 0 ? `${parts.join(', ')} in ${category}.` : 'Nothing was imported.');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Import failed.');
      } finally {
        setBusy(false);
        setPending([]);
      }
    },
    [category, onIngested],
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-4">
        <p className="eyebrow">{node.kind === 'query' ? 'Saved query' : 'Category'}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{node.label}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {node.count} item{node.count === 1 ? '' : 's'}.
          {node.droppable && ' Drop files here to file them under this category.'}
        </p>
      </header>

      {node.droppable && (
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
          className={clsx(
            'mb-6 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft/40' : 'border-line',
          )}
        >
          <Upload className="mx-auto mb-2 h-5 w-5 text-ink-faint" aria-hidden="true" />
          <p className="text-sm text-ink-muted">
            Drop files here, or{' '}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="text-accent underline underline-offset-2 hover:no-underline"
            >
              choose files
            </button>
            .
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label={`Add files to ${node.label}`}
            onChange={(e) => {
              if (e.target.files !== null) void upload(e.target.files);
              e.target.value = '';
            }}
          />
          <p className="mt-2 text-2xs text-ink-faint">
            Originals are preserved untouched. Filing is free: no model is called.
          </p>
          <div className="mt-2 flex justify-center">
            <Badge tone="positive" glyph="○" title="Costs nothing to run">
              Token class 0
            </Badge>
          </div>
        </section>
      )}

      {busy && (
        <div className="mb-4 rounded border border-line bg-surface p-3" aria-busy="true" aria-live="polite">
          <p className="text-xs text-ink-muted">Importing {pending.length} file(s)…</p>
          <ul className="mt-1 space-y-0.5">
            {pending.map((f) => (
              <li key={f.name} className="flex justify-between text-2xs text-ink-faint">
                <span className="truncate">{f.name}</span>
                <span>{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error !== '' && (
        <div className="mb-4 rounded border border-critical/40 bg-critical/5 p-3" role="alert">
          <p className="text-xs text-critical">{error}</p>
        </div>
      )}

      {outcomes.length > 0 && (
        <section className="mb-6">
          <h2 className="eyebrow mb-2">Import result</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {outcomes.map((o, i) => (
              <li key={i} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  {o.state === 'cataloged' && (
                    <Badge tone="positive" glyph="✓">
                      Added
                    </Badge>
                  )}
                  {o.state === 'duplicate' && (
                    <Badge tone="neutral" glyph="=">
                      Already present
                    </Badge>
                  )}
                  {o.state === 'quarantined' && (
                    <Badge tone="caution" glyph="!">
                      Held for review
                    </Badge>
                  )}
                  {o.state === 'failed' && (
                    <Badge tone="critical" glyph="×">
                      Failed
                    </Badge>
                  )}
                  <span className="flex-1 text-xs text-ink-muted">{o.detail}</span>
                  {o.recordId !== null && (
                    <button
                      type="button"
                      onClick={() => onOpenRecord(o.recordId!)}
                      className="shrink-0 text-xs text-accent hover:underline"
                    >
                      Open
                    </button>
                  )}
                </div>
                {o.warnings.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {o.warnings.map((w) => (
                      <li key={w} className="text-2xs text-caution">
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="eyebrow mb-2">Contents</h2>
        {node.children.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-8 text-center text-xs text-ink-faint">
            Nothing here yet.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {node.children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => child.recordId !== null && onOpenRecord(child.recordId)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{child.label}</span>
                  {child.recordType !== null && (
                    <span className="shrink-0 text-2xs text-ink-faint">
                      {recordTypeLabel(child.recordType)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

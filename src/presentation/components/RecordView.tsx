'use client';

import { useEffect, useState } from 'react';
import { ProvenanceBadge } from './Badge.js';
import { formatRelative, recordTypeLabel } from '../lib/format.js';

interface Detail {
  record: {
    id: string;
    title: string;
    body: string | null;
    recordType: string;
    vaultPath: string | null;
    provenance: string;
    sourceOfTruth: string;
    updatedAt: string;
  };
}

/**
 * Centre-panel reader for one note.
 *
 * Renders the markdown body as plain, readable text rather than as HTML: the
 * vault can contain anything, and this view is never a place where arbitrary
 * markup should be able to execute.
 */
export function RecordView({
  recordId,
  onOpenRecord,
}: {
  readonly recordId: string;
  readonly onOpenRecord: (id: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetch(`/api/records/${encodeURIComponent(recordId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not open this record (${res.status})`);
        return (await res.json()) as Detail;
      })
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setState('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  if (state === 'loading') {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6" aria-busy="true">
        <span className="sr-only">Loading note</span>
        <div className="h-7 w-1/2 animate-pulse rounded bg-raised" />
        <div className="h-3 w-full animate-pulse rounded bg-raised" />
        <div className="h-3 w-11/12 animate-pulse rounded bg-raised" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-raised" />
      </div>
    );
  }

  if (state === 'error' || detail === null) {
    return (
      <div className="p-6" role="alert">
        <p className="text-sm text-critical">{error}</p>
      </div>
    );
  }

  const { record } = detail;

  return (
    <article className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-4 border-b border-line pb-3">
        <p className="eyebrow mb-1">{recordTypeLabel(record.recordType)}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{record.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={record.provenance} />
          <span className="text-2xs text-ink-faint">Modified {formatRelative(record.updatedAt)}</span>
          {record.vaultPath !== null && (
            <span className="font-mono text-2xs text-ink-faint">{record.vaultPath}</span>
          )}
        </div>
      </header>

      {record.body === null || record.body.trim() === '' ? (
        <p className="text-sm text-ink-faint">
          This item has no text content. The original file is preserved and can be opened from the
          inspector.
        </p>
      ) : (
        <MarkdownBody source={record.body} onOpenRecord={onOpenRecord} />
      )}
    </article>
  );
}

/**
 * Minimal markdown renderer.
 *
 * Handles the structures that carry meaning in a vault - headings, lists,
 * quotes, code, task boxes - and renders everything else as text. Deliberately
 * not an HTML pass-through.
 */
function MarkdownBody({
  source,
  onOpenRecord: _onOpenRecord,
}: {
  readonly source: string;
  readonly onOpenRecord: (id: string) => void;
}) {
  const lines = source.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: { text: string; checked: boolean | null }[] = [];
  let codeLines: string[] | null = null;

  const flushParagraph = (key: string): void => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={key} className="mb-3 text-sm leading-relaxed text-ink-muted">
        {inline(paragraph.join(' '))}
      </p>,
    );
    paragraph = [];
  };

  const flushList = (key: string): void => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={key} className="mb-3 space-y-1">
        {listItems.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
            {item.checked === null ? (
              <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
            ) : (
              <span
                className="mt-[2px] shrink-0 font-mono text-xs text-ink-faint"
                aria-label={item.checked ? 'Done' : 'Not done'}
              >
                {item.checked ? '☑' : '☐'}
              </span>
            )}
            <span>{inline(item.text)}</span>
          </li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  lines.forEach((line, index) => {
    const key = `b${index}`;

    if (line.trimStart().startsWith('```')) {
      if (codeLines === null) {
        flushParagraph(key + 'p');
        flushList(key + 'l');
        codeLines = [];
      } else {
        blocks.push(
          <pre
            key={key}
            className="mb-3 overflow-x-auto rounded border border-line bg-raised p-3 font-mono text-xs text-ink-muted"
          >
            <code>{codeLines.join('\n')}</code>
          </pre>,
        );
        codeLines = null;
      }
      return;
    }

    if (codeLines !== null) {
      codeLines.push(line);
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph(key + 'p');
      flushList(key + 'l');
      const level = heading[1]!.length;
      const text = heading[2]!;
      const sizes = ['text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-sm'];
      const Tag = (`h${Math.min(level + 1, 6)}`) as 'h2';
      blocks.push(
        <Tag
          key={key}
          className={`mb-2 mt-5 font-semibold tracking-tight text-ink ${sizes[level - 1] ?? 'text-sm'}`}
        >
          {text}
        </Tag>,
      );
      return;
    }

    const task = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (task !== null) {
      flushParagraph(key + 'p');
      listItems.push({ text: task[2]!, checked: task[1]!.toLowerCase() === 'x' });
      return;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph(key + 'p');
      listItems.push({ text: bullet[1]!, checked: null });
      return;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph(key + 'p');
      flushList(key + 'l');
      blocks.push(
        <blockquote
          key={key}
          className="mb-3 border-l-2 border-accent/50 pl-3 text-sm italic leading-relaxed text-ink-muted"
        >
          {inline(line.replace(/^\s*>\s?/, ''))}
        </blockquote>,
      );
      return;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(key + 'p');
      flushList(key + 'l');
      blocks.push(<hr key={key} className="my-4 border-line" />);
      return;
    }

    if (line.trim() === '') {
      flushParagraph(key + 'p');
      flushList(key + 'l');
      return;
    }

    flushList(key + 'l');
    paragraph.push(line.trim());
  });

  flushParagraph('final-p');
  flushList('final-l');

  return <div>{blocks}</div>;
}

/** Inline formatting: wikilinks, bold, italic, and code become plain elements. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith('[[')) {
      const inner = token.slice(2, -2);
      const label = inner.includes('|') ? inner.split('|')[1]! : inner;
      out.push(
        <span key={key++} className="text-accent underline decoration-dotted underline-offset-2">
          {label}
        </span>,
      );
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key++} className="rounded-sm bg-raised px-1 font-mono text-xs text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(
        <strong key={key++} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

'use client';

import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ExternalLink,
  FileText,
  GitBranch,
  Link2,
  Lock,
  ShieldAlert,
} from 'lucide-react';
import { Badge, ProvenanceBadge } from './Badge.js';
import { formatBytes, formatDate, formatRelative, formatTokens, obsidianUri, recordTypeLabel } from '../lib/format.js';

interface RecordDetail {
  record: {
    id: string;
    title: string;
    summary: string | null;
    recordType: string;
    vaultPath: string | null;
    provenance: string;
    sourceOfTruth: string;
    privacy: string;
    processing: string;
    humanVerified: boolean;
    aiGenerated: boolean;
    createdAt: string;
    updatedAt: string;
    contentHash: string | null;
    data: Record<string, unknown>;
  };
  vaultName: string;
  relationships: {
    outbound: { id: string; type: string; origin: string; otherId: string; otherTitle: string }[];
    inbound: { id: string; type: string; origin: string; otherId: string; otherTitle: string }[];
    unresolved: { raw_target: string; link_kind: string }[];
  };
  citations: { id: string; source_path: string | null; excerpt: string }[];
  projects: { id: string; title: string; role: string; isPrimary: boolean }[];
  revisions: { id: string; ts: string; revision: number; author: string }[];
  tokens: { metadata: number; full: number; body: number };
}

interface InspectorProps {
  readonly recordId: string | null;
  readonly onSelectRecord: (id: string) => void;
}

/**
 * Context inspector.
 *
 * Answers the questions the product exists to answer for a selected item:
 * where it came from, what supports it, what points at it, whether the app may
 * change it, and what it would cost to include in a model call.
 */
export function Inspector({ recordId, onSelectRecord }: InspectorProps) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (recordId === null) {
      setDetail(null);
      setState('idle');
      return;
    }
    let cancelled = false;
    setState('loading');
    fetch(`/api/records/${encodeURIComponent(recordId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load record (${res.status})`);
        return (await res.json()) as RecordDetail;
      })
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setState('idle');
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

  if (recordId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText className="h-5 w-5 text-ink-faint" aria-hidden="true" />
        <p className="text-xs text-ink-faint">
          Select an item to see where it came from and what links to it.
        </p>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div className="space-y-3 p-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading item details</span>
        <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
        <div className="h-3 w-full animate-pulse rounded bg-raised" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-raised" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="p-4" role="alert">
        <p className="text-xs text-critical">{error}</p>
      </div>
    );
  }

  if (detail === null) return null;

  const { record } = detail;
  const readOnly = record.sourceOfTruth === 'external_read_only';
  const tags = Array.isArray(record.data['tags']) ? (record.data['tags'] as string[]) : [];
  const wordCount = typeof record.data['wordCount'] === 'number' ? record.data['wordCount'] : null;
  const sizeBytes = typeof record.data['sizeBytes'] === 'number' ? record.data['sizeBytes'] : null;
  const warnings = Array.isArray(record.data['warnings']) ? (record.data['warnings'] as string[]) : [];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-line px-4 py-3">
        <p className="eyebrow mb-1">{recordTypeLabel(record.recordType)}</p>
        <h2 className="text-lg font-semibold leading-tight text-ink">{record.title}</h2>
        <div className="mt-2 flex flex-wrap gap-1">
          <ProvenanceBadge provenance={record.provenance} />
          {record.humanVerified && (
            <Badge tone="positive" glyph="✓" title="You have confirmed this">
              Verified
            </Badge>
          )}
          {readOnly && (
            <Badge tone="neutral" glyph="🔒" title="Outside the managed folder; the app will not modify it">
              Read only
            </Badge>
          )}
          {record.privacy === 'never_external' && (
            <Badge tone="caution" glyph="⊘" title="Will never be sent to an external model">
              Local only
            </Badge>
          )}
        </div>
      </header>

      {warnings.length > 0 && (
        <div className="border-b border-caution/30 bg-caution/5 px-4 py-2">
          <p className="mb-1 flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-caution">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            Notices
          </p>
          <ul className="space-y-1">
            {warnings.map((w) => (
              <li key={w} className="text-xs text-ink-muted">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.summary !== null && (
        <Section title="Summary">
          <p className="text-xs leading-relaxed text-ink-muted">{record.summary}</p>
        </Section>
      )}

      <Section title="Token cost">
        <dl className="space-y-1">
          <Row label="Metadata only">{formatTokens(detail.tokens.metadata)} tokens</Row>
          <Row label="Full content">{formatTokens(detail.tokens.full)} tokens</Row>
        </dl>
        <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
          Loading metadata instead of the full note saves{' '}
          {formatTokens(detail.tokens.full - detail.tokens.metadata)} tokens per call.
        </p>
      </Section>

      <Section title="Source">
        <dl className="space-y-1">
          {record.vaultPath !== null && (
            <Row label="Path">
              <span className="break-all font-mono text-2xs">{record.vaultPath}</span>
            </Row>
          )}
          <Row label="Ownership">{ownershipLabel(record.sourceOfTruth)}</Row>
          <Row label="Modified">{formatRelative(record.updatedAt)}</Row>
          <Row label="Indexed">{formatDate(record.createdAt)}</Row>
          {wordCount !== null && <Row label="Words">{wordCount.toLocaleString()}</Row>}
          {sizeBytes !== null && <Row label="Size">{formatBytes(sizeBytes)}</Row>}
          {record.contentHash !== null && (
            <Row label="Hash">
              <span className="font-mono text-2xs">{record.contentHash.slice(0, 12)}…</span>
            </Row>
          )}
        </dl>
        {record.vaultPath !== null && (
          <a
            href={obsidianUri(detail.vaultName, record.vaultPath)}
            className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            Open in Obsidian
          </a>
        )}
      </Section>

      {tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span key={tag} className="pill border-line-strong text-ink-muted">
                #{tag}
              </span>
            ))}
          </div>
        </Section>
      )}

      {detail.projects.length > 0 && (
        <Section title="Projects">
          <ul className="space-y-1">
            {detail.projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelectRecord(p.id)}
                  className="flex w-full items-center gap-1 text-left text-xs text-ink-muted hover:text-accent"
                >
                  <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{p.title}</span>
                  <span className="ml-auto shrink-0 text-2xs text-ink-faint">{p.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Links out (${detail.relationships.outbound.length})`}>
        {detail.relationships.outbound.length === 0 ? (
          <p className="text-xs text-ink-faint">This note does not link to anything.</p>
        ) : (
          <ul className="space-y-1">
            {detail.relationships.outbound.map((rel) => (
              <LinkRow key={rel.id} rel={rel} onSelect={onSelectRecord} icon={<Link2 />} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Backlinks (${detail.relationships.inbound.length})`}>
        {detail.relationships.inbound.length === 0 ? (
          <p className="text-xs text-ink-faint">Nothing links here yet.</p>
        ) : (
          <ul className="space-y-1">
            {detail.relationships.inbound.map((rel) => (
              <LinkRow key={rel.id} rel={rel} onSelect={onSelectRecord} icon={<GitBranch />} />
            ))}
          </ul>
        )}
      </Section>

      {detail.relationships.unresolved.length > 0 && (
        <Section title={`Broken links (${detail.relationships.unresolved.length})`}>
          <ul className="space-y-1">
            {detail.relationships.unresolved.map((u) => (
              <li key={u.raw_target} className="flex items-center gap-1 text-xs text-caution">
                <span aria-hidden="true">⚠</span>
                <span className="truncate font-mono text-2xs">[[{u.raw_target}]]</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-ink-faint">
            These point at notes that do not exist in the vault.
          </p>
        </Section>
      )}

      {detail.citations.length > 0 && (
        <Section title="Citations">
          <ul className="space-y-2">
            {detail.citations.map((c) => (
              <li key={c.id} className="border-l-2 border-line-strong pl-2">
                <p className="text-xs italic text-ink-muted">“{c.excerpt}”</p>
                {c.source_path !== null && (
                  <p className="mt-0.5 font-mono text-2xs text-ink-faint">{c.source_path}</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-2xs text-ink-faint">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-ink-muted">{children}</dd>
    </div>
  );
}

function LinkRow({
  rel,
  onSelect,
  icon,
}: {
  readonly rel: { id: string; type: string; origin: string; otherId: string; otherTitle: string };
  readonly onSelect: (id: string) => void;
  readonly icon: React.ReactElement;
}) {
  const aiSuggested = rel.origin === 'ai_suggested';
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(rel.otherId)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-ink-muted hover:text-accent"
      >
        <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3" aria-hidden="true">
          {icon}
        </span>
        <span className="truncate">{rel.otherTitle}</span>
        {aiSuggested && (
          <span className="ml-auto shrink-0" title="Suggested by a model; not confirmed">
            <Badge tone="info" glyph="◆">
              AI
            </Badge>
          </span>
        )}
      </button>
    </li>
  );
}

function ownershipLabel(mode: string): string {
  const map: Record<string, string> = {
    external_read_only: 'Yours — app will not modify',
    obsidian_authoritative: 'Obsidian wins',
    database_authoritative: 'App wins',
    bidirectional: 'Two-way sync',
    managed: 'Managed by the app',
    snapshot: 'Frozen snapshot',
    unmanaged: 'Indexed only',
  };
  return map[mode] ?? mode;
}

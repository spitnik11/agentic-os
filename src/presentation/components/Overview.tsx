'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CircleOff, Link2Off, Sparkles } from 'lucide-react';
import { Badge } from './Badge.js';
import { formatCost, formatRelative, formatTokens, recordTypeLabel } from '../lib/format.js';

interface OverviewData {
  totals: { records: number; relationships: number; projects: number; corpusTokens: number };
  health: {
    brokenLinks: number;
    openConflicts: number;
    pendingProposals: number;
    needsReview: number;
    unverifiedAi: number;
    aiSuggestedRelationships: number;
    orphans: number;
    stale: number;
    duplicateCandidates: number;
  };
  byType: { type: string; n: number }[];
  projects: { id: string; title: string; summary: string | null; updatedAt: string }[];
  recent: { id: string; title: string; recordType: string; updatedAt: string; aiGenerated: boolean }[];
  recentAudit: { id: string; ts: string; actor: string; action: string; target_path: string | null }[];
  ai: { enabled: boolean; monthToDateUsd: number; monthlyBudgetUsd: number };
}

/**
 * Home.
 *
 * Every number here is a live query result and every one of them is actionable:
 * things that need attention, and what the vault would cost to process. Counts
 * that would only be decorative are deliberately absent.
 */
export function Overview({ onOpenRecord }: { readonly onOpenRecord: (id: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/overview')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the overview (${res.status})`);
        return (await res.json()) as OverviewData;
      })
      .then((d) => {
        setData(d);
        setState('ready');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      });
  }, []);

  if (state === 'loading') {
    return (
      <div className="space-y-4 p-6" aria-busy="true">
        <span className="sr-only">Loading the overview</span>
        <div className="h-6 w-48 animate-pulse rounded bg-raised" />
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-raised" />
          ))}
        </div>
      </div>
    );
  }

  if (state === 'error' || data === null) {
    return (
      <div className="p-6" role="alert">
        <p className="text-sm text-critical">{error}</p>
        <p className="mt-2 text-xs text-ink-muted">
          If this is the first run, index the vault with <code className="font-mono">npm run index</code>.
        </p>
      </div>
    );
  }

  const attention = [
    { key: 'brokenLinks', label: 'Broken links', value: data.health.brokenLinks, icon: Link2Off, tone: 'caution' as const },
    { key: 'conflicts', label: 'Open conflicts', value: data.health.openConflicts, icon: AlertTriangle, tone: 'critical' as const },
    { key: 'review', label: 'Awaiting review', value: data.health.needsReview, icon: AlertTriangle, tone: 'caution' as const },
    { key: 'unverified', label: 'Unverified AI output', value: data.health.unverifiedAi, icon: Sparkles, tone: 'info' as const },
    { key: 'orphans', label: 'Orphaned notes', value: data.health.orphans, icon: CircleOff, tone: 'neutral' as const },
    { key: 'duplicates', label: 'Duplicate candidates', value: data.health.duplicateCandidates, icon: AlertTriangle, tone: 'caution' as const },
  ].filter((item) => item.value > 0);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Vault overview</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {data.totals.records.toLocaleString()} records, {data.totals.relationships.toLocaleString()} links,{' '}
          {data.totals.projects} project{data.totals.projects === 1 ? '' : 's'}.
        </p>
      </header>

      {/* Cost of the corpus: the number that justifies not sending everything. */}
      <section className="mb-6 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="eyebrow">Whole vault, as tokens</p>
            <p className="mt-0.5 font-mono text-xl tabular-nums text-ink">
              {formatTokens(data.totals.corpusTokens)}
            </p>
          </div>
          <div>
            <p className="eyebrow">AI spend this month</p>
            <p className="mt-0.5 font-mono text-xl tabular-nums text-ink">
              {formatCost(data.ai.monthToDateUsd)}
              <span className="ml-1 text-xs text-ink-faint">of {formatCost(data.ai.monthlyBudgetUsd)}</span>
            </p>
          </div>
          <div className="ml-auto">
            {data.ai.enabled ? (
              <Badge tone="info" glyph="●" title="Model features are available">
                AI enabled
              </Badge>
            ) : (
              <Badge tone="positive" glyph="○" title="No model is called; everything runs locally">
                AI off — everything here is free
              </Badge>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Sending the whole vault to a model would cost about{' '}
          {formatTokens(data.totals.corpusTokens)} tokens per call. The context builder selects
          only what a question needs, which is why indexing, search, links, and this page all run
          at no cost.
        </p>
      </section>

      {attention.length > 0 && (
        <section className="mb-6">
          <h2 className="eyebrow mb-2">Needs attention</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {attention.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.key} className="flex items-center gap-3 px-3 py-2">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                  <span className="flex-1 text-sm text-ink-muted">{item.label}</span>
                  <span className="font-mono text-sm tabular-nums text-ink">{item.value}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="eyebrow mb-2">Projects</h2>
          {data.projects.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-faint">
              No projects indexed. A note named PROJECT.md becomes a project hub.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {data.projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onOpenRecord(p.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{p.title}</span>
                      {p.summary !== null && (
                        <span className="block truncate text-xs text-ink-faint">{p.summary}</span>
                      )}
                    </span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="eyebrow mb-2">Recently changed</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {data.recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpenRecord(r.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{r.title}</span>
                  {r.aiGenerated && (
                    <Badge tone="info" glyph="◆" title="Generated by a model">
                      AI
                    </Badge>
                  )}
                  <span className="shrink-0 text-2xs text-ink-faint">{formatRelative(r.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-6">
        <h2 className="eyebrow mb-2">By type</h2>
        <div className="rounded-lg border border-line bg-surface p-3">
          <ul className="space-y-1.5">
            {data.byType.map((t) => {
              const max = Math.max(...data.byType.map((x) => x.n));
              const pct = max === 0 ? 0 : Math.round((t.n / max) * 100);
              return (
                <li key={t.type} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-xs text-ink-muted">
                    {recordTypeLabel(t.type)}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-sm bg-raised">
                    <span
                      className="block h-full rounded-sm bg-accent/60"
                      style={{ width: `${pct}%` }}
                      role="presentation"
                    />
                  </span>
                  <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                    {t.n}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {data.recentAudit.length > 0 && (
        <section className="mt-6">
          <h2 className="eyebrow mb-2">Activity</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {data.recentAudit.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-1.5">
                <span className="font-mono text-2xs text-ink-faint">{a.actor}</span>
                <span className="flex-1 truncate text-xs text-ink-muted">{a.action}</span>
                <span className="shrink-0 text-2xs text-ink-faint">{formatRelative(a.ts)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

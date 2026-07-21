import { NextResponse } from 'next/server';
import { getServices } from '../../../infrastructure/container.js';
import { tokenEstimator } from '../../../domain/tokens/estimator.js';
import { scalar as scalarQuery, type SqlParam } from '../../../infrastructure/db/query.js';

export const dynamic = 'force-dynamic';

/**
 * The Home dashboard payload.
 *
 * Every figure here is a real query result. Nothing is a placeholder, and
 * anything that would be decorative rather than actionable is left out.
 */
export async function GET() {
  const { records, db, usage, config } = getServices();

  const scalar = (sql: string, ...params: SqlParam[]): number =>
    scalarQuery(db, sql, 0, ...params);

  const totalRecords = records.count({});
  const projects = records.list({ recordTypes: ['project'], limit: 50 });
  const recent = records.list({ limit: 12 });

  const brokenLinks = scalar('SELECT COUNT(*) AS n FROM unresolved_links');
  const openConflicts = scalar("SELECT COUNT(*) AS n FROM conflicts WHERE state = 'open'");
  const pendingProposals = scalar("SELECT COUNT(*) AS n FROM proposed_changes WHERE state = 'pending'");
  const needsReview = scalar("SELECT COUNT(*) AS n FROM records WHERE processing = 'needs_review'");
  const unverifiedAi = scalar(
    'SELECT COUNT(*) AS n FROM records WHERE ai_generated = 1 AND human_verified = 0',
  );
  const aiSuggestedRelationships = scalar(
    "SELECT COUNT(*) AS n FROM relationships WHERE origin = 'ai_suggested' AND approved = 0",
  );
  const totalRelationships = scalar('SELECT COUNT(*) AS n FROM relationships');

  // Orphans: indexed notes nothing links to and which link nowhere.
  const orphans = scalar(
    `SELECT COUNT(*) AS n FROM records r
      WHERE r.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM relationships WHERE target_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM relationships WHERE source_id = r.id)`,
  );

  // Stale: not modified in 90 days. Deterministic, no model involved.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const stale = scalar(
    'SELECT COUNT(*) AS n FROM records WHERE archived_at IS NULL AND updated_at < ?',
    ninetyDaysAgo,
  );

  // Duplicate candidates: identical content hash across different paths.
  const duplicateGroups = db
    .prepare(
      `SELECT content_hash, COUNT(*) AS n FROM records
        WHERE content_hash IS NOT NULL AND archived_at IS NULL
        GROUP BY content_hash HAVING n > 1`,
    )
    .all() as { content_hash: string; n: number }[];

  const recentIngestion = db
    .prepare('SELECT id, ts, filename, state, destination FROM ingestion_events ORDER BY ts DESC LIMIT 8')
    .all() as { id: string; ts: string; filename: string; state: string; destination: string }[];

  const recentAudit = db
    .prepare('SELECT id, ts, actor, action, target_path FROM audit_events ORDER BY ts DESC LIMIT 10')
    .all() as { id: string; ts: string; actor: string; action: string; target_path: string | null }[];

  // Total corpus size in tokens: what it would cost to send everything, which
  // is the number that makes the case for not doing that.
  const bodies = db.prepare('SELECT body FROM records WHERE archived_at IS NULL').all() as {
    body: string | null;
  }[];
  const corpusTokens = bodies.reduce((sum, r) => sum + tokenEstimator.estimate(r.body ?? ''), 0);

  const byType = db
    .prepare(
      `SELECT record_type AS type, COUNT(*) AS n FROM records
        WHERE archived_at IS NULL GROUP BY record_type ORDER BY n DESC`,
    )
    .all() as { type: string; n: number }[];

  return NextResponse.json({
    totals: {
      records: totalRecords,
      relationships: totalRelationships,
      projects: projects.length,
      corpusTokens,
    },
    health: {
      brokenLinks,
      openConflicts,
      pendingProposals,
      needsReview,
      unverifiedAi,
      aiSuggestedRelationships,
      orphans,
      stale,
      duplicateCandidates: duplicateGroups.reduce((n, g) => n + g.n, 0),
    },
    byType,
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      vaultPath: p.vaultPath,
      updatedAt: p.updatedAt,
    })),
    recent: recent.map((r) => ({
      id: r.id,
      title: r.title,
      recordType: r.recordType,
      vaultPath: r.vaultPath,
      updatedAt: r.updatedAt,
      aiGenerated: r.aiGenerated,
    })),
    recentIngestion,
    recentAudit,
    ai: {
      enabled: config.aiEnabled,
      monthToDateUsd: usage.monthToDateUsd(),
      monthlyBudgetUsd: config.monthlyBudgetUsd,
      byFeature: usage.byFeature(),
    },
  });
}

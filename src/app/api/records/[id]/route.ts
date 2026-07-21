import { NextResponse } from 'next/server';
import { getServices } from '../../../../infrastructure/container.js';
import { tokenEstimator } from '../../../../domain/tokens/estimator.js';

export const dynamic = 'force-dynamic';

/**
 * Full detail for one record, including everything the inspector shows:
 * provenance, links in both directions, citations, and a token estimate so the
 * cost of including it in a context package is visible before it is incurred.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { records, relationships, db, config } = getServices();

  const record = records.get(id);
  if (record === null) {
    return NextResponse.json({ error: 'Record not found' }, { status: 404 });
  }

  const outbound = relationships.forRecord(id);
  const inbound = relationships.backlinksTo(id);

  const hydrate = (
    list: readonly { id: string; sourceId: string; targetId: string; type: string; origin: string; confidence: number; approved: boolean }[],
    direction: 'out' | 'in',
  ) =>
    list.map((rel) => {
      const otherId = direction === 'out' ? rel.targetId : rel.sourceId;
      const other = records.get(otherId);
      return {
        id: rel.id,
        type: rel.type,
        origin: rel.origin,
        confidence: rel.confidence,
        approved: rel.approved,
        otherId,
        otherTitle: other?.title ?? '(missing)',
        otherPath: other?.vaultPath ?? null,
        otherType: other?.recordType ?? null,
      };
    });

  const unresolved = db
    .prepare('SELECT raw_target, link_kind FROM unresolved_links WHERE source_id = ?')
    .all(id) as { raw_target: string; link_kind: string }[];

  const citations = db
    .prepare('SELECT id, source_path, excerpt, created_at FROM citations WHERE record_id = ?')
    .all(id) as { id: string; source_path: string | null; excerpt: string; created_at: string }[];

  const projects = db
    .prepare(
      `SELECT p.project_id AS id, r.title, p.role, p.is_primary
         FROM project_records p JOIN records r ON r.id = p.project_id
        WHERE p.record_id = ?`,
    )
    .all(id) as { id: string; title: string; role: string; is_primary: number }[];

  const revisions = db
    .prepare('SELECT id, ts, revision, author, note FROM revisions WHERE record_id = ? ORDER BY revision DESC LIMIT 20')
    .all(id) as { id: string; ts: string; revision: number; author: string; note: string | null }[];

  const bodyTokens = tokenEstimator.estimate(record.body ?? '');
  const metadataTokens = tokenEstimator.estimate(
    `${record.title}\n${record.summary ?? ''}\n${JSON.stringify(record.data['tags'] ?? [])}`,
  );

  return NextResponse.json({
    record,
    vaultName: config.vaultRoot.split(/[\\/]/).pop() ?? 'vault',
    relationships: {
      outbound: hydrate(outbound, 'out'),
      inbound: hydrate(inbound, 'in'),
      unresolved,
    },
    citations,
    projects: projects.map((p) => ({ ...p, isPrimary: p.is_primary === 1 })),
    revisions,
    tokens: {
      metadata: metadataTokens,
      full: bodyTokens + metadataTokens,
      body: bodyTokens,
    },
  });
}

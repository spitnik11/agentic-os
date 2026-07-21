import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RECORD_TYPES } from '../../../domain/model/types.js';
import { getServices } from '../../../infrastructure/container.js';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q: z.string().max(500).default(''),
  types: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Unified search. Runs entirely on SQLite FTS5 at Token Class 0, so search
 * works with AI switched off and costs nothing per query.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    q: params.get('q') ?? '',
    types: params.get('types') ?? undefined,
    limit: params.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid search parameters' }, { status: 400 });
  }

  const { q, types, limit } = parsed.data;
  const { records } = getServices();

  const typeFilter =
    types === undefined
      ? undefined
      : types
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is (typeof RECORD_TYPES)[number] =>
            (RECORD_TYPES as readonly string[]).includes(t),
          );

  const started = Date.now();
  const hits =
    q.trim() === ''
      ? records.list({ recordTypes: typeFilter, limit })
      : records.search(q, limit).filter(
          (r) => typeFilter === undefined || typeFilter.length === 0 || typeFilter.includes(r.recordType),
        );

  return NextResponse.json({
    query: q,
    tokenClass: 0,
    durationMs: Date.now() - started,
    count: hits.length,
    results: hits.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      recordType: r.recordType,
      vaultPath: r.vaultPath,
      provenance: r.provenance,
      aiGenerated: r.aiGenerated,
      humanVerified: r.humanVerified,
      updatedAt: r.updatedAt,
    })),
  });
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  buildKnowledgeTree,
  buildProjectTree,
  buildVaultTree,
  type TreeMode,
} from '../../../application/tree/build-tree.js';
import { getServices } from '../../../infrastructure/container.js';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  mode: z.enum(['knowledge', 'vault', 'project']).default('knowledge'),
});

export async function GET(request: NextRequest) {
  const parsed = QuerySchema.safeParse({
    mode: request.nextUrl.searchParams.get('mode') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });
  }

  const mode: TreeMode = parsed.data.mode;
  const { records, config, db } = getServices();

  switch (mode) {
    case 'knowledge':
      return NextResponse.json({ mode, nodes: buildKnowledgeTree(records, config.managedFolder) });

    case 'vault': {
      const all = records.list({ limit: 5000 });
      return NextResponse.json({ mode, nodes: buildVaultTree(all, config.managedFolder) });
    }

    case 'project': {
      const membership = db
        .prepare('SELECT project_id, record_id, role FROM project_records')
        .all() as { project_id: string; record_id: string; role: string }[];
      return NextResponse.json({
        mode,
        nodes: buildProjectTree(
          records,
          membership.map((m) => ({ projectId: m.project_id, recordId: m.record_id, role: m.role })),
        ),
      });
    }
  }
}

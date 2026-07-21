import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ingestDrop, INGESTION_LIMITS } from '../../../application/ingestion/ingest.js';
import { MANAGED_CATEGORIES } from '../../../application/tree/build-tree.js';
import { materializeRecord } from '../../../application/sync/materialize.js';
import { getServices } from '../../../infrastructure/container.js';

export const dynamic = 'force-dynamic';

const VALID_CATEGORIES = new Set<string>(MANAGED_CATEGORIES.map((c) => c.slug));

const FieldsSchema = z.object({
  category: z.string().refine((v) => VALID_CATEGORIES.has(v), {
    message: 'Unknown category',
  }),
  projectId: z.string().nullable().default(null),
});

/**
 * Accept dropped files.
 *
 * Runs at Token Class 0: preserve, hash, deduplicate, extract, catalog. No
 * model is called, so a drop costs nothing and works with AI switched off.
 */
export async function POST(request: NextRequest) {
  const services = getServices();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 });
  }

  const fields = FieldsSchema.safeParse({
    category: form.get('category'),
    projectId: form.get('projectId') === null || form.get('projectId') === '' ? null : form.get('projectId'),
  });

  if (!fields.success) {
    return NextResponse.json(
      { error: fields.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files were included in the drop.' }, { status: 400 });
  }
  if (files.length > INGESTION_LIMITS.maxFiles) {
    return NextResponse.json(
      { error: `Too many files: ${files.length}. The limit is ${INGESTION_LIMITS.maxFiles} per drop.` },
      { status: 413 },
    );
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (totalBytes > INGESTION_LIMITS.maxTotalBytes) {
    return NextResponse.json(
      {
        error: `Drop is ${(totalBytes / 1024 / 1024).toFixed(0)} MB, above the ${
          INGESTION_LIMITS.maxTotalBytes / 1024 / 1024
        } MB limit for a single operation.`,
      },
      { status: 413 },
    );
  }

  const outcomes: (Awaited<ReturnType<typeof ingestDrop>> & { vaultPath?: string | null })[] = [];
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const outcome = await ingestDrop(
      {
        filename: file.name,
        bytes,
        dropCategory: fields.data.category,
        projectId: fields.data.projectId,
      },
      {
        files: services.files,
        records: services.records,
        audit: services.audit,
        db: services.db,
        managedFolder: services.config.managedFolder,
        privacyFor: (p) => services.privacy.levelFor(p),
      },
    );

    // Write the record out as a real Markdown note so the imported item exists
    // in Obsidian and survives the loss of this application's database.
    let vaultPath: string | null = null;
    if (outcome.recordId !== null) {
      const record = services.records.get(outcome.recordId);
      if (record !== null) {
        const materialized = await materializeRecord(record, {
          files: services.files,
          records: services.records,
          audit: services.audit,
          managedFolder: services.config.managedFolder,
        });
        vaultPath = materialized.vaultPath;

        // Re-point the undo entry at the note that was actually written.
        // Without the path, undo archives the record and the next reindex
        // rebuilds it straight back off the orphaned file.
        if (vaultPath !== null) {
          services.audit.record({
            actor: 'user',
            action: 'ingest.materialize',
            targetId: outcome.recordId,
            targetPath: vaultPath,
            detail: { filename: file.name },
            undo: { kind: 'remove_imported_note', recordId: outcome.recordId, vaultPath },
          });
        }
      }
    }

    outcomes.push({ ...outcome, vaultPath });
  }

  return NextResponse.json({
    tokenClass: 0,
    accepted: outcomes.filter((o) => o.state === 'cataloged').length,
    duplicates: outcomes.filter((o) => o.state === 'duplicate').length,
    quarantined: outcomes.filter((o) => o.state === 'quarantined').length,
    failed: outcomes.filter((o) => o.state === 'failed').length,
    outcomes,
  });
}

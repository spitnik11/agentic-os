import { NextResponse } from 'next/server';
import { getServices } from '../../../infrastructure/container.js';

export const dynamic = 'force-dynamic';

/**
 * Undo the most recent reversible action.
 *
 * Only actions that recorded an inverse operation are undoable, which is what
 * makes "important changes are reversible" a property of the system rather than
 * a promise in a document.
 */
export async function POST() {
  const { audit, records } = getServices();

  const event = audit.lastUndoable();
  if (event === null) {
    return NextResponse.json({ error: 'Nothing to undo.' }, { status: 404 });
  }

  const undo = event.undo;
  if (undo === null) {
    return NextResponse.json({ error: 'That action cannot be undone.' }, { status: 400 });
  }

  const kind = undo['kind'];

  switch (kind) {
    case 'remove_imported_note': {
      // Archiving the record is not enough: the materialized note is still on
      // disk, and the next reindex would rebuild the record straight off it.
      // The note has to go too, or the undo silently reverts itself.
      const recordId = undo['recordId'];
      const vaultPath = undo['vaultPath'];
      if (typeof recordId !== 'string' || typeof vaultPath !== 'string') {
        return NextResponse.json({ error: 'Malformed undo record.' }, { status: 500 });
      }

      const { files } = getServices();
      try {
        await files.remove(vaultPath);
      } catch (error) {
        return NextResponse.json(
          {
            error: `Could not remove the imported note: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          { status: 500 },
        );
      }

      records.archive(recordId, new Date().toISOString());
      audit.markUndone(event.id);
      audit.record({
        actor: 'user',
        action: 'undo.remove_imported_note',
        targetId: recordId,
        targetPath: vaultPath,
        detail: { undidEventId: event.id, originalAction: event.action },
        undo: null,
      });

      return NextResponse.json({
        undone: true,
        action: event.action,
        detail:
          'The imported note was removed from the vault. The original file is still preserved under .agentic-os/originals.',
      });
    }

    case 'archive_record': {
      const recordId = undo['recordId'];
      if (typeof recordId !== 'string') {
        return NextResponse.json({ error: 'Malformed undo record.' }, { status: 500 });
      }
      records.archive(recordId, new Date().toISOString());
      audit.markUndone(event.id);
      audit.record({
        actor: 'user',
        action: 'undo.archive_record',
        targetId: recordId,
        targetPath: null,
        detail: { undidEventId: event.id, originalAction: event.action },
        undo: null,
      });
      return NextResponse.json({
        undone: true,
        action: event.action,
        detail: 'The imported item was archived. The original file is still preserved.',
      });
    }

    default:
      return NextResponse.json(
        { error: `No handler for undo kind "${String(kind)}".` },
        { status: 500 },
      );
  }
}

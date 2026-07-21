'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { FolderTree, Layers, Moon, PanelLeft, RotateCw, Sun, Undo2 } from 'lucide-react';
import type { TreeMode, TreeNode } from '../../application/tree/build-tree.js';
import { CommandBar, type Command } from './CommandBar.js';
import { Inspector } from './Inspector.js';
import { Tree } from './Tree.js';
import { Overview } from './Overview.js';
import { RecordView } from './RecordView.js';
import { DropZone } from './DropZone.js';

const TREE_MODES: readonly { id: TreeMode; label: string; hint: string }[] = [
  { id: 'knowledge', label: 'Knowledge', hint: 'Logical categories. Nothing is moved on disk.' },
  { id: 'vault', label: 'Vault', hint: 'The real folder structure, exactly as Obsidian shows it.' },
  { id: 'project', label: 'Projects', hint: 'Grouped by project association.' },
];

type CenterView = { kind: 'home' } | { kind: 'record'; id: string } | { kind: 'category'; node: TreeNode };

export function Workspace() {
  const [mode, setMode] = useState<TreeMode>('knowledge');
  const [nodes, setNodes] = useState<readonly TreeNode[]>([]);
  const [treeState, setTreeState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [treeError, setTreeError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [center, setCenter] = useState<CenterView>({ kind: 'home' });
  const [filter, setFilter] = useState('');
  const [commandOpen, setCommandOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [status, setStatus] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const loadTree = useCallback((treeMode: TreeMode) => {
    setTreeState('loading');
    fetch(`/api/tree?mode=${treeMode}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Tree failed to load (${res.status})`);
        return (await res.json()) as { nodes: TreeNode[] };
      })
      .then((data) => {
        setNodes(data.nodes);
        setTreeState('ready');
      })
      .catch((e: unknown) => {
        setTreeError(e instanceof Error ? e.message : String(e));
        setTreeState('error');
      });
  }, []);

  useEffect(() => {
    loadTree(mode);
  }, [mode, loadTree, refreshKey]);

  const toggleTheme = useCallback(() => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('agentic-theme', next ? 'dark' : 'light');
    } catch {
      // Storage can be unavailable in private modes; the toggle still works
      // for this session.
    }
  }, [dark]);

  const openRecord = useCallback((id: string) => {
    setSelectedId(id);
    setInspectedId(id);
    setCenter({ kind: 'record', id });
  }, []);

  const reindex = useCallback(() => {
    setStatus('Reindexing the vault…');
    fetch('/api/index', { method: 'POST' })
      .then(async (res) => (await res.json()) as { scanned: number; indexed: number; unchanged: number })
      .then((r) => {
        setStatus(`Indexed ${r.indexed} of ${r.scanned} files (${r.unchanged} unchanged).`);
        setRefreshKey((k) => k + 1);
      })
      .catch(() => setStatus('Reindex failed. Check the server output.'));
  }, []);

  const undo = useCallback(() => {
    fetch('/api/undo', { method: 'POST' })
      .then(async (res) => {
        const data = (await res.json()) as { detail?: string; error?: string };
        setStatus(data.detail ?? data.error ?? 'Nothing to undo.');
        setRefreshKey((k) => k + 1);
      })
      .catch(() => setStatus('Undo failed.'));
  }, []);

  const commands: readonly Command[] = [
    { id: 'home', label: 'Go to Home', tokenClass: 0, run: () => setCenter({ kind: 'home' }) },
    { id: 'tree-knowledge', label: 'Switch to Knowledge tree', tokenClass: 0, run: () => setMode('knowledge') },
    { id: 'tree-vault', label: 'Switch to Vault tree', tokenClass: 0, run: () => setMode('vault') },
    { id: 'tree-project', label: 'Switch to Project tree', tokenClass: 0, run: () => setMode('project') },
    { id: 'reindex', label: 'Reindex the vault', hint: 'rescan markdown', tokenClass: 0, run: reindex },
    { id: 'undo', label: 'Undo the last change', tokenClass: 0, run: undo },
    { id: 'theme', label: dark ? 'Switch to light theme' : 'Switch to dark theme', tokenClass: 0, run: toggleTheme },
  ];

  // Global shortcuts. Ignored while typing so they cannot swallow input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === '/' && !typing && !commandOpen) {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commandOpen, undo]);

  /**
   * Handle a file dropped directly onto a tree node.
   *
   * The tree advertises a drop target (accent ring, copy cursor) for every
   * droppable node, so it has to actually accept the drop. Uses the same
   * endpoint as the centre-panel drop zone.
   */
  const onDropOnNode = useCallback((node: TreeNode, event: React.DragEvent) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;

    const category = node.id.startsWith('category:')
      ? node.id.slice('category:'.length)
      : node.label;

    const form = new FormData();
    form.set('category', category);
    for (const file of files) form.append('files', file);

    setStatus(`Importing ${files.length} file(s) into ${category}…`);
    fetch('/api/ingest', { method: 'POST', body: form })
      .then(async (res) => {
        const data = (await res.json()) as {
          error?: string;
          accepted?: number;
          duplicates?: number;
          quarantined?: number;
        };
        if (!res.ok) {
          setStatus(data.error ?? `Import failed (${res.status}).`);
          return;
        }
        const parts: string[] = [];
        if ((data.accepted ?? 0) > 0) parts.push(`${data.accepted} added`);
        if ((data.duplicates ?? 0) > 0) parts.push(`${data.duplicates} already present`);
        if ((data.quarantined ?? 0) > 0) parts.push(`${data.quarantined} held for review`);
        setStatus(parts.length > 0 ? `${parts.join(', ')} in ${category}.` : 'Nothing was imported.');
        setRefreshKey((k) => k + 1);
      })
      .catch(() => setStatus('Import failed. Check the server output.'));
  }, []);

  const onSelectNode = useCallback((node: TreeNode) => {
    setSelectedId(node.id);
    // On small screens the tree is an overlay; selecting something should
    // reveal it rather than leave the overlay covering the result.
    if (window.matchMedia('(max-width: 767px)').matches) setNavOpen(false);
    if (node.recordId !== null) {
      setInspectedId(node.recordId);
      setCenter({ kind: 'record', id: node.recordId });
    } else {
      setInspectedId(null);
      setCenter({ kind: 'category', node });
    }
  }, []);

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <div className="flex h-screen flex-col overflow-hidden bg-canvas">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
            aria-controls="tree-panel"
            className="rounded p-1.5 text-ink-faint hover:bg-raised hover:text-ink md:hidden"
          >
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Toggle the navigation panel</span>
          </button>

          <button
            type="button"
            onClick={() => setCenter({ kind: 'home' })}
            className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-ink"
          >
            <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
            Agentic OS
          </button>

          <span className="pill border-line-strong text-ink-faint" title="This is your real vault, not sample data">
            Private vault
          </span>

          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="ml-auto flex items-center gap-2 rounded border border-line px-2 py-1 text-xs text-ink-faint hover:border-line-strong hover:text-ink-muted"
          >
            Search or run a command
            <kbd className="kbd">Ctrl K</kbd>
          </button>

          <button
            type="button"
            onClick={undo}
            title="Undo the last reversible change (Ctrl+Z)"
            className="rounded p-1.5 text-ink-faint hover:bg-raised hover:text-ink"
          >
            <Undo2 className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Undo the last change</span>
          </button>

          <button
            type="button"
            onClick={reindex}
            title="Rescan the vault for changes"
            className="rounded p-1.5 text-ink-faint hover:bg-raised hover:text-ink"
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Reindex the vault</span>
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            className="rounded p-1.5 text-ink-faint hover:bg-raised hover:text-ink"
          >
            {dark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
            <span className="sr-only">{dark ? 'Switch to light theme' : 'Switch to dark theme'}</span>
          </button>
        </header>

        {/* Status messages are announced without stealing focus. */}
        <div aria-live="polite" className="sr-only">
          {status}
        </div>
        {status !== '' && (
          <div className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1 text-xs text-ink-muted">
            <span>{status}</span>
            <button
              type="button"
              onClick={() => setStatus('')}
              className="ml-auto text-2xs text-ink-faint hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1">
          {/* Scrim closes the overlay tree on small screens. */}
          {navOpen && (
            <button
              type="button"
              aria-label="Close the navigation panel"
              onClick={() => setNavOpen(false)}
              className="absolute inset-0 z-20 bg-black/40 md:hidden"
            />
          )}
          {/* Left: navigation */}
          {/*
            Below `md` the tree becomes an overlay rather than a third column:
            three fixed panels do not fit, and squeezing them makes all three
            unusable instead of one hidden.
          */}
          <nav
            id="tree-panel"
            aria-label="Knowledge tree"
            className={clsx(
              'flex-col border-r border-line bg-surface',
              'absolute inset-y-0 left-0 z-30 w-panel shadow-xl md:relative md:z-auto md:shadow-none',
              'md:flex md:w-panel md:shrink-0',
              navOpen ? 'flex' : 'hidden',
            )}
          >
            <div className="flex shrink-0 gap-0.5 border-b border-line p-1" role="tablist" aria-label="Tree mode">
              {TREE_MODES.map((m) => (
                <button
                  key={m.id}
                  role="tab"
                  aria-selected={mode === m.id}
                  // The hint is a description, not the name: a `title` here
                  // would replace the visible label as the accessible name and
                  // break "label in name" for voice control.
                  aria-describedby={`tree-mode-hint-${m.id}`}
                  onClick={() => setMode(m.id)}
                  className={clsx(
                    'flex-1 rounded px-2 py-1 text-xs transition-colors',
                    mode === m.id
                      ? 'bg-accent-soft font-medium text-ink'
                      : 'text-ink-faint hover:bg-raised hover:text-ink-muted',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Descriptions referenced by the tabs above. */}
            <div className="sr-only">
              {TREE_MODES.map((m) => (
                <span key={m.id} id={`tree-mode-hint-${m.id}`}>
                  {m.hint}
                </span>
              ))}
            </div>

            <div className="shrink-0 border-b border-line p-1.5">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter the tree"
                className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {treeState === 'loading' && (
                <div className="space-y-2 p-3" aria-busy="true">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-4 animate-pulse rounded bg-raised" style={{ width: `${90 - i * 8}%` }} />
                  ))}
                </div>
              )}
              {treeState === 'error' && (
                <div className="p-3" role="alert">
                  <p className="text-xs text-critical">{treeError}</p>
                  <button
                    type="button"
                    onClick={() => loadTree(mode)}
                    className="mt-2 rounded border border-line px-2 py-1 text-xs hover:border-accent"
                  >
                    Try again
                  </button>
                </div>
              )}
              {treeState === 'ready' && (
                <Tree
                  nodes={nodes}
                  selectedId={selectedId}
                  onSelect={onSelectNode}
                  filter={filter}
                  onDropOn={onDropOnNode}
                />
              )}
            </div>

            <div className="shrink-0 border-t border-line px-2 py-1.5">
              <p className="flex items-center gap-1 text-2xs text-ink-faint">
                <FolderTree className="h-3 w-3" aria-hidden="true" />
                {mode === 'vault'
                  ? 'Folders outside the managed area are read only.'
                  : 'Categories are logical. Nothing moves on disk.'}
              </p>
            </div>
          </nav>

          {/* Centre: workspace */}
          <main id="main" className="min-w-0 flex-1 overflow-y-auto">
            {center.kind === 'home' && <Overview key={refreshKey} onOpenRecord={openRecord} />}
            {center.kind === 'record' && <RecordView recordId={center.id} onOpenRecord={openRecord} />}
            {center.kind === 'category' && (
              <DropZone
                node={center.node}
                onOpenRecord={openRecord}
                onIngested={(message) => {
                  setStatus(message);
                  setRefreshKey((k) => k + 1);
                }}
              />
            )}
          </main>

          {/* Right: inspector */}
          {/* The inspector is supplementary; it yields first when space is tight. */}
          <aside
            aria-label="Context inspector"
            className="hidden w-inspector shrink-0 border-l border-line bg-surface xl:block"
          >
            <Inspector recordId={inspectedId} onSelectRecord={openRecord} />
          </aside>
        </div>
      </div>

      <CommandBar
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        commands={commands}
        onOpenRecord={openRecord}
      />
    </>
  );
}

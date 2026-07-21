'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import { recordTypeLabel } from '../lib/format.js';

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly tokenClass: number;
  readonly run: () => void;
}

interface SearchHit {
  id: string;
  title: string;
  summary: string | null;
  recordType: string;
  vaultPath: string | null;
}

interface CommandBarProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly commands: readonly Command[];
  readonly onOpenRecord: (id: string) => void;
}

/**
 * Command palette and search, in one surface.
 *
 * Typing filters commands and searches the vault at the same time, because in
 * practice a person does not know in advance whether what they want is an
 * action or a note.
 */
export function CommandBar({ open, onClose, commands, onOpenRecord }: CommandBarProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Remember what had focus so it can be restored when the dialog closes.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setHits([]);
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      restoreFocusRef.current?.focus?.();
    }
  }, [open]);

  // Debounced search so typing does not fire a request per keystroke.
  useEffect(() => {
    if (!open || query.trim() === '') {
      setHits([]);
      return;
    }
    const handle = setTimeout(() => {
      setSearching(true);
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`)
        .then(async (res) => (res.ok ? ((await res.json()) as { results: SearchHit[] }) : { results: [] }))
        .then((data) => setHits(data.results))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 160);
    return () => clearTimeout(handle);
  }, [query, open]);

  const filteredCommands = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term === '') return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(term) || (c.hint ?? '').toLowerCase().includes(term),
    );
  }, [commands, query]);

  const items = useMemo(
    () => [
      ...filteredCommands.map((c) => ({ kind: 'command' as const, command: c })),
      ...hits.map((h) => ({ kind: 'record' as const, hit: h })),
    ],
    [filteredCommands, hits],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length]);

  const activate = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return;
      if (item.kind === 'command') item.command.run();
      else onOpenRecord(item.hit.id);
      onClose();
    },
    [items, onClose, onOpenRecord],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
          break;
        case 'Enter':
          event.preventDefault();
          activate(activeIndex);
          break;
        case 'Tab': {
          // Focus stays inside the dialog while it is open.
          event.preventDefault();
          break;
        }
        default:
          break;
      }
    },
    [activate, activeIndex, items.length, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette and search"
        className="w-full max-w-xl overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl animate-slide-up"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the vault, or type a command…"
            aria-label="Search the vault or type a command"
            aria-controls="command-results"
            aria-activedescendant={items.length > 0 ? `command-item-${activeIndex}` : undefined}
            className="focus-none w-full bg-transparent py-3 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd className="kbd shrink-0">Esc</kbd>
        </div>

        <div id="command-results" role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-1">
          {items.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-ink-faint">
              {searching ? 'Searching…' : query.trim() === '' ? 'Start typing.' : 'No matches.'}
            </p>
          )}

          {filteredCommands.length > 0 && (
            <p className="eyebrow px-2 pb-1 pt-2">Actions</p>
          )}
          {items.map((item, index) => {
            const active = index === activeIndex;
            if (item.kind === 'command') {
              return (
                <div
                  key={`c-${item.command.id}`}
                  id={`command-item-${index}`}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(index)}
                  className={clsx('row cursor-pointer', active && 'bg-accent-soft text-ink')}
                >
                  <span className="flex-1 truncate">{item.command.label}</span>
                  {item.command.tokenClass === 0 ? (
                    <span className="pill border-positive/40 text-positive" title="Runs locally, no cost">
                      free
                    </span>
                  ) : (
                    <span className="pill border-info/40 text-info" title="Uses tokens">
                      class {item.command.tokenClass}
                    </span>
                  )}
                </div>
              );
            }

            const isFirstRecord =
              index === filteredCommands.length && hits.length > 0;
            return (
              <div key={`r-${item.hit.id}`}>
                {isFirstRecord && <p className="eyebrow px-2 pb-1 pt-2">Vault</p>}
                <div
                  id={`command-item-${index}`}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(index)}
                  className={clsx('row cursor-pointer', active && 'bg-accent-soft text-ink')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.hit.title}</span>
                    {item.hit.vaultPath !== null && (
                      <span className="block truncate font-mono text-2xs text-ink-faint">
                        {item.hit.vaultPath}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-2xs text-ink-faint">
                    {recordTypeLabel(item.hit.recordType)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-2xs text-ink-faint">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> open
          </span>
          <span className="ml-auto">Search runs locally and costs nothing.</span>
        </div>
      </div>
    </div>
  );
}

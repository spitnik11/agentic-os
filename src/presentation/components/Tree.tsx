'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, FileText, Folder, FolderOpen, Hash, Lock, Search } from 'lucide-react';
import type { TreeNode } from '../../application/tree/build-tree.js';
import { Badge, type Tone } from './Badge.js';

interface TreeProps {
  readonly nodes: readonly TreeNode[];
  readonly selectedId: string | null;
  readonly onSelect: (node: TreeNode) => void;
  readonly onDropOn?: (node: TreeNode, event: React.DragEvent) => void;
  readonly filter: string;
}

/**
 * Keyboard-navigable tree following the WAI-ARIA treeview pattern.
 *
 * Roving tabindex: exactly one row is tabbable, and arrow keys move focus
 * within the tree, so a keyboard user reaches the tree in one Tab press and
 * does not have to tab through several hundred rows to leave it.
 */
export function Tree({ nodes, selectedId, onSelect, onDropOn, filter }: TreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Filter the tree, keeping any branch that contains a match. */
  const visibleNodes = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (term === '') return nodes;

    const prune = (node: TreeNode): TreeNode | null => {
      const selfMatches = node.label.toLowerCase().includes(term);
      const children = node.children.map(prune).filter((n): n is TreeNode => n !== null);
      if (!selfMatches && children.length === 0) return null;
      return { ...node, children: selfMatches ? node.children : children };
    };

    return nodes.map(prune).filter((n): n is TreeNode => n !== null);
  }, [nodes, filter]);

  /** Flatten what is currently on screen so arrow keys can step through it. */
  const flattened = useMemo(() => {
    const out: { node: TreeNode; depth: number }[] = [];
    const walk = (list: readonly TreeNode[], depth: number): void => {
      for (const node of list) {
        out.push({ node, depth });
        const isOpen = expanded.has(node.id) || (filter.trim() !== '' && node.children.length > 0);
        if (isOpen && node.children.length > 0) walk(node.children, depth + 1);
      }
    };
    walk(visibleNodes, 0);
    return out;
  }, [visibleNodes, expanded, filter]);

  const activeId = focusedId ?? selectedId ?? flattened[0]?.node.id ?? null;

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    // The DOM id is derived from the node id, which can contain characters that
    // are not valid in a CSS selector, so query by attribute value instead.
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    el?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, node: TreeNode, index: number) => {
      const isOpen = expanded.has(node.id);
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          const next = flattened[index + 1];
          if (next !== undefined) focusRow(next.node.id);
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          const prev = flattened[index - 1];
          if (prev !== undefined) focusRow(prev.node.id);
          break;
        }
        case 'ArrowRight': {
          event.preventDefault();
          if (node.children.length > 0 && !isOpen) toggle(node.id);
          else {
            const next = flattened[index + 1];
            if (next !== undefined) focusRow(next.node.id);
          }
          break;
        }
        case 'ArrowLeft': {
          event.preventDefault();
          if (node.children.length > 0 && isOpen) toggle(node.id);
          else {
            // Move to the parent, which is the nearest row above at less depth.
            const depth = flattened[index]?.depth ?? 0;
            for (let i = index - 1; i >= 0; i--) {
              const candidate = flattened[i];
              if (candidate !== undefined && candidate.depth < depth) {
                focusRow(candidate.node.id);
                break;
              }
            }
          }
          break;
        }
        case 'Home': {
          event.preventDefault();
          const first = flattened[0];
          if (first !== undefined) focusRow(first.node.id);
          break;
        }
        case 'End': {
          event.preventDefault();
          const last = flattened[flattened.length - 1];
          if (last !== undefined) focusRow(last.node.id);
          break;
        }
        case 'Enter':
        case ' ': {
          event.preventDefault();
          if (node.children.length > 0) toggle(node.id);
          onSelect(node);
          break;
        }
        default:
          break;
      }
    },
    [expanded, flattened, focusRow, onSelect, toggle],
  );

  if (flattened.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <Search className="mx-auto mb-2 h-4 w-4 text-ink-faint" aria-hidden="true" />
        <p className="text-xs text-ink-faint">
          {filter.trim() === '' ? 'Nothing indexed yet.' : `No match for “${filter}”.`}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label="Knowledge navigation"
      className="px-1 py-1"
    >
      {flattened.map(({ node, depth }, index) => {
        const isOpen = expanded.has(node.id);
        const hasChildren = node.children.length > 0;
        const isSelected = selectedId === node.id;
        const isDropTarget = dropTargetId === node.id;

        return (
          <div
            key={node.id}
            data-node-id={node.id}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-level={depth + 1}
            tabIndex={activeId === node.id ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, node, index)}
            onFocus={() => setFocusedId(node.id)}
            onClick={() => {
              if (hasChildren) toggle(node.id);
              onSelect(node);
            }}
            onDragOver={(e) => {
              if (!node.droppable || onDropOn === undefined) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDropTargetId(node.id);
            }}
            onDragLeave={() => setDropTargetId((cur) => (cur === node.id ? null : cur))}
            onDrop={(e) => {
              setDropTargetId(null);
              if (!node.droppable || onDropOn === undefined) return;
              e.preventDefault();
              onDropOn(node, e);
            }}
            className={clsx(
              'row cursor-pointer select-none',
              isSelected && 'bg-accent-soft text-ink',
              isDropTarget && 'ring-1 ring-accent bg-accent-soft/60',
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {hasChildren ? (
                <ChevronRight
                  aria-hidden="true"
                  className={clsx('h-3 w-3 transition-transform', isOpen && 'rotate-90')}
                />
              ) : null}
            </span>

            <NodeIcon node={node} isOpen={isOpen} />

            <span className="min-w-0 flex-1 truncate">{node.label}</span>

            {node.badges.map((badge) => (
              <Badge key={badge.label} tone={badge.tone as Tone} glyph={badge.glyph} title={badge.title}>
                {badge.label}
              </Badge>
            ))}

            {!node.writable && node.kind === 'folder' && (
              <Lock className="h-3 w-3 shrink-0 text-ink-faint" aria-label="Read only" />
            )}

            {node.count > 0 && (
              <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">
                {node.count}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NodeIcon({ node, isOpen }: { readonly node: TreeNode; readonly isOpen: boolean }) {
  const className = 'h-3.5 w-3.5 shrink-0 text-ink-faint';
  switch (node.kind) {
    case 'folder':
    case 'category':
    case 'project':
      return isOpen ? (
        <FolderOpen className={className} aria-hidden="true" />
      ) : (
        <Folder className={className} aria-hidden="true" />
      );
    case 'query':
      return <Hash className={className} aria-hidden="true" />;
    default:
      return <FileText className={className} aria-hidden="true" />;
  }
}

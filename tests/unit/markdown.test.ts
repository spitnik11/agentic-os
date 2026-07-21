import { describe, expect, it } from 'vitest';
import {
  contentHash,
  extractTags,
  extractTasks,
  parseMarkdown,
  parseYamlFrontmatter,
  resolveWikiLink,
  serializeFrontmatter,
  splitFrontmatter,
} from '../../src/domain/markdown/parse.js';

describe('splitFrontmatter', () => {
  it('separates a leading YAML block from the body', () => {
    const { raw, body } = splitFrontmatter('---\ntitle: Hello\n---\n# Heading\n\nText.');
    expect(raw).toBe('title: Hello');
    expect(body).toBe('# Heading\n\nText.');
  });

  it('tolerates a UTF-8 BOM, which the vault files carry', () => {
    const { raw } = splitFrontmatter('﻿---\ntitle: Hello\n---\nBody');
    expect(raw).toBe('title: Hello');
  });

  it('treats a mid-document fence as content, not frontmatter', () => {
    const { raw, body } = splitFrontmatter('# Heading\n\n---\nnot: frontmatter\n---\n');
    expect(raw).toBeNull();
    expect(body).toContain('not: frontmatter');
  });

  it('does not lose the body when the closing fence is missing', () => {
    const { raw, body } = splitFrontmatter('---\ntitle: Unclosed\n\nStill text');
    expect(raw).toBeNull();
    expect(body).toContain('Still text');
  });
});

describe('parseYamlFrontmatter', () => {
  it('reads scalars, lists, and inline lists', () => {
    const fm = parseYamlFrontmatter(
      ['title: A Note', 'count: 42', 'ratio: 0.5', 'done: true', 'missing: null', 'tags:', '  - one', '  - two', 'inline: [a, b]'].join('\n'),
    );
    expect(fm['title']).toBe('A Note');
    expect(fm['count']).toBe(42);
    expect(fm['ratio']).toBe(0.5);
    expect(fm['done']).toBe(true);
    expect(fm['missing']).toBeNull();
    expect(fm['tags']).toEqual(['one', 'two']);
    expect(fm['inline']).toEqual(['a', 'b']);
  });

  it('strips quotes without mangling inner content', () => {
    const fm = parseYamlFrontmatter('title: "A: colon inside"');
    expect(fm['title']).toBe('A: colon inside');
  });
});

describe('serializeFrontmatter', () => {
  it('round-trips through the parser', () => {
    const original = { title: 'Round: trip', tags: ['a', 'b'], done: true, count: 3 };
    const yaml = serializeFrontmatter(original);
    const { raw } = splitFrontmatter(yaml + '\nbody');
    expect(raw).not.toBeNull();
    expect(parseYamlFrontmatter(raw!)).toEqual(original);
  });

  it('quotes values that would otherwise change type', () => {
    expect(serializeFrontmatter({ v: 'true' })).toContain('"true"');
    expect(serializeFrontmatter({ v: '42' })).toContain('"42"');
  });
});

describe('wikilinks', () => {
  it('extracts targets, anchors, aliases, and embeds', () => {
    const parsed = parseMarkdown('See [[Note A]] and [[Folder/Note B#Section|alias]] and ![[Image.png]]');
    expect(parsed.wikiLinks).toHaveLength(3);
    expect(parsed.wikiLinks[0]?.target).toBe('Note A');
    expect(parsed.wikiLinks[1]?.anchor).toBe('Section');
    expect(parsed.wikiLinks[1]?.alias).toBe('alias');
    expect(parsed.wikiLinks[2]?.embed).toBe(true);
  });

  it('ignores links inside fenced code, which are examples not references', () => {
    const parsed = parseMarkdown('```\n[[Not A Link]]\n```\n\n[[Real Link]]');
    expect(parsed.wikiLinks.map((l) => l.target)).toEqual(['Real Link']);
  });

  it('ignores links inside inline code', () => {
    const parsed = parseMarkdown('Use `[[syntax]]` to link. [[Actual]]');
    expect(parsed.wikiLinks.map((l) => l.target)).toEqual(['Actual']);
  });
});

describe('resolveWikiLink', () => {
  const paths = ['02 Projects/SignRise/PROJECT.md', 'Notes/PROJECT.md', 'Inbox/Idea.md'];

  it('matches a bare basename', () => {
    expect(resolveWikiLink('Idea', paths)).toBe('Inbox/Idea.md');
  });

  it('matches a path fragment exactly when given one', () => {
    expect(resolveWikiLink('02 Projects/SignRise/PROJECT', paths)).toBe('02 Projects/SignRise/PROJECT.md');
  });

  it('prefers the shallowest path when a basename is ambiguous', () => {
    expect(resolveWikiLink('PROJECT', paths)).toBe('Notes/PROJECT.md');
  });

  it('returns null for a target that does not exist', () => {
    expect(resolveWikiLink('Nonexistent', paths)).toBeNull();
  });
});

describe('tags and tasks', () => {
  it('merges frontmatter tags with inline tags and removes the hash', () => {
    const tags = extractTags('Body with #inline and #nested/tag', { tags: ['#front', 'plain'] });
    expect(tags).toEqual(['front', 'inline', 'nested/tag', 'plain']);
  });

  it('does not treat a heading as a tag', () => {
    expect(extractTags('# Heading', {})).toEqual([]);
  });

  it('reads checkbox state', () => {
    const tasks = extractTasks('- [ ] open\n- [x] done\n- plain bullet');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.checked).toBe(false);
    expect(tasks[1]?.checked).toBe(true);
  });
});

describe('contentHash', () => {
  it('is stable for identical input', () => {
    expect(contentHash('same')).toBe(contentHash('same'));
  });

  it('changes when a single character changes', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

import clsx from 'clsx';

export type Tone = 'neutral' | 'positive' | 'caution' | 'critical' | 'info' | 'accent';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-line-strong text-ink-faint',
  positive: 'border-positive/40 text-positive',
  caution: 'border-caution/40 text-caution',
  critical: 'border-critical/40 text-critical',
  info: 'border-info/40 text-info',
  accent: 'border-accent/40 text-accent',
};

interface BadgeProps {
  readonly tone?: Tone;
  /**
   * A short glyph shown alongside the label. Status is never conveyed by colour
   * alone, so this is not decorative: it is the redundant channel that keeps the
   * badge legible to anyone who cannot distinguish the hues.
   */
  readonly glyph?: string;
  readonly title?: string;
  readonly children: React.ReactNode;
}

export function Badge({ tone = 'neutral', glyph, title, children }: BadgeProps) {
  return (
    <span className={clsx('pill', TONE_CLASSES[tone])} title={title}>
      {glyph !== undefined && (
        <span aria-hidden="true" className="leading-none">
          {glyph}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}

/**
 * Provenance is shown on every record. The wording is deliberately plain:
 * a reader should never have to guess whether they are looking at something
 * they wrote or something a model produced.
 */
export function ProvenanceBadge({ provenance }: { readonly provenance: string }) {
  const map: Record<string, { tone: Tone; glyph: string; label: string; title: string }> = {
    original_user_content: { tone: 'positive', glyph: '✎', label: 'Yours', title: 'Written by you' },
    imported_obsidian_note: { tone: 'neutral', glyph: '◈', label: 'Vault note', title: 'Existing note read from the vault' },
    imported_third_party: { tone: 'neutral', glyph: '↓', label: 'Imported', title: 'Imported from an external source' },
    deterministic_extraction: { tone: 'neutral', glyph: '⚙', label: 'Extracted', title: 'Extracted by code, no model involved' },
    ai_extracted: { tone: 'info', glyph: '◆', label: 'AI extracted', title: 'Pulled out by a model; verify before relying on it' },
    ai_generated_summary: { tone: 'info', glyph: '◆', label: 'AI summary', title: 'Written by a model; verify before relying on it' },
    ai_inference: { tone: 'caution', glyph: '◇', label: 'AI inference', title: 'A model’s guess, not a stated fact' },
    user_confirmed: { tone: 'positive', glyph: '✓', label: 'Confirmed', title: 'You have confirmed this' },
    disputed: { tone: 'critical', glyph: '≠', label: 'Disputed', title: 'Conflicting evidence exists' },
    superseded: { tone: 'caution', glyph: '⤳', label: 'Superseded', title: 'Replaced by something newer' },
    outdated: { tone: 'caution', glyph: '◷', label: 'Outdated', title: 'Likely out of date' },
  };
  const entry = map[provenance] ?? {
    tone: 'neutral' as Tone,
    glyph: '?',
    label: provenance,
    title: provenance,
  };
  return (
    <Badge tone={entry.tone} glyph={entry.glyph} title={entry.title}>
      {entry.label}
    </Badge>
  );
}

/** Cost class of an action, shown before the user commits to it. */
export function TokenClassBadge({ tokenClass }: { readonly tokenClass: number }) {
  if (tokenClass === 0) {
    return (
      <Badge tone="positive" glyph="○" title="Runs locally. No tokens, no cost.">
        Free
      </Badge>
    );
  }
  const tone: Tone = tokenClass >= 4 ? 'critical' : tokenClass >= 3 ? 'caution' : 'info';
  const title =
    tokenClass === 4
      ? 'Recurring cost. Charges repeat on a schedule until you turn it off.'
      : 'Costs tokens each time it runs.';
  return (
    <Badge tone={tone} glyph="●" title={title}>
      Class {tokenClass}
    </Badge>
  );
}

// Collision-only editor-tab origin labels (#464). This is a pure projection of
// the established #427 ownership reference: `savedId` identifies the open
// document and Dashboard tile references identify its source. It deliberately
// stores no reverse origin on a tab or saved query.

import { buildQueryOwnershipIndex } from './query-ownership.js';
import type { StoredWorkspaceV5 } from '../../generated/json-schema.types.js';

export interface OriginBadgeTab {
  id: string;
  name: string;
  savedId: string | null;
  /** Dashboard-variable tabs have no saved query id, but their Dashboard
   * binding is already the canonical document identity (#457). */
  doc?: { kind: 'query' } | { kind: 'dashboard-variable'; dashboardId: string; variableName: string };
}

export type TabOriginKind = 'dashboard' | 'library' | 'draft';

export interface TabOriginBadge {
  tabId: string;
  kind: TabOriginKind;
  /** Full, always-available source text (not the compact collision badge). */
  context: string;
  /** Present only while another visible tab has the same displayed name. */
  badge: string | null;
}

interface ResolvedOrigin {
  kind: TabOriginKind;
  context: string;
  dashboardId?: string;
  dashboardTitle?: string;
}

const untitledDashboard = 'Untitled Dashboard';

/**
 * User-visible abbreviation operates on grapheme clusters, never UTF-16 code
 * units. ES2022 includes `Intl.Segmenter`, which keeps emoji, combining marks,
 * and zero-width-joiner sequences intact.
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (value: string): string[] => Array.from(
  graphemeSegmenter.segment(value),
  ({ segment }) => segment,
);

const firstGrapheme = (value: string): string => graphemes(value)[0] ?? '';
const graphemePrefix = (value: string, length: number): string => graphemes(value).slice(0, length).join('');

/** Every readable abbreviation, shortest first. Multi-word names start as an
 * initialism, then expand one word in place; a one-word name starts with a
 * three-character prefix. */
function abbreviationCandidates(title: string): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const length = graphemes(words[0]).length;
    return Array.from(
      { length: Math.max(1, length - Math.min(3, length) + 1) },
      (_, index) => graphemePrefix(words[0], Math.min(3, length) + index),
    );
  }
  const candidates = [words.map(firstGrapheme).join('')];
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const wordLength = graphemes(words[wordIndex]).length;
    for (let length = 2; length <= wordLength; length += 1) {
      candidates.push(words.map((word, index) => (
        index < wordIndex ? word : index === wordIndex ? graphemePrefix(word, length) : firstGrapheme(word)
      )).join(''));
    }
  }
  // Initialisms can collide with a single-word title (or with another
  // differently-spaced title). The readable whole title is still a source
  // label, and must be tried before falling back to opaque identity text.
  const readableTitle = words.join(' ');
  if (!candidates.includes(readableTitle)) candidates.push(readableTitle);
  return candidates;
}

/**
 * Compact, deterministic Dashboard labels. Only labels within the same visible
 * name collision group compete. A duplicate Dashboard title cannot become
 * unique by extension alone, so the shortest unique prefix of its stable
 * Dashboard id is appended as the final, exceptional tie-breaker.
 */
function dashboardBadges(origins: readonly ResolvedOrigin[]): string[] {
  const candidates = origins.map((origin) => abbreviationCandidates(origin.dashboardTitle!));
  const candidateIndexes = origins.map(() => 0);
  const labels = (): string[] => candidates.map((options, index) => options[candidateIndexes[index]]);
  let current = labels();
  let changed = true;
  while (changed) {
    const counts = new Map<string, number>();
    current.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
    const nextIndexes = current.map((label, index) => {
      if ((counts.get(label) ?? 0) <= 1) return candidateIndexes[index];
      return Math.min(candidateIndexes[index] + 1, candidates[index].length - 1);
    });
    changed = nextIndexes.some((value, index) => value !== candidateIndexes[index]);
    candidateIndexes.splice(0, candidateIndexes.length, ...nextIndexes);
    current = labels();
  }
  const counts = new Map<string, number>();
  current.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
  return current.map((label, index) => {
    if ((counts.get(label) ?? 0) <= 1) return label;
    const peerIndexes = current
      .map((candidate, peerIndex) => ({ candidate, peerIndex }))
      .filter(({ candidate }) => candidate === label)
      .map(({ peerIndex }) => peerIndex);
    // A full readable title is in every candidate sequence, so different
    // normalized titles should never reach this point. Keep that contract
    // explicit: an id is only an exceptional tie-breaker for truly identical
    // Dashboard titles, never a substitute for title disambiguation.
    const ids = peerIndexes.map((peerIndex) => origins[peerIndex].dashboardId!);
    let prefixLength = 1;
    while (prefixLength < Math.max(...ids.map((id) => id.length))
      && new Set(ids.map((id) => id.slice(0, prefixLength))).size < ids.length) {
      prefixLength += 1;
    }
    return `${label} · ${origins[index].dashboardId!.slice(0, prefixLength)}`;
  });
}

function resolveOrigins(
  tabs: readonly OriginBadgeTab[], workspace: StoredWorkspaceV5 | null,
): ResolvedOrigin[] {
  if (workspace === null) {
    return tabs.map((tab) => (tab.savedId === null
      ? { kind: 'draft' as const, context: 'Draft' }
      : { kind: 'library' as const, context: 'Library' }));
  }
  const ownership = buildQueryOwnershipIndex(workspace);
  return tabs.map((tab) => {
    const variable = tab.doc?.kind === 'dashboard-variable' ? tab.doc : null;
    if (variable !== null) {
      const dashboards = workspace.dashboards.filter((dashboard) => dashboard.id === variable.dashboardId);
      if (dashboards.length !== 1) return { kind: 'draft' as const, context: 'Draft' };
      const title = dashboards[0].title.trim() || untitledDashboard;
      return {
        kind: 'dashboard' as const,
        context: title,
        dashboardId: variable.dashboardId,
        dashboardTitle: title,
      };
    }
    if (tab.savedId === null) return { kind: 'draft' as const, context: 'Draft' };
    const owners = ownership.ownersByQueryId.get(tab.savedId) ?? [];
    if (owners.length !== 1) return { kind: 'library' as const, context: 'Library' };
    const dashboards = workspace.dashboards.filter((dashboard) => dashboard.id === owners[0].dashboardId);
    if (dashboards.length !== 1) return { kind: 'library' as const, context: 'Library' };
    const title = dashboards[0].title.trim() || untitledDashboard;
    return {
      kind: 'dashboard' as const,
      context: title,
      dashboardId: owners[0].dashboardId,
      dashboardTitle: title,
    };
  });
}

/**
 * Derive every tab's full source context and collision-only compact badge.
 * Names decide only whether a visible label is needed; document classification
 * always comes from `savedId` and the canonical Dashboard ownership index.
 */
export function planTabOriginBadges(
  tabs: readonly OriginBadgeTab[], workspace: StoredWorkspaceV5 | null,
): TabOriginBadge[] {
  const origins = resolveOrigins(tabs, workspace);
  const badges = tabs.map(() => null as string | null);
  const byName = new Map<string, number[]>();
  tabs.forEach((tab, index) => {
    const indexes = byName.get(tab.name);
    if (indexes) indexes.push(index);
    else byName.set(tab.name, [index]);
  });
  for (const indexes of byName.values()) {
    if (indexes.length < 2) continue;
    const dashboardIndexes = indexes.filter((index) => origins[index].kind === 'dashboard');
    const dashboardLabels = dashboardBadges(dashboardIndexes.map((index) => origins[index]));
    const dashboardLabelByIndex = new Map(dashboardIndexes.map((index, labelIndex) => [index, dashboardLabels[labelIndex]]));
    for (const index of indexes) {
      const origin = origins[index];
      badges[index] = origin.kind === 'dashboard'
        ? dashboardLabelByIndex.get(index)!
        : origin.kind === 'library' ? 'Library' : 'Draft';
    }
  }
  return tabs.map((tab, index) => ({
    tabId: tab.id, kind: origins[index].kind, context: origins[index].context, badge: badges[index],
  }));
}

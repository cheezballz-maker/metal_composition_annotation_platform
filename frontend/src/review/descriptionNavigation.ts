import type { ReviewComposition, ReviewConstituent } from "./types";
import { decodeEntity, tokenizeRawSource } from "./rawSource";

export type DescriptionWidths = { source: number; list: number };
export type OccurrenceEntry = { composition: ReviewComposition; occurrence: number; evidence: string[] };

const constituentNames = new Intl.Collator("en", { sensitivity: "base", numeric: true });
/** Sort a display projection, retaining original indices for edits and deletes. */
export function alphabeticalConstituents(rows: ReviewConstituent[], sortNames?: string[]) {
  return rows.map((row, index) => ({row,index})).sort((a,b) => {
    const left = sortNames?.[a.index] ?? a.row.constituent_name;
    const right = sortNames?.[b.index] ?? b.row.constituent_name;
    if (!left.trim() || !right.trim()) return left.trim() ? -1 : right.trim() ? 1 : a.index-b.index;
    return constituentNames.compare(left,right) || a.index-b.index;
  });
}

export function readableFragment(value: string): string {
  return tokenizeRawSource(value).map(token => token.kind === "text"
    ? token.value.replace(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    : token.kind === "break" || (token.kind === "close" && ["p", "div", "section", "claim", "tr", "td", "li"].includes(token.tag)) ? " " : "")
    .join("").replace(/\s+/g, " ").trim();
}

function evidenceQuotes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(evidenceQuotes);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    (key === "evidence_text" || key === "evidence") && typeof item === "string"
      ? [readableFragment(item)] : evidenceQuotes(item));
}

export function indexOccurrences(compositions: ReviewComposition[]): OccurrenceEntry[] {
  return compositions.map((composition, index) => ({ composition, occurrence: index + 1,
    evidence: [...new Set(evidenceQuotes(composition.data).filter(Boolean))] }));
}

export function filterOccurrences(entries: OccurrenceEntry[], fragment: string): OccurrenceEntry[] {
  const query = readableFragment(fragment).toLocaleLowerCase();
  return query ? entries.filter(entry => entry.evidence.some(text => text.toLocaleLowerCase().includes(query))) : entries;
}

/** Each divider redistributes its adjacent panes; the third pane stays fixed. */
export function resizeDescriptionPanels(widths: DescriptionWidths, boundary: "source" | "details", position: number, availableWidth: number): DescriptionWidths {
  availableWidth = Math.max(1, availableWidth);
  widths = fitDescriptionPanels(widths, availableWidth);
  const scale = Math.min(1, Math.max(1, availableWidth) / 720);
  const sourceMin = 260 * scale / availableWidth * 100;
  const listMin = 160 * scale / availableWidth * 100;
  const detailMin = 300 * scale / availableWidth * 100;
  if (boundary === "source") {
    const pair = widths.source + widths.list;
    const source = Math.max(sourceMin, Math.min(pair - listMin, position));
    return { source, list: pair - source };
  }
  return { source: widths.source, list: Math.max(listMin, Math.min(100 - widths.source - detailMin, position - widths.source)) };
}

/** Fit saved preferences to a narrower viewport without collapsing any pane. */
export function fitDescriptionPanels(widths: DescriptionWidths, availableWidth: number): DescriptionWidths {
  const width = Math.max(1, availableWidth);
  const scale = Math.min(1, width / 720) / width * 100;
  const source = Math.max(260 * scale, Math.min(100 - 460 * scale, widths.source));
  const list = Math.max(160 * scale, Math.min(100 - source - 300 * scale, widths.list));
  return { source, list };
}

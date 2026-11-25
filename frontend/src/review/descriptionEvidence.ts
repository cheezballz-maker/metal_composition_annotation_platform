import { codePointSlice, decodeEntity, tokenizeRawSource } from "./rawSource";
import type { RawEvidence, ReviewCompositionData } from "./types";

export function sameSpan(a: RawEvidence | null, b: RawEvidence | null): boolean {
  return Boolean(a && b && a.start === b.start && a.end === b.end);
}

export function instanceSpans(data: ReviewCompositionData | null): RawEvidence[] {
  const spans: RawEvidence[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (Number.isInteger(item.start) && Number.isInteger(item.end) && typeof item.evidence_text === "string") { spans.push(item as RawEvidence); return; }
    Object.values(item).forEach(visit);
  };
  visit(data);
  return [...new Map(spans.map(span => [`${span.start}:${span.end}`, span])).values()];
}

/** Update every reference to the same physical span within this instance only. */
export function changeInstanceSpan(data: ReviewCompositionData, before: RawEvidence, after: RawEvidence | null, content: string, requireInstanceEvidence = false): ReviewCompositionData {
  if (after && (!Number.isInteger(after.start) || !Number.isInteger(after.end) || after.start < 0 || after.end <= after.start || after.end > Array.from(content).length)) throw new Error("Choose a non-empty span within the source.");
  const replacement = after ? { start: after.start, end: after.end, evidence_text: codePointSlice(content, after.start, after.end) } : null;
  const visit = (value: unknown, path: string[] = []): unknown => {
    if (Array.isArray(value)) {
      const next = value.filter(v => replacement || !sameSpan(v as RawEvidence, before)).map(v => visit(v, path));
      if (!replacement && value.some(v => sameSpan(v as RawEvidence, before)) && path.includes("amounts") && path[path.length - 1] === "evidence_spans" && !next.length) throw new Error("This span is the only evidence for an amount. Assign another supporting span before deleting it.");
      if (!replacement && requireInstanceEvidence && path.length === 1 && path[0] === "evidence_spans" && !next.length) throw new Error("Keep at least one evidence span for this composition instance.");
      return next;
    }
    if (!value || typeof value !== "object") return value;
    if (sameSpan(value as RawEvidence, before)) {
      if (!replacement) throw new Error("This span supports a relationship. Assign different evidence in Relationships before deleting it.");
      return { ...value, ...replacement };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
  };
  return visit(data) as ReviewCompositionData;
}

/** Nudge visible character boundaries, preserving entities, Unicode, and markup. */
export function nudgeSpan(content: string, span: RawEvidence, side: "start" | "end", direction: -1 | 1): RawEvidence | null {
  const characters: Array<{start: number; end: number}> = [];
  for (const token of tokenizeRawSource(content)) {
    if (token.kind !== "text") continue;
    const points = Array.from(token.value);
    for (let i = 0; i < points.length;) {
      const entity = points[i] === "&" ? points.slice(i, i + 16).join("").match(/^&(?:#x[0-9a-f]+|#\d+|[a-z]+);/i)?.[0] : null;
      const size = entity && decodeEntity(entity) !== entity ? Array.from(entity).length : 1;
      characters.push({start: token.rawStart + i, end: token.rawStart + i + size});
      i += size;
    }
  }
  const inside = characters.filter(c => c.end > span.start && c.start < span.end);
  if (!inside.length) return null;
  let boundary: number | undefined;
  if (side === "start") {
    const first = inside[0];
    boundary = direction < 0 ? characters.filter(c => c.start < first.start).pop()?.start : first.end;
  } else {
    const last = inside[inside.length - 1];
    boundary = direction > 0 ? characters.find(c => c.end > last.end)?.end : last.start;
  }
  if (boundary == null) return null;
  const next = { ...span, [side]: boundary };
  if (next.start >= next.end || !characters.some(c => c.end > next.start && c.start < next.end)) return null;
  return {...next, evidence_text: codePointSlice(content, next.start, next.end)};
}

import { codePointLength, codePointSlice, utf16ToCodePointOffset } from "./rawSource";
import type { RawEvidence } from "./types";

/** Resolve stored raw code-point ranges first; never guess a range from a name. */
export function resolveEvidence(value: unknown, content: string, scope?: RawEvidence[]): RawEvidence[] {
  const length = codePointLength(content);
  const spans: RawEvidence[] = [];
  const texts: string[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const object = item as Record<string, unknown>;
    const start = object.start ?? object.start_offset;
    const end = object.end ?? object.end_offset;
    if (Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) > (start as number) && (end as number) <= length) {
      spans.push({ start: start as number, end: end as number, evidence_text: codePointSlice(content, start as number, end as number) });
      return;
    }
    // An invalid explicit offset must not silently fall back to another occurrence.
    if (start != null || end != null) return;
    for (const [key, child] of Object.entries(object)) {
      if ((key === "evidence" || key === "evidence_text") && typeof child === "string" && child.trim()) texts.push(child);
      else visit(child);
    }
  };
  visit(value);
  if (!spans.length) {
    for (const text of texts) {
      for (const range of scope ?? [{ start: 0, end: length, evidence_text: content }]) {
        const fragment = codePointSlice(content, range.start, range.end);
        let from = 0;
        while (from <= fragment.length) {
          const index = fragment.indexOf(text, from);
          if (index < 0) break;
          const start = range.start + utf16ToCodePointOffset(fragment, index);
          spans.push({ start, end: start + codePointLength(text), evidence_text: text });
          from = index + text.length;
        }
      }
    }
  }
  return Array.from(new Map(spans.map((span) => [`${span.start}:${span.end}`, span])).values()).sort((a, b) => a.start - b.start || a.end - b.end);
}

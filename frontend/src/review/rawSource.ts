/** Raw source offsets are Unicode code-point, half-open ranges. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function codePointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(Math.max(0, start), end == null ? undefined : Math.max(0, end)).join("");
}

/** Converts a DOM UTF-16 text offset to the raw source's code-point offset. */
export function utf16ToCodePointOffset(value: string, utf16Offset: number): number {
  const bounded = Math.min(Math.max(0, utf16Offset), value.length);
  let offset = 0;
  let count = 0;
  while (offset < bounded) {
    const point = value.codePointAt(offset);
    const width = point != null && point > 0xffff ? 2 : 1;
    if (offset + width > bounded) break;
    offset += width;
    count += 1;
  }
  return count;
}

export function codePointToUtf16Offset(value: string, codePointOffset: number): number {
  return Array.from(value).slice(0, Math.max(0, codePointOffset)).join("").length;
}

export type SourceToken =
  | { kind: "text"; rawStart: number; rawEnd: number; value: string }
  | { kind: "open"; rawStart: number; rawEnd: number; tag: string; className?: string; num?: string }
  | { kind: "close"; rawStart: number; rawEnd: number; tag: string }
  | { kind: "break"; rawStart: number; rawEnd: number }
  | { kind: "image"; rawStart: number; rawEnd: number; raw: string; missing: boolean };

const allowedTags = new Set(["article", "section", "div", "p", "span", "table", "thead", "tbody", "tr", "td", "th", "b", "strong", "i", "em", "u", "sub", "sup", "ol", "ul", "li", "br", "hr", "img", "claim", "seg", "seg-con", "seg-trans", "seg-refi", "seg-ref", "seg-claim", "seg-comp", "seg-clauses", "seg-main", "seg-enter", "h1", "h2", "h3", "h4", "h5", "h6"]);
const voidTags = new Set(["br", "hr", "img"]);

function parseTag(raw: string): { tag: string; closing: boolean; className?: string; num?: string } | null {
  const match = raw.match(/^<\s*(\/)?\s*([A-Za-z][A-Za-z0-9-]*)(?=\s|\/?>)[^<>]*>$/);
  if (!match || !allowedTags.has(match[2].toLowerCase())) return null;
  const classMatch = raw.match(/\bclass\s*=\s*(["'])([^"']*)\1/i);
  const numMatch = raw.match(/\bnum\s*=\s*(["'])([^"']*)\1/i);
  // Preserve only plain CSS-like tokens and claim numbers; no arbitrary attributes reach React.
  const className = classMatch?.[2].split(/\s+/).filter((name) => /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(name)).join(" ");
  const num = numMatch?.[2].match(/^[A-Za-z0-9._-]{1,80}$/)?.[0];
  return { tag: match[2].toLowerCase(), closing: Boolean(match[1]), className, num };
}

/**
 * Tokenizes only an explicit allowlist. A comparison like `<½` remains text;
 * tags are never injected back into the DOM as HTML.
 */
export function tokenizeRawSource(raw: string): SourceToken[] {
  const points = Array.from(raw);
  const tokens: SourceToken[] = [];
  let cursor = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) tokens.push({ kind: "text", rawStart: textStart, rawEnd: end, value: points.slice(textStart, end).join("") });
  };
  while (cursor < points.length) {
    if (points[cursor] !== "<") { cursor += 1; continue; }
    let close = cursor + 1;
    while (close < points.length && points[close] !== ">" && close - cursor < 1000) close += 1;
    if (close >= points.length || points[close] !== ">") { cursor += 1; continue; }
    const tagRaw = points.slice(cursor, close + 1).join("");
    const parsed = parseTag(tagRaw);
    if (!parsed) { cursor += 1; continue; }
    flush(cursor);
    const rawStart = cursor;
    const rawEnd = close + 1;
    if (parsed.tag === "img") tokens.push({ kind: "image", rawStart, rawEnd, raw: tagRaw, missing: /\bsrc\s*=\s*(["'])\s*\1/i.test(tagRaw) || !/\bsrc\s*=/i.test(tagRaw) });
    else if (parsed.tag === "br" || parsed.tag === "hr") tokens.push({ kind: "break", rawStart, rawEnd });
    else if (parsed.closing) tokens.push({ kind: "close", rawStart, rawEnd, tag: parsed.tag });
    else tokens.push({ kind: "open", rawStart, rawEnd, tag: parsed.tag, className: parsed.className, num: parsed.num });
    cursor = rawEnd;
    textStart = cursor;
  }
  flush(points.length);
  return tokens;
}

export type RawBoundary = { start: number; end: number };

function mappedSubtreeEdge(node: Node, preferEnd: boolean): number | null {
  const children = Array.from(node.childNodes);
  if (preferEnd) {
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const edge = mappedSubtreeEdge(children[index], true);
      if (edge != null) return edge;
    }
  }

  const element = node.nodeType === Node.TEXT_NODE
    ? node.parentElement?.closest("[data-raw-start]") as HTMLElement | null
    : node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.rawStart != null
      ? node as HTMLElement
      : null;
  if (element) {
    const value = Number(preferEnd ? element.dataset.rawEnd : element.dataset.rawStart);
    if (Number.isFinite(value)) return value;
  }

  if (!preferEnd) {
    for (const child of children) {
      const edge = mappedSubtreeEdge(child, false);
      if (edge != null) return edge;
    }
  }
  return null;
}

/** Uses node mappings instead of rendered text searches, so repeated text is safe. */
export function rawBoundaryFromDomPoint(node: Node, offset: number, preferEnd = false): number | null {
  const textNode = node.nodeType === Node.TEXT_NODE ? node : null;
  if (!textNode && node.nodeType === Node.ELEMENT_NODE) {
    const children = Array.from(node.childNodes);
    const boundary = Math.max(0, Math.min(offset, children.length));
    if (preferEnd) {
      for (let index = boundary - 1; index >= 0; index -= 1) {
        const edge = mappedSubtreeEdge(children[index], true);
        if (edge != null) return edge;
      }
      for (let index = boundary; index < children.length; index += 1) {
        const edge = mappedSubtreeEdge(children[index], false);
        if (edge != null) return edge;
      }
    } else {
      for (let index = boundary; index < children.length; index += 1) {
        const edge = mappedSubtreeEdge(children[index], false);
        if (edge != null) return edge;
      }
      for (let index = boundary - 1; index >= 0; index -= 1) {
        const edge = mappedSubtreeEdge(children[index], true);
        if (edge != null) return edge;
      }
    }
  }
  const container = textNode?.parentElement || (node.nodeType === Node.ELEMENT_NODE ? node as Element : null);
  const element = container?.closest("[data-raw-start]") as HTMLElement | null;
  if (!element) return null;
  const start = Number(element.dataset.rawStart);
  const end = Number(element.dataset.rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (!textNode) {
    // A Range endpoint on a container has no character offset. Its closest
    // mapped descendant is still deterministic: start for a start endpoint,
    // end for an end endpoint.
    return preferEnd ? end : start;
  }
  if (element.dataset.rawUnit === "entity") return offset <= 0 ? start : end;
  return start + utf16ToCodePointOffset((textNode as Text).data, offset);
}

export function rawRangeFromSelection(range: Range): RawBoundary | null {
  const start = rawBoundaryFromDomPoint(range.startContainer, range.startOffset, false);
  const end = rawBoundaryFromDomPoint(range.endContainer, range.endOffset, true);
  if (start == null || end == null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

export function decodeEntity(raw: string) {
  const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&nbsp;": "\u00a0", "&copy;": "©", "&reg;": "®", "&trade;": "™", "&micro;": "µ", "&deg;": "°", "&plusmn;": "±", "&frac14;": "¼", "&frac12;": "½", "&frac34;": "¾", "&ndash;": "–", "&mdash;": "—", "&hellip;": "…", "&lsquo;": "‘", "&rsquo;": "’", "&ldquo;": "“", "&rdquo;": "”" };
  if (named[raw]) return named[raw];
  const match = raw.match(/^&#(x[0-9a-f]+|\d+);$/i);
  if (!match) return raw;
  const value = match[1].toLowerCase().startsWith("x") ? Number.parseInt(match[1].slice(1), 16) : Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : raw;
}

import React from "react";
import { EvidenceContext } from "./EvidenceFocus";
import { DescriptionSpanContext } from "./DescriptionEvidencePanel";
import { sameSpan } from "./descriptionEvidence";
import { decodeEntity, codePointSlice, rawRangeFromSelection, tokenizeRawSource, type SourceToken } from "./rawSource";
import type { RawEvidence } from "./types";

export type DescriptionSourceEvidence = RawEvidence & { compositionId: string; label: string; deleted?: boolean; intermediate?: boolean };
type Highlight = RawEvidence & { id: string; tone: "pending" | "focused" | "confirmed" | "deleted" | "intermediate"; editable?: boolean; selected?: boolean; hovered?: boolean };
function highlightClasses(active: Highlight[]) {
  const description = active.some(span => ["confirmed", "deleted", "intermediate"].includes(span.tone));
  if (description) {
    const hovered = active.filter(span => span.hovered);
    const underline = hovered.length ? hovered.some(span => span.selected) ? "selected" : "hovered" : active.some(span => span.selected) ? "selected" : "";
    return `review-highlight-${active.some(span => span.tone === "intermediate") ? "intermediate" : active.some(span => span.tone === "confirmed") ? "confirmed" : "deleted"}${underline ? ` review-span-${underline}` : ""}`;
  }
  return active.map(span => `review-highlight-${span.tone}${span.selected ? " review-highlight-selected" : ""}`).join(" ");
}
function spanAttributes(highlights: Highlight[]) {
  const spans = highlights.filter(h => h.editable).sort((a,b) => (a.end-a.start) - (b.end-b.start));
  const span = spans[0];
  return span ? { "data-evidence-start": span.start, "data-evidence-end": span.end, role: "button", tabIndex: 0, "aria-label": "Find composition for evidence span", title: "Click to find the associated composition" } : {};
}


function ContinuousTextPieces({ value, start, end, highlights }: { value: string; start: number; end: number; highlights: Highlight[] }) {
  const relevant = highlights.filter((span) => span.end > start && span.start < end);
  const boundaries = Array.from(new Set([start, end, ...relevant.flatMap((span) => [Math.max(start, span.start), Math.min(end, span.end)])])).sort((a, b) => a - b);
  return <>{boundaries.slice(0, -1).map((pieceStart, index) => {
    const pieceEnd = boundaries[index + 1];
    const text = codePointSlice(value, pieceStart - start, pieceEnd - start);
    const active = relevant.filter((span) => span.start <= pieceStart && span.end >= pieceEnd);
    const classes = highlightClasses(active);
    return active.length
      ? <mark key={`${pieceStart}:${pieceEnd}`} {...spanAttributes(active)} className={`review-source-highlight ${classes}`} data-raw-start={pieceStart} data-raw-end={pieceEnd}>{text}</mark>
      : <span key={`${pieceStart}:${pieceEnd}`} data-raw-start={pieceStart} data-raw-end={pieceEnd}>{text}</span>;
  })}</>;
}

function TextPieces({ value, start, end, highlights }: { value: string; start: number; end: number; highlights: Highlight[] }) {
  const points = Array.from(value); const parts: React.ReactNode[] = []; let cursor = 0;
  while (cursor < points.length) {
    const rawStart = start + cursor;
    if (points[cursor] === "&") {
      const semi = points.slice(cursor, Math.min(points.length, cursor + 16)).indexOf(";");
      if (semi >= 0) {
        const rawEnd = start + cursor + semi + 1; const rawEntity = points.slice(cursor, cursor + semi + 1).join(""); const decoded = decodeEntity(rawEntity);
        if (decoded !== rawEntity) {
          const active = highlights.filter((span) => span.end > rawStart && span.start < rawEnd);
          const classes = highlightClasses(active);
          parts.push(active.length
            ? <mark key={`entity:${rawStart}`} {...spanAttributes(active)} className={`review-source-highlight ${classes}`} data-raw-start={rawStart} data-raw-end={rawEnd} data-raw-unit="entity">{decoded}</mark>
            : <span key={`entity:${rawStart}`} data-raw-start={rawStart} data-raw-end={rawEnd} data-raw-unit="entity">{decoded}</span>);
          cursor += semi + 1; continue;
        }
      }
    }
    let next = cursor + 1;
    while (next < points.length && points[next] !== "&") next += 1;
    parts.push(<ContinuousTextPieces key={`continuous:${rawStart}`} value={points.slice(cursor, next).join("")} start={rawStart} end={start + next} highlights={highlights}/>);
    cursor = next;
  }
  return <>{parts}</>;
}

const semanticTag: Record<string, keyof React.JSX.IntrinsicElements> = {
  article: "article", section: "section", div: "div", p: "p", span: "span", table: "table", thead: "thead", tbody: "tbody", tr: "tr", td: "td", th: "th", b: "b", strong: "strong", i: "i", em: "em", u: "u", sub: "sub", sup: "sup", ol: "ol", ul: "ul", li: "li", claim: "section", seg: "span", "seg-con": "span", "seg-trans": "span", "seg-refi": "span", "seg-ref": "span", "seg-claim": "section", "seg-comp": "span", "seg-clauses": "section", "seg-main": "section", "seg-enter": "span", h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6"
};

function renderTokenTree(tokens: SourceToken[], raw: string, highlights: Highlight[], index = 0, closeTag?: string): [React.ReactNode[], number] {
  const children: React.ReactNode[] = [];
  let cursor = index;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.kind === "close") {
      if (closeTag === token.tag) return [children, cursor + 1];
      // USPTO table fragments can be structurally misnested. Bubble a close
      // for an ancestor up the recursion stack so nested table/cell elements
      // are closed before the matching ancestor consumes it. At top level we
      // consume an unmatched structural close solely to guarantee progress.
      if (closeTag) return [children, cursor];
      cursor += 1;
      continue;
    }
    if (token.kind === "text") {
      children.push(<TextPieces key={`text:${token.rawStart}`} value={token.value} start={token.rawStart} end={token.rawEnd} highlights={highlights}/>);
      cursor += 1;
      continue;
    }
    if (token.kind === "break") {
      children.push(<br key={`break:${token.rawStart}`} data-raw-start={token.rawStart} data-raw-end={token.rawEnd}/>);
      cursor += 1;
      continue;
    }
    if (token.kind === "image") {
      const active = highlights.filter(span => span.start < token.rawEnd && span.end > token.rawStart);
      children.push(<span key={`image:${token.rawStart}`} {...spanAttributes(active)} className={`review-image-marker ${token.missing ? "missing" : ""} ${active.length ? `review-source-highlight ${highlightClasses(active)}` : ""}`} data-raw-start={token.rawStart} data-raw-end={token.rawEnd}>{token.raw}</span>);
      cursor += 1;
      continue;
    }
    const [nested, next] = renderTokenTree(tokens, raw, highlights, cursor + 1, token.tag);
    const Tag = semanticTag[token.tag] || "span";
    children.push(<Tag key={`open:${token.rawStart}`} className={`review-source-${token.tag}${token.className ? ` ${token.className}` : ""}`} data-claim-num={token.num}>{nested}</Tag>);
    cursor = next;
  }
  return [children, cursor];
}

export function RawSourceViewer({ sourceLabel = "Patent source", content, pendingEvidence, onSelectEvidence, explicitEvidence = false, captureEnabled = true, selectionKey = "", descriptionEvidence = [], onEvidenceNavigate }: {
  sourceLabel?: string;
  content: string;
  pendingEvidence: RawEvidence[];
  onSelectEvidence: (evidence: RawEvidence) => void;
  explicitEvidence?: boolean;
  captureEnabled?: boolean;
  selectionKey?: string;
  descriptionEvidence?: DescriptionSourceEvidence[];
  onEvidenceNavigate?: (compositionId: string, span: RawEvidence) => boolean | void;
}) {
  const tokens = React.useMemo(() => tokenizeRawSource(content), [content]);
  const { focus } = React.useContext(EvidenceContext);
  const root = React.useRef<HTMLElement>(null);
  const bridge = React.useContext(DescriptionSpanContext);
  const setCandidate = bridge?.setCandidate;
  const mode = bridge?.mode;
  const captureActive = explicitEvidence && Boolean(bridge?.editing) && mode !== "idle";
  const selecting = React.useRef(false);
  const captureSelection = React.useCallback(() => {
    if (!captureActive || !setCandidate) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    if (!root.current?.contains(range.startContainer) || !root.current.contains(range.endContainer)) return;
    const mapped = rawRangeFromSelection(range);
    if (mapped && mapped.end > mapped.start) setCandidate({...mapped,evidence_text:codePointSlice(content,mapped.start,mapped.end)});
  }, [captureActive, content, setCandidate]);
  const [owners, setOwners] = React.useState<DescriptionSourceEvidence[]>([]);
  React.useEffect(() => {
    if(!owners.length) return;
    const escape=(event:KeyboardEvent)=>{if(event.key === "Escape" && !event.defaultPrevented){event.preventDefault();setOwners([]);}};
    document.addEventListener("keydown",escape);return()=>document.removeEventListener("keydown",escape);
  },[owners.length]);
  const [hoveredSpan, setHoveredSpan] = React.useState<RawEvidence | null>(null);
  React.useEffect(() => {setOwners([]);setHoveredSpan(null);}, [selectionKey]);
  React.useEffect(() => {if(captureActive) {setOwners([]);setHoveredSpan(null);}}, [captureActive]);
  React.useEffect(() => {
    if (explicitEvidence) { setCandidate?.(null); window.getSelection()?.removeAllRanges(); }
  }, [selectionKey, content, explicitEvidence, setCandidate]);
  React.useEffect(() => {
    if (!captureActive) return;
    // Do not rebuild highlighted text nodes while a drag selection is in progress.
    const finish = () => {if(!selecting.current) return;selecting.current=false;requestAnimationFrame(captureSelection);};
    window.addEventListener("pointerup",finish);
    return () => {selecting.current=false;window.removeEventListener("pointerup",finish);};
  }, [captureActive,captureSelection]);
  const highlights = React.useMemo<Highlight[]>(() => {
    if (explicitEvidence && bridge) {
      return [
        ...descriptionEvidence.map((span, i) => ({ ...span, id: `attached:${i}`, tone: span.intermediate ? "intermediate" as const : span.deleted ? "deleted" as const : "confirmed" as const, editable: !captureActive && Boolean(span.compositionId), selected: !captureActive && (focus?.spans || []).some(focused => sameSpan(span,focused)), hovered: !captureActive && sameSpan(span,hoveredSpan) })),
        ...(bridge.candidate ? [{...bridge.candidate,id:"candidate",tone:"intermediate" as const}] : []),
        ...(bridge.mode === "replace" && bridge.selected ? [{...bridge.selected,id:"redrawing",tone:"intermediate" as const}] : [])
      ];
    }
    return [...pendingEvidence.map((span, index) => ({ ...span, id: `pending:${index}`, tone: "pending" as const })), ...(focus?.spans || []).map((span, index) => ({ ...span, id: `focused:${index}`, tone: "focused" as const }))];
  }, [explicitEvidence, descriptionEvidence, bridge?.candidate, bridge?.mode, bridge?.selected, focus, pendingEvidence, hoveredSpan,captureActive]);
  React.useEffect(() => {
    if (explicitEvidence) {
      const first = focus?.spans[0];
      if (first && root.current) {
        const pieces = Array.from(root.current.querySelectorAll<HTMLElement>(".review-source-highlight[data-raw-start]"));
        const target = pieces.find(mark => Number(mark.dataset.rawStart) <= first.start && Number(mark.dataset.rawEnd) > first.start) || pieces.find(mark => Number(mark.dataset.rawStart) >= first.start && Number(mark.dataset.rawStart) < first.end);
        if (target) { const pane = root.current; const bounds = pane.getBoundingClientRect(); const rect = target.getBoundingClientRect(); pane.scrollTo({top:pane.scrollTop + rect.top - bounds.top - Math.max(0,(pane.clientHeight - rect.height)/2),behavior:"smooth"}); }
      }
    } else root.current?.querySelector<HTMLElement>(".review-highlight-focused")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus]);
  const [tree] = React.useMemo(() => renderTokenTree(tokens, content, highlights), [content, highlights, tokens]);
  const pickSpan = (target: EventTarget) => {
    const mark = target instanceof Element ? target.closest<HTMLElement>("[data-evidence-start]") : null;
    if (!mark || !bridge) return;
    const start = Number(mark.dataset.evidenceStart), end = Number(mark.dataset.evidenceEnd);
    const matches = [...new Map(descriptionEvidence.filter(span => span.compositionId && span.start === start && span.end === end).map(span => [span.compositionId,span])).values()];
    if (matches.length === 1) { setOwners([]); onEvidenceNavigate?.(matches[0].compositionId,matches[0]); }
    else setOwners(matches);
  };
  const hoverSpan = (target: EventTarget) => {
    const mark = target instanceof Element ? target.closest<HTMLElement>("[data-evidence-start]") : null;
    const span = mark ? descriptionEvidence.find(span => span.start === Number(mark.dataset.evidenceStart) && span.end === Number(mark.dataset.evidenceEnd)) || null : null;
    setHoveredSpan(current => sameSpan(current,span) || (!current && !span) ? current : span);
  };
  const select = React.useCallback(() => {
    if (explicitEvidence || !captureEnabled) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const mapped = rawRangeFromSelection(selection.getRangeAt(0));
    if (!mapped || mapped.start === mapped.end) return;
    onSelectEvidence({ ...mapped, evidence_text: codePointSlice(content, mapped.start, mapped.end) });
    selection.removeAllRanges();
  }, [content, onSelectEvidence, explicitEvidence, captureEnabled]);

  return <article ref={root} className={`review-source-view${captureActive ? " review-evidence-capture" : ""}`} onMouseUp={select} aria-label={sourceLabel}
    onPointerDown={() => {if(captureActive) selecting.current=true;}} onKeyUp={() => {if(captureActive) captureSelection();}}
    onPointerMove={event => {if(explicitEvidence && !captureActive) hoverSpan(event.target);}} onPointerLeave={() => setHoveredSpan(null)}
    onFocus={event => {if(explicitEvidence && !captureActive) hoverSpan(event.target);}} onBlur={() => setHoveredSpan(null)}
    onClick={event => { if (explicitEvidence && !captureActive && (window.getSelection()?.isCollapsed ?? true)) pickSpan(event.target); }}
    onKeyDown={event => { if (explicitEvidence && !captureActive && ["Enter"," "].includes(event.key) && (event.target as Element).closest("[data-evidence-start]")) { event.preventDefault(); pickSpan(event.target); } }}>
    {owners.length > 1 && <div className="review-span-owners" role="group" aria-label="Compositions sharing this evidence"><span>Shared evidence</span>{owners.map(owner => <button key={owner.compositionId} type="button" onClick={() => {setOwners([]);onEvidenceNavigate?.(owner.compositionId,owner);}}>{owner.label}{owner.deleted ? " · Deleted" : ""}</button>)}<button type="button" onClick={() => setOwners([])}>Close</button></div>}
    {tree.length ? tree : <pre>{content}</pre>}
  </article>;
}

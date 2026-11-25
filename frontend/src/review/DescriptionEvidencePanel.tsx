import React from "react";
import { Plus, Trash2, Undo2 } from "lucide-react";
import type { RawEvidence, ReviewCompositionData } from "./types";
import { changeInstanceSpan, instanceSpans, sameSpan } from "./descriptionEvidence";
import { readableFragment } from "./descriptionNavigation";
import { EvidenceContext } from "./EvidenceFocus";
import { ReviewContextMenu } from "./ReviewContextMenu";

export type DescriptionSpanBridge = {
  content: string; data: ReviewCompositionData | null; editable: boolean; editing: boolean; requireEvidence: boolean;
  candidate: RawEvidence | null; setCandidate: (span: RawEvidence | null) => void;
  selected: RawEvidence | null; setSelected: (span: RawEvidence | null) => void;
  mode: "idle" | "add" | "replace"; setMode: (mode: "idle" | "add" | "replace") => void;
  setDraft: (data: ReviewCompositionData | null) => void;
  editRequest: { id: string | null; sequence: number };
  requestEdit: (span?: RawEvidence) => void;
  deleteSpan: (span: RawEvidence) => void;
};
export const DescriptionSpanContext = React.createContext<DescriptionSpanBridge | null>(null);

export function DescriptionEvidenceSection({ data, editing, change, onlySpan, simpleCapture = false }: { data: ReviewCompositionData; editing: boolean; change?: (data: ReviewCompositionData) => void; onlySpan?: RawEvidence; simpleCapture?: boolean }) {
  const bridge = React.useContext(DescriptionSpanContext)!;
  const { show } = React.useContext(EvidenceContext);
  const [error, setError] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const section = React.useRef<HTMLElement>(null);
  const spans = instanceSpans(data).filter(span => !onlySpan || sameSpan(span, onlySpan) || sameSpan(span, bridge.selected));
  const selected = spans.find(s => sameSpan(s, bridge.selected)) || null;
  const [originalSpan] = React.useState<RawEvidence | null>(() => simpleCapture && selected ? {...selected} : null);
  const candidateHistory = React.useRef<Array<RawEvidence | null>>([]);
  const previousCandidate = React.useRef<RawEvidence | null>(null);
  React.useEffect(() => {
    if (!simpleCapture || sameSpan(bridge.candidate,previousCandidate.current) || (!bridge.candidate && !previousCandidate.current)) return;
    if (bridge.candidate) candidateHistory.current.push(previousCandidate.current);
    else candidateHistory.current=[];
    previousCandidate.current=bridge.candidate ? {...bridge.candidate} : null;
  },[simpleCapture,bridge.candidate]);
  const undoCandidate = () => {
    if (!bridge.candidate) return;
    const previous=candidateHistory.current.pop() || null;
    previousCandidate.current=previous;
    bridge.setCandidate(previous);
    window.getSelection()?.removeAllRanges();
  };
  React.useEffect(() => { setError(""); }, [bridge.selected?.start, bridge.selected?.end]);
  React.useEffect(() => {
    if (editing && bridge.editRequest.sequence && selected) section.current?.scrollIntoView({block:"nearest"});
  }, [bridge.editRequest.sequence, editing]);
  const begin = (mode: "add" | "replace") => { setError(""); bridge.setCandidate(null); bridge.setMode(mode); window.getSelection()?.removeAllRanges(); };
  const modify = (replacement: RawEvidence | null, target = selected) => {
    if (!change || !target) return;
    try {
      const next = changeInstanceSpan(data, target, replacement, bridge.content, bridge.requireEvidence);
      change(next); bridge.setSelected(replacement); bridge.setCandidate(null); bridge.setMode("idle"); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change this span."); }
  };
  const attach = () => {
    if (!bridge.candidate || !change) return;
    if (bridge.mode === "replace") { modify(bridge.candidate); return; }
    const current = data.evidence_spans || [];
    const next = current.some(s => sameSpan(s, bridge.candidate)) ? current : [...current, bridge.candidate];
    change({...data, evidence_spans: next}); bridge.setSelected(bridge.candidate); bridge.setCandidate(null); bridge.setMode("idle"); window.getSelection()?.removeAllRanges();
  };
  if (simpleCapture) return <section ref={section} className="review-instance-section review-instance-evidence" aria-label="Evidence span editor">
    <header><h3>Evidence</h3></header>
    <section className="review-evidence-preview-section review-evidence-original" aria-label="Original evidence"><h4>Original evidence</h4><p className="review-evidence-edit-preview">{originalSpan ? readableFragment(originalSpan.evidence_text) : "No original evidence."}</p></section>
    <section className="review-evidence-preview-section review-evidence-new" aria-label="New evidence" aria-live="polite" aria-atomic="true"><div className="review-evidence-preview-heading"><h4>New evidence</h4><button type="button" className="review-evidence-undo" title="Undo new evidence selection" aria-label="Undo new evidence selection" disabled={!bridge.candidate} onClick={undoCandidate}><Undo2 size={14}/></button></div><p className={`review-evidence-edit-preview${bridge.candidate ? "" : " review-evidence-placeholder"}`}>{bridge.candidate ? readableFragment(bridge.candidate.evidence_text) : originalSpan ? "Select replacement text in Source." : "Select supporting text in Source."}</p></section>
  </section>;
  return <section ref={section} className="review-instance-section review-instance-evidence" aria-label="Evidence spans">
    <header><h3>Evidence</h3>{bridge.editable && !onlySpan && <button type="button" onClick={() => editing ? begin("add") : bridge.requestEdit()}><Plus size={14}/> Add span</button>}</header>
    {!spans.length && <p className="review-section-empty">No evidence spans attached.</p>}
    <div className="review-instance-spans">{spans.map((span, i) => { const key = `${span.start}:${span.end}`; return <ReviewContextMenu key={key} className="review-instance-span" label={`Actions for evidence span ${i + 1}`} actions={bridge.editable ? [{id:"edit",label:"Edit"},{id:"delete",label:"Delete",danger:true}] : []} onAction={action => { if (action === "edit") { bridge.setSelected(span); if (editing) begin("replace"); else bridge.requestEdit(span); } else if (editing) modify(null, span); else bridge.deleteSpan(span); }}>
      <button type="button" className={sameSpan(span, selected) ? "selected" : ""} aria-pressed={sameSpan(span, selected)} aria-expanded={expanded === key} onClick={() => { setExpanded(value => value === key ? null : key); bridge.setSelected(span); bridge.setMode("idle"); bridge.setCandidate(null); show(span, `Span ${i + 1}`); }}><strong>Span {i + 1}</strong><span>{readableFragment(span.evidence_text)}</span>{expanded === key && <small>Source characters {span.start}–{span.end}</small>}</button>
    </ReviewContextMenu>; })}</div>
    {editing && selected && <div className="review-section-actions"><button type="button" onClick={() => begin("replace")}>Redraw span</button><button type="button" className="review-danger" onClick={() => modify(null)}><Trash2 size={13}/> Delete span</button></div>}
    {editing && bridge.mode !== "idle" && <div className="review-span-capture"><p>{bridge.candidate ? readableFragment(bridge.candidate.evidence_text) : `Highlight ${bridge.mode === "replace" ? "replacement" : "supporting"} text in Source.`}</p><div className="review-section-actions"><button type="button" className="review-primary" disabled={!bridge.candidate} onMouseDown={event => event.preventDefault()} onClick={attach}>{bridge.mode === "replace" ? "Apply new bounds" : "Attach selected span"}</button><button type="button" onClick={() => { bridge.setMode("idle"); bridge.setCandidate(null); window.getSelection()?.removeAllRanges(); }}>Cancel selection</button></div></div>}
    {error && <p className="review-inline-error" role="alert">{error}</p>}
  </section>;
}

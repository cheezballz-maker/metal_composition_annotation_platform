import React from "react";
import { alphabeticalConstituents } from "./descriptionNavigation";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { EditableAmount } from "./amountDraft";
import type { RawEvidence, ReviewAmount, ReviewConstituent } from "./types";
import { constituentWithAmounts, descriptionAmounts, movePreferredRange, preferredRangeLabel } from "./descriptionDraft";

type AmountRenderer = (row: EditableAmount, label: string, change: (patch: Partial<EditableAmount>) => void) => React.ReactNode;
export function DescriptionConstituents({ rows, evidence, errors = {}, protectedNames = [], change, renderAmount, onlyIndex, inline = false }: { rows: ReviewConstituent[]; evidence: RawEvidence[]; errors?: Record<number, string>; protectedNames?: string[]; change: (rows: ReviewConstituent[]) => void; renderAmount: AmountRenderer; onlyIndex?: number; inline?: boolean }) {
  const sortNames = React.useRef(rows.map(row => row.constituent_name));
  const container = React.useRef<HTMLElement>(null);
  const pendingMove = React.useRef<{ constituent: number; from: number; to: number; fromTop: number; toTop: number } | null>(null);
  const animations = React.useRef<Animation[]>([]);
  const [movedRange, setMovedRange] = React.useState<{ constituent: number; index: number; message: string } | null>(null);
  React.useLayoutEffect(() => {
    const move = pendingMove.current;
    if (!move) return;
    pendingMove.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animations.current = [[move.to, move.fromTop], [move.from, move.toTop]].flatMap(([index, beforeTop]) => {
      const node = container.current?.querySelector<HTMLElement>(`[data-range-card="${move.constituent}:${index}"]`);
      if (!node) return [];
      return [node.animate([{ transform: `translateY(${beforeTop - node.getBoundingClientRect().top}px)`, zIndex: index === move.to ? 2 : 1 }, { transform: "translateY(0)", zIndex: index === move.to ? 2 : 1 }], { duration: 320, easing: "cubic-bezier(.2,0,0,1)" })];
    });
  }, [rows]);
  React.useEffect(() => {
    if (!movedRange) return;
    const timeout = window.setTimeout(() => setMovedRange(null), 1100);
    return () => window.clearTimeout(timeout);
  }, [movedRange]);
  React.useEffect(() => () => animations.current.forEach(animation => animation.cancel()), []);
  const update = (i: number, patch: Partial<ReviewConstituent>) => change(rows.map((row, j) => i === j ? { ...row, ...patch } : row));
  const saveAmounts = (i: number, amounts: ReviewAmount[]) => change(rows.map((row, j) => i === j ? constituentWithAmounts(row, amounts) : row));
  return <section ref={container} className="review-structured-section review-section-constituent">{!inline && <header><strong>Constituents</strong>{onlyIndex == null && <button type="button" onClick={() => {sortNames.current.push("");change([...rows, { constituent_name: "", constituent_status: "included" }]);}}>Add constituent</button>}</header>}<span className="review-visually-hidden" role="status">{movedRange?.message || ""}</span>{alphabeticalConstituents(rows,sortNames.current).map(({row,index:i}) => {
    if (onlyIndex != null && onlyIndex !== i) return null;
    const amounts = descriptionAmounts(row, evidence);
    const preferredCount = amounts.filter(a => (a.preferred_order ?? 0) > 0).length;
    const updateAmount = (j: number, patch: Record<string, unknown>) => row.amounts ? saveAmounts(i, amounts.map((a, k) => k === j ? { ...a, ...patch } : a)) : update(i, patch);
    const addRange = () => {
      const preferred: ReviewAmount = { preferred_order: preferredCount + 1, amount_comparator: "range", amount_unit: amounts.find(a => a.amount_unit)?.amount_unit || null, evidence_spans: evidence.map(span => ({ ...span })) };
      saveAmounts(i, [...amounts.filter(a => a.preferred_order != null), preferred, ...amounts.filter(a => a.preferred_order == null)]);
    };
    const move = (from: number, to: number, direction: string) => {
      const next = movePreferredRange(amounts, from, to);
      if (next === amounts) return;
      const before = (index: number) => container.current?.querySelector<HTMLElement>(`[data-range-card="${i}:${index}"]`)?.getBoundingClientRect().top;
      const fromTop = before(from), toTop = before(to);
      animations.current.forEach(animation => animation.cancel());
      if (fromTop != null && toTop != null) pendingMove.current = { constituent: i, from, to, fromTop, toTop };
      setMovedRange({ constituent: i, index: to, message: `${row.constituent_name}: preferred range ${amounts[from].preferred_order} moved ${direction} to preferred range ${next[to].preferred_order}.` });
      saveAmounts(i, next);
      requestAnimationFrame(() => {
        const card = container.current?.querySelector<HTMLElement>(`[data-range-card="${i}:${to}"]`);
        const button = card?.querySelector<HTMLButtonElement>(`[data-range-move="${i}:${to}:${direction}"]:not(:disabled)`) || card?.querySelector<HTMLButtonElement>(".review-range-moves button:not(:disabled)");
        button?.focus({ preventScroll: true });
      });
    };
    const protectedConstituent = Boolean(row.constituent_name && protectedNames.includes(row.constituent_name));
    return <section className={`review-description-constituent${onlyIndex == null ? " review-constituent-removable" : ""}`} key={i}>
      {onlyIndex == null && <button type="button" className="review-constituent-delete" aria-label={`Delete constituent ${row.constituent_name || i + 1}`} title={protectedConstituent ? "Remove restriction memberships first" : "Delete constituent"} disabled={protectedConstituent} onClick={() => {animations.current.forEach(animation => animation.cancel());pendingMove.current=null;setMovedRange(null);sortNames.current.splice(i,1);change(rows.filter((_,j) => j !== i));}}><X size={14}/></button>}
      <div className="review-fields"><label>Constituent<input aria-label={`Constituent ${i + 1} name`} value={row.constituent_name} onChange={event => update(i, { constituent_name: event.target.value })}/></label><label>Inclusion<select value={row.constituent_status || "included"} onChange={event => update(i, { constituent_status: event.target.value })}>{["included", "optional", "excluded"].map(status => <option key={status}>{status}</option>)}</select></label></div>
      {errors[i] && <span className="review-inline-error" role="alert">{errors[i]}</span>}
      {amounts.map((a, j) => <div className={`review-description-amount review-preferred-range${movedRange?.constituent === i && movedRange.index === j ? " review-range-just-moved" : ""}`} data-range-card={`${i}:${j}`} key={j}>
        <header className="review-range-heading">
          <strong className="review-recorded-range-label">{preferredRangeLabel(a)}</strong>
          {(a.preferred_order ?? 0) > 0 && <span className="review-range-moves">{([[-1, "up"], [1, "down"]] as const).map(([offset, direction]) => <button key={direction} type="button" data-range-move={`${i}:${j}:${direction}`} aria-label={`Move preferred range ${a.preferred_order} ${direction} for ${row.constituent_name || i + 1}`} disabled={(amounts[j + offset]?.preferred_order ?? 0) <= 0} onClick={() => move(j, j + offset, direction)}>{direction === "up" ? <ArrowUp size={13}/> : <ArrowDown size={13}/>}Move {direction}</button>)}</span>}
          {a.preferred_order !== 0 && <button type="button" className="review-range-remove" aria-label={`Delete ${preferredRangeLabel(a).toLowerCase()} for ${row.constituent_name || i + 1}`} title={`Delete ${preferredRangeLabel(a).toLowerCase()}`} onClick={() => saveAmounts(i, amounts.filter((_, k) => k !== j))}><X size={14}/></button>}
        </header>
        <div className="review-description-amount-fields">{renderAmount(a, `${row.constituent_name || i + 1} amount ${j + 1}`, patch => updateAmount(j, patch))}<label>Unit<input value={String(a.amount_unit || "")} onChange={event => updateAmount(j, { amount_unit: event.target.value || null })}/></label></div>
      </div>)}
      <div className="review-range-actions"><button type="button" className="review-add-preferred" onClick={addRange}><Plus size={14}/>Add preferred range {preferredCount + 1}</button></div>
    </section>;
  })}</section>;
}

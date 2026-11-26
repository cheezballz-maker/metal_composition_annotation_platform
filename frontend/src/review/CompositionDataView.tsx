import { useReviewTranslation } from "./locale";
import React from "react";
import { AddRestrictionButtons, RatioSummary } from "./DescriptionRatio";
import { inheritedInformation } from "./descriptionInheritance";
import { restrictionSelectionLabel } from "./constraintDraft";
import { alphabeticalConstituents } from "./descriptionNavigation";
import { ChevronRight, Plus } from "lucide-react";
import type { RawEvidence, ReviewComposition, ReviewCompositionData, ReviewConstituent } from "./types";
import { EvidenceContext, SourceLink } from "./EvidenceFocus";
import { resolveEvidence } from "./evidence";
import { JsonNode } from "./JsonNode";
import { decodeEntity, tokenizeRawSource } from "./rawSource";
import type { EditableAmount } from "./amountDraft";
import { DescriptionEditableItem } from "./DescriptionEditableItem";
import { descriptionAmounts, preferredRangeLabel } from "./descriptionDraft";

function bound(row: EditableAmount, side: "lower" | "upper") {
  const value = row[`amount_${side}_value`];
  if (value == null) return "";
  const endpoint = row[`amount_${side}_endpoint_type`];
  const symbol = endpoint === "approx" ? "≈" : endpoint === "open" ? (side === "lower" ? ">" : "<") : endpoint === "closed" ? (side === "lower" ? "≥" : "≤") : "";
  return `${symbol}${value}`;
}

function amount(row: EditableAmount & { amount_unit?: string | null }) {
  const comparator = row.amount_comparator;
  const sameValue = row.amount_lower_value != null && row.amount_lower_value === row.amount_upper_value;
  const exactSingle = sameValue && row.amount_lower_endpoint_type === "closed" && row.amount_upper_endpoint_type === "closed";
  const approximateSingle = sameValue && row.amount_lower_endpoint_type === "approx" && row.amount_upper_endpoint_type === "approx";
  const range = exactSingle ? `=${row.amount_lower_value}` : approximateSingle ? `≈${row.amount_lower_value}` : [bound(row, "lower"), bound(row, "upper")].filter(Boolean).join(" · ");
  const symbols: Record<string, string> = { equal: "=", greater_than: ">", greater_than_or_equal: "≥", less_than: "<", less_than_or_equal: "≤", approximate: "≈", approx: "≈" };
  const rule = comparator === "balance" ? "Balance" : comparator && comparator !== "range" ? (symbols[comparator] || comparator) : "";
  const value = row.amount_value != null ? String(row.amount_value) : range;
  return [rule, value, row.amount_unit].filter(Boolean).join(" ") || "—";
}
export { amount as formatCompositionAmount };

/** Render evidence as text, retaining comparison symbols that are not markup. */
export function evidencePreview(text: string = "") {
  return tokenizeRawSource(text).map((token) => token.kind === "text" ? token.value.replace(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity) : token.kind === "break" || (token.kind === "close" && ["p", "div", "section", "claim", "tr", "td", "li"].includes(token.tag)) ? " " : "").join("").replace(/\s+/g, " ").trim();
}

export function UnrepresentedRestrictions({values,inherited=false}:{values:unknown[];inherited?:boolean}) {
  if (!values.length) return null;
  return <section className="review-unrepresented-restrictions" aria-label={inherited ? "Inherited unrepresented restrictions" : "Unrepresented restrictions"}>
    <header><strong>Unrepresented restrictions</strong></header>
    {values.map((value,index)=>{
      const row=value && typeof value==="object" ? value as Record<string,unknown> : {};
      const span=(row.evidence_span || row) as {evidence_text?:string};
      const description=row.description ?? row.relation ?? row.reason;
      const text=typeof description==="string" ? description : evidencePreview(span.evidence_text || "");
      return <p className="review-unrepresented-restriction" key={index}><strong>{typeof row.kind==="string" ? row.kind : "unspecified"}:</strong> {text || "—"}</p>;
    })}
  </section>;
}

export function CompositionDataView({ data, description = false, bases = [], onSelectBase, onEditConstituent, onDeleteConstituent, onSectionAction, constituentEditor, restrictionEditor, editable = true }: { data: ReviewCompositionData; description?: boolean; bases?: ReviewComposition[]; onSelectBase?: (id: string) => void; onEditConstituent?: (index: number) => void; onDeleteConstituent?: (index: number) => void; onSectionAction?: (kind: "restriction", index: number | undefined, action: "edit" | "delete", ratio?:boolean) => void; restrictionEditor?: {index:number; content:React.ReactNode}; editable?: boolean; constituentEditor?: {index:number; row?:ReviewConstituent; content:React.ReactNode} }) {
  const t = useReviewTranslation();
  const { content } = React.useContext(EvidenceContext);
  const scope = React.useMemo(() => resolveEvidence({ evidence: data.evidence, evidence_spans: data.evidence_spans }, content), [data, content]);
  const rows = data.constituents || [];
  const displayRows = constituentEditor?.index === rows.length && constituentEditor.row ? [...rows,constituentEditor.row] : rows;
  const relations = data.unrepresented_relations || [];
  const restrictions = data.constraints || [];
  const ratioConstituents = [...inheritedInformation(data,bases).constituents,...rows];
  const showStatus = rows.some((row) => row.constituent_status !== "included");
  const relationshipSection = (relations.length > 0 && <section className="review-relations" aria-label={t("Unrepresented relations")}>
    <header><strong>{t("Unrepresented relations")}</strong><small>{relations.length}</small></header>
    <p>{t("Click a relation to verify it in the source.")}</p>
    <ol>{relations.map((relation,index)=>{
      const spans=resolveEvidence(relation,content,scope.length ? scope : undefined);
      const row=relation && typeof relation==="object" ? relation as Record<string,unknown> : {};
      const wording=row.description ?? row.relation ?? row.reason ?? row.evidence_text ?? row.evidence;
      const text=typeof wording==="string" ? wording : spans.map(span=>span.evidence_text).join(" … ");
      return <li key={index}><SourceLink value={relation} label={`relation ${index+1}`} scope={scope.length ? scope : undefined}><span className="review-relation-number">{index+1}</span><span>{evidencePreview(text) || `Relation ${index+1}`}</span></SourceLink>
        {!spans.length && <small>{t("No matching source range")}</small>}
        {Object.keys(row).some(key=>!["start","end","evidence_text"].includes(key)) && <JsonNode label={t("Details")} value={relation} scope={scope.length ? scope : undefined}/>}
      </li>;
    })}</ol>
  </section>);
  return <div className="review-composition-data">
    {!description && relationshipSection}
    {description ? <section className="review-data-section review-description-constituents" aria-label="Constituents"><header><strong>{t("Constituents")}</strong>{editable && <button type="button" onClick={() => onEditConstituent?.(rows.length)}>Add</button>}</header>{displayRows.length ? <div className="review-description-constituent-list">{alphabeticalConstituents(displayRows).map(({row,index}) => constituentEditor?.index === index ? <div className="review-inline-constituent-slot" key={index}>{constituentEditor.content}</div> : <DescriptionConstituentCard key={index} row={row} index={index} scope={scope} onEdit={() => onEditConstituent?.(index)} onDelete={() => onDeleteConstituent?.(index)} editable={editable}/>)}</div> : <p className="review-data-empty">{t("No constituents recorded.")}</p>}</section> : <details className="review-data-section" open>
      <summary><ChevronRight size={14}/><strong>{t("Constituents")}</strong><small>{rows.length}</small></summary>
      {rows.length ? <div className="review-constituent-table-scroll"><table className="review-constituent-table">
        <caption className="review-visually-hidden">{t("Constituents of")}{data.composition_name || "this composition"}</caption>
        <thead><tr><th scope="col">{t("Constituent")}</th><th scope="col">{t("Amount")}</th>{showStatus && <th scope="col">{t("Status")}</th>}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <th scope="row"><SourceLink value={row} label={row.constituent_name || `constituent ${index + 1}`} scope={scope.length ? scope : undefined}>{row.constituent_name || "Unnamed"}</SourceLink></th>
          <td className="review-bound">{description && row.amounts ? row.amounts.map((a, j) => <div className="review-amount-summary" key={j}><strong>{preferredRangeLabel(a)}</strong><SourceLink value={a} label={`${row.constituent_name}: ${preferredRangeLabel(a)}`}>{amount(a)}</SourceLink></div>) : row.amount_comparator === "balance" ? amount(row).replace("Balance", t("Balance")) : amount(row)}</td>
          {showStatus && <td>{t(row.constituent_status || "—")}</td>}
        </tr>)}</tbody>
      </table></div> : <p className="review-data-empty">{t("No constituents recorded.")}</p>}
    </details>}
    {description ? <section className="review-structured-section review-restrictions" aria-label="Constituent restrictions">
      <header><strong>Constituent restrictions</strong>{editable && <AddRestrictionButtons onAdd={ratio=>onSectionAction?.("restriction",undefined,"edit",ratio)}/>} </header>
      {!data.constraints?.length && !restrictionEditor && <p className="review-section-empty">No constituent restrictions.</p>}
      {restrictions.map((c, i) => restrictionEditor?.index === i ? <div className="review-inline-slot" key={i}>{restrictionEditor.content}</div> : <DescriptionEditableItem key={i} className="review-description-restriction" label={`Edit constituent restriction ${i + 1}`} onEdit={editable ? () => onSectionAction?.("restriction",i,"edit") : undefined} onDelete={editable ? () => onSectionAction?.("restriction",i,"delete") : undefined} deleteLabel={`Delete constituent restriction ${i + 1}`}>
        {c.mode === "ratio" ? <RatioSummary row={c} constituents={ratioConstituents}/> : <><strong>Constituents: {(c.member_refs || []).join(", ")}</strong>
        {amount(c) !== "—" && <span>Combined constituent concentration: {amount(c)}</span>}
        {restrictionSelectionLabel(c) && <span>Number included: {restrictionSelectionLabel(c)}</span>}</>}
      </DescriptionEditableItem>)}
      {restrictionEditor && restrictionEditor.index === restrictions.length && <div className="review-inline-slot">{restrictionEditor.content}</div>}
      <UnrepresentedRestrictions values={relations}/>
    </section> : !!data.constraints?.length && <JsonNode label={t("Constraints")} value={data.constraints} scope={scope.length ? scope : undefined}/>}
    {!description && <JsonNode label={t("Full composition JSON")} value={data} scope={scope.length ? scope : undefined}/>}
  </div>;
}

function DescriptionConstituentCard({ row, index, scope, onEdit, onDelete, editable }: { row: ReviewConstituent; index: number; scope: RawEvidence[]; onEdit: () => void; onDelete: () => void; editable: boolean }) {
  const amounts = descriptionAmounts(row, scope);
  return <DescriptionEditableItem className="review-description-constituent" label={`Edit constituent ${row.constituent_name || index + 1}`} onEdit={editable ? onEdit : undefined} onDelete={editable ? onDelete : undefined} deleteLabel={`Delete constituent ${row.constituent_name || index + 1}`}>
    <span className="review-constituent-identity"><strong>{row.constituent_name || `Constituent ${index + 1}`}</strong><small>{row.constituent_status || "included"}</small></span><span className="review-description-constituent-values">{row.amounts ? amounts.map((amountRow, j) => <span className="review-range-summary" key={j}><small>{preferredRangeLabel(amountRow)}</small><span>{amount(amountRow)}</span></span>) : amount(row)}</span>
  </DescriptionEditableItem>;
}

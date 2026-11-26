import React from "react";
import { Plus } from "lucide-react";
import type { ReviewConstraint, ReviewConstituent } from "./types";
import { isLegacyRatio, ratioIntervals, ratioIntervalText, simpleRatioFromValues } from "./ratios";

export function AddRestrictionButtons({onAdd}:{onAdd:(ratio?:boolean)=>void}) {
  return <span className="review-add-restrictions"><button type="button" onClick={()=>onAdd()}><Plus size={13}/>Concentration restriction</button><button type="button" onClick={()=>onAdd(true)}><Plus size={13}/>Ratio restriction</button></span>;
}
export function RatioSummary({row,constituents}:{row:ReviewConstraint;constituents:ReviewConstituent[]}) {
  try {const values=ratioIntervals(row,constituents);return <><strong>Constituent ratio</strong><span className="review-ratio-equation">{row.member_refs?.join(" : ")} = {values.map(ratioIntervalText).join(" : ")}</span></>;}catch(error){return <><strong>Constituent ratio</strong><span>{row.member_refs?.join(" : ")}</span><small className="review-inline-error">{error instanceof Error?error.message:"Unavailable ratio"}</small></>;}
}
export function DescriptionRatioEditor({row,constituents,onChange}:{row:ReviewConstraint;constituents:ReviewConstituent[];onChange:(next:ReviewConstraint)=>void}) {
  const names=[...new Set(constituents.map(c=>c.constituent_name))].sort((a,b)=>a.localeCompare(b,"en",{sensitivity:"base"}));
  const [inputs,setInputs]=React.useState<Record<string,number|string>>(()=>Object.fromEntries(names.map(name=>{
    const index=row.member_refs?.indexOf(name)??-1,value=index>=0?row.ratio_values?.[index]:0;
    return [name,typeof value==="number" || typeof value==="string" ? value : 0];
  })));
  if(isLegacyRatio(row))return <div className="review-ratio-editor"><RatioSummary row={row} constituents={constituents}/><small className="review-ratio-guidance">This previously saved ratio is retained unchanged. To replace it, delete this restriction and add a new ratio restriction.</small></div>;
  let message="",preview="";
  try {const values=ratioIntervals(row,constituents);preview=`${row.member_refs?.join(" : ")} = ${values.map(ratioIntervalText).join(" : ")}`;}
  catch(error){message=(row.member_refs?.length || 0)<2?"Enter a positive value for at least two constituents. Zero leaves a constituent out.":error instanceof Error?error.message:"Invalid ratio.";}
  return <div className="review-ratio-editor"><strong>Constituent ratio</strong>
    <div className="review-simple-ratio-grid">{names.map(name=><label key={name} className={Number(inputs[name])>0?"review-ratio-used":""}><span>{name}</span><input inputMode="decimal" aria-label={`${name} ratio value`} value={inputs[name]??0} onChange={event=>{const next={...inputs,[name]:event.target.value};setInputs(next);onChange(simpleRatioFromValues(row,names,next));}}/></label>)}</div>
    {preview?<div className="review-ratio-preview" aria-live="polite">{preview}</div>:<small className="review-ratio-guidance">{message}</small>}
  </div>;
}

import type { ReviewConstraint, ReviewConstituent } from "./types";
import { normalizeFiniteDraft } from "./numericDraft";

type RatioValue = number | [number,number];
export type RatioInterval = { lower:number; upper:number; lowerEndpoint?:string|null; upperEndpoint?:string|null };

export function prepareRatio(row:ReviewConstraint):ReviewConstraint {
  const refs=row.member_refs || [];
  if(refs.length<2 || new Set(refs).size!==refs.length) throw new Error("Select at least two different constituents.");
  const result:ReviewConstraint={constraint_id:row.constraint_id,mode:"ratio",member_refs:[...refs]};
  if(row.ratio_values !== undefined) {
    if(row.ratio_values.length!==refs.length) throw new Error("Enter one ratio value or range for each selected constituent.");
    const number=(value:unknown,label:string)=>{const n=normalizeFiniteDraft(value as number|string|null,label);if(n==null || n<0)throw new Error(`${label}: enter a non-negative number.`);return n;};
    const values:RatioValue[]=row.ratio_values.map((v,i)=>{
      if(Array.isArray(v)){const lo=number(v[0],`${refs[i]} lower ratio`),hi=number(v[1],`${refs[i]} upper ratio`);if(lo>hi)throw new Error(`${refs[i]}: lower ratio cannot exceed upper ratio.`);return [lo,hi];}
      return number(v,`${refs[i]} ratio`);
    });
    if(!values.some(v=>(Array.isArray(v)?v[1]:v)>0))throw new Error("A ratio cannot contain only zeros.");
    result.ratio_values=values;
  }
  return result;
}

export function toggleRatioMember(row:ReviewConstraint,name:string,selected:boolean):ReviewConstraint {
  const refs=row.member_refs || [],index=refs.indexOf(name);
  if(selected && index<0)return {...row,member_refs:[...refs,name],...(row.ratio_values!==undefined?{ratio_values:[...row.ratio_values,""]}:{})};
  if(!selected && index>=0)return {...row,member_refs:refs.filter((_,i)=>i!==index),...(row.ratio_values!==undefined?{ratio_values:row.ratio_values.filter((_,i)=>i!==index)}:{})};
  return row;
}

function concentrationUnit(unit:unknown):[string,number] {
  const key=String(unit || "").toLowerCase().replace(/[\s._-]/g,"");
  if(!key)throw new Error("Base concentration units are required to calculate a ratio.");
  if(["wt%","weight%","mass%","%byweight","%bymass","%w/w"].includes(key))return ["mass",1];
  if(["at%","atomic%","atom%","%atomic","%byatom","%byatoms"].includes(key))return ["atomic",1];
  if(["ppmbyweight","massppm","wtppm"].includes(key))return ["mass",0.0001];
  if(["atomicppm","atppm","ppmbyatom","ppmbyatoms"].includes(key))return ["atomic",0.0001];
  return [key,1];
}
export function ratioBase(row:ReviewConstituent):RatioInterval & {unit:string;factor:number} {
  if(row.constituent_status==="excluded")throw new Error(`${row.constituent_name} is excluded.`);
  const amount=row.amounts ? row.amounts.find(a=>a.preferred_order===0 || (a.preferred_order==null && a.role==="general")) : row;
  if(!amount || amount.amount_comparator==null)throw new Error(`${row.constituent_name} needs a Base concentration.`);
  if(amount.amount_comparator==="balance")throw new Error(`${row.constituent_name} has an unresolved balance.`);
  const single=["equal","=","approximate","approx","~"].includes(amount.amount_comparator);
  const lo=normalizeFiniteDraft((single ? amount.amount_value : amount.amount_lower_value) as number|string|null,`${row.constituent_name} Base lower`),hi=normalizeFiniteDraft((single ? amount.amount_value : amount.amount_upper_value) as number|string|null,`${row.constituent_name} Base upper`);
  if(lo==null || hi==null || lo<0 || hi<lo)throw new Error(`${row.constituent_name} needs a finite Base value or two-sided range.`);
  const [unit,factor]=concentrationUnit(amount.amount_unit);
  const endpoint=single ? (["equal","="].includes(amount.amount_comparator)?"closed":"approx") : null;
  return {lower:lo,upper:hi,unit,factor,lowerEndpoint:single?endpoint:amount.amount_lower_endpoint_type,upperEndpoint:single?endpoint:amount.amount_upper_endpoint_type};
}
export function ratioIntervals(row:ReviewConstraint,constituents:ReviewConstituent[]):RatioInterval[] {
  const prepared=prepareRatio(row);
  if(prepared.ratio_values)return prepared.ratio_values.map(v=>Array.isArray(v)?{lower:Number(v[0]),upper:Number(v[1]),lowerEndpoint:"closed",upperEndpoint:"closed"}:{lower:Number(v),upper:Number(v),lowerEndpoint:"closed",upperEndpoint:"closed"});
  const values=prepared.member_refs!.map(ref=>{const c=constituents.find(c=>c.constituent_name===ref);if(!c)throw new Error(`Unknown ratio constituent: ${ref}`);return ratioBase(c);});
  if(new Set(values.map(v=>v.unit)).size!==1)throw new Error("Ratio concentrations must use compatible units.");
  const first=values[0];if(first.lower<=0)throw new Error("The first constituent needs a strictly positive Base lower value.");
  const endpoint=(a:unknown,b:unknown)=>a==="approx" || b==="approx" || !a || !b ? "approx" : a==="open" || b==="open" ? "open" : "closed";
  return values.map((v,i)=>{
    if(!i)return {lower:1,upper:1,lowerEndpoint:"closed",upperEndpoint:"closed"};
    const lower=(v.lower*v.factor)/(first.upper*first.factor),upper=(v.upper*v.factor)/(first.lower*first.factor);
    if(!Number.isFinite(lower)||!Number.isFinite(upper))throw new Error("Calculated ratio exceeds the supported numeric range.");
    return {lower,upper,lowerEndpoint:endpoint(v.lowerEndpoint,first.upperEndpoint),upperEndpoint:endpoint(v.upperEndpoint,first.lowerEndpoint)};
  });
}
const displayNumber=(value:number)=>String(value);
export function ratioIntervalText(v:RatioInterval) {
  const approximate=v.lowerEndpoint==="approx" || v.upperEndpoint==="approx";
  if(v.lower===v.upper)return `${approximate?"≈":""}${displayNumber(v.lower)}`;
  if(v.lowerEndpoint==="open" || v.upperEndpoint==="open")return `${v.lowerEndpoint==="open"?">":"≥"}${displayNumber(v.lower)} to ${v.upperEndpoint==="open"?"<":"≤"}${displayNumber(v.upper)}`;
  return `${approximate?"≈":""}${displayNumber(v.lower)}–${displayNumber(v.upper)}`;
}
export function ratioProblem(row:ReviewConstraint,constituents:ReviewConstituent[]):string|null {
  try {ratioIntervals(row,constituents);return null;}catch(error){return error instanceof Error?error.message:"Invalid ratio.";}
}

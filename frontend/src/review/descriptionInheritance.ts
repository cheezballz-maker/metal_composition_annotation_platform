import type { ReviewComposition, ReviewCompositionData, ReviewConstraint, ReviewConstituent } from "./types";

export function inheritanceBase(data: ReviewCompositionData): number | undefined {
  return data.inherits_from;
}

export function instanceNumber(composition: ReviewComposition): number {
  return composition.instance_index ?? Number(composition.data.node_no);
}

/** Read through the parent chain; never copy inherited fields into the child. */
export function inheritedInformation(data: ReviewCompositionData, records: ReviewComposition[]): { constituents: ReviewConstituent[]; constraints: ReviewConstraint[]; otherRules: unknown[] } {
  const constituents = new Map<string, ReviewConstituent>();
  const constraints = new Map<string, ReviewConstraint>();
  const otherRules: unknown[] = [];
  const seen = new Set<number>();
  const collect = (child: ReviewCompositionData) => {
    const link = inheritanceBase(child);
    if (!link || seen.has(link)) return;
    seen.add(link);
    const base = records.find(record => !record.deleted && Number(record.data.node_no) === link);
    if (!base) return;
    collect(base.data);
    for (const row of base.data.constituents || []) constituents.set(row.constituent_name, row);
    for (const row of base.data.constraints || []) constraints.set(String(row.constraint_id), row);
    otherRules.push(...(base.data.unrepresented_relations || []).filter(rule=>!rule || typeof rule!=="object" || (rule as {kind?:string}).kind!=="inherits_from"));
  };
  collect(data);
  return { constituents: [...constituents.values()], constraints: [...constraints.values()], otherRules };
}

export function inheritanceBaseReason(data: ReviewCompositionData, base: ReviewComposition, records: ReviewComposition[]): string | null {
  if (base.deleted) return "Deleted instance";
  const ownNode = Number(data.node_no);
  let current: ReviewComposition | undefined = base;
  const visited = new Set<number>();
  while (current) {
    const node: number = Number(current.data.node_no);
    if (node === ownNode || visited.has(node)) return "Would create an inheritance cycle";
    visited.add(node);
    const link = inheritanceBase(current.data);
    if (!link) break;
    if (link === ownNode) return "Would create an inheritance cycle";
    current = records.find(record => !record.deleted && Number(record.data.node_no) === link);
    if (!current) return "Base is unavailable";
  }
  const inherited = inheritedInformation({ inherits_from: Number(base.data.node_no) }, records);
  const names = new Set(inherited.constituents.map(row => row.constituent_name));
  const duplicates = (data.constituents || []).map(row => row.constituent_name).filter(name => names.has(name));
  if (duplicates.length) return `Already records ${duplicates.join(", ")}`;
  const ids = new Set(inherited.constraints.map(row => row.constraint_id));
  if (data.constraints?.some(row => ids.has(row.constraint_id))) return "Repeats an inherited restriction ID";
  if (data.constituents?.some(row => row.constituent_status === "excluded")) return "Contains an exclusion; only additions can inherit";
  return null;
}

export function setInheritanceBase(data: ReviewCompositionData, node: number | null): ReviewCompositionData {
  const { inherits_from: previous, ...rest } = data;
  return node == null ? rest : { ...rest, inherits_from: node };
}

/** Add-only is a schema rule; no per-link operations or provenance are generated. */
export function prepareAddOnlyInheritance(data: ReviewCompositionData, records: ReviewComposition[]): ReviewCompositionData {
  const node = inheritanceBase(data);
  if (node == null) return data;
  const base = records.find(record => Number(record.data.node_no) === node);
  if (!base) throw new Error("The inherited base is unavailable. Choose another base.");
  const reason = inheritanceBaseReason(data, base, records);
  if (reason) throw new Error(`Cannot inherit from this instance: ${reason}. Remove conflicting local entries or choose another base.`);
  return data;
}

/** Group each family without changing stable instance numbers, including when filtered. */
export function orderInheritanceFamilies<T extends { composition: ReviewComposition }>(entries: T[]): T[] {
  const byNode = new Map(entries.map(entry => [Number(entry.composition.data.node_no), entry]));
  const children = new Map<number, T[]>();
  const roots: T[] = [];
  for (const entry of entries) {
    const parent = inheritanceBase(entry.composition.data);
    if (parent != null && byNode.has(parent)) children.set(parent, [...(children.get(parent) || []), entry]);
    else roots.push(entry);
  }
  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (entry: T) => {
    if (seen.has(entry.composition.id)) return;
    seen.add(entry.composition.id); ordered.push(entry);
    for (const child of children.get(Number(entry.composition.data.node_no)) || []) visit(child);
  };
  roots.forEach(visit); entries.forEach(visit);
  return ordered;
}

/** Layout uses the full family, so filtering cannot turn siblings into a chain. */
export function inheritanceRoutes<T extends {composition: ReviewComposition}>(visible: T[], all: T[]) {
  const shown = new Set(visible.map(e => e.composition.id));
  const complete = orderInheritanceFamilies(all.filter(e => !e.composition.deleted || shown.has(e.composition.id)));
  const children = new Map<number,T[]>();
  complete.forEach(entry => {
    const parent = inheritanceBase(entry.composition.data);
    if (parent != null) children.set(parent,[...(children.get(parent) || []),entry]);
  });
  const laneEnds: number[] = [];
  const routes: Array<{parent: string; children: string[]; lane: number | null}> = [];
  complete.forEach((entry,index) => {
    const descendants = children.get(Number(entry.composition.data.node_no)) || [];
    if (!descendants.length) return;
    let lane: number | null = null;
    if (descendants.length > 1) {
      const last = Math.max(...descendants.map(child => complete.findIndex(e => e.composition.id === child.composition.id)));
      const available = laneEnds.findIndex(end => end < index);
      lane = available < 0 ? laneEnds.length : available;
      laneEnds[lane] = last;
    }
    if (shown.has(entry.composition.id)) {
      const ids = descendants.filter(child => shown.has(child.composition.id)).map(child => child.composition.id);
      if (ids.length) routes.push({parent:entry.composition.id, children:ids, lane});
    }
  });
  return {routes,gutter:12 + Math.max(1,laneEnds.length)*12};
}

import React from "react";
import { Check, Plus, RotateCcw, Search, X } from "lucide-react";
import type { OccurrenceEntry } from "./descriptionNavigation";
import { inheritanceBase, inheritanceRoutes, orderInheritanceFamilies } from "./descriptionInheritance";
export function DescriptionNavigator({ entries, allEntries = entries, total, deleted, query, onQuery, activeId, adding, onSelect, onAdd, editable, decided, seeds, onCompositionAction, showDeleted, onShowDeleted }: {
  allEntries?: OccurrenceEntry[];
  entries: OccurrenceEntry[]; total: number; deleted: number; query: string; onQuery: (value: string) => void;
  activeId: string | null; adding: boolean; onSelect: (id: string) => void; onAdd: () => void; editable: boolean;
  decided: number; seeds: number; onCompositionAction: (id: string, action: string) => void;
  showDeleted: boolean; onShowDeleted: (show: boolean) => void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const badges = React.useRef(new Map<string, HTMLSpanElement>());
  const ordered = React.useMemo(() => orderInheritanceFamilies(entries), [entries]);
  const routing = React.useMemo(() => inheritanceRoutes(ordered, allEntries), [ordered, allEntries]);
  const markerId = `inheritance-arrow-${React.useId().replace(/:/g, "")}`;
  const [connectors, setConnectors] = React.useState<Array<{id: string; path: string; arrow: boolean}>>([]);
  React.useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const bounds = content.getBoundingClientRect();
      const paths: Array<{id:string;path:string;arrow:boolean}> = [];
      for (const route of routing.routes) {
        const parent = badges.current.get(route.parent)?.getBoundingClientRect();
        if (!parent) continue;
        const children = route.children.flatMap(id => {
          const badge = badges.current.get(id)?.getBoundingClientRect();
          return badge ? [{id,badge}] : [];
        });
        if (!children.length) continue;
        if (route.lane == null) {
          const child = children[0];
          paths.push({id:child.id,arrow:true,path:`M ${parent.left+parent.width/2-bounds.left} ${parent.bottom-bounds.top+1} L ${child.badge.left+child.badge.width/2-bounds.left} ${child.badge.top-bounds.top-3}`});
        } else {
          const x = 10 + route.lane*12;
          const y = parent.top+parent.height/2-bounds.top;
          const lastY = Math.max(...children.map(child => child.badge.top+child.badge.height/2-bounds.top));
          paths.push({id:`trunk:${route.parent}`,arrow:false,path:`M ${parent.left-bounds.left-1} ${y} H ${x} V ${lastY}`});
          for (const child of children) {
            const cy = child.badge.top+child.badge.height/2-bounds.top;
            paths.push({id:child.id,arrow:true,path:`M ${x} ${cy} H ${child.badge.left-bounds.left-3}`});
          }
        }
      }
      setConnectors(current => JSON.stringify(current) === JSON.stringify(paths) ? current : paths);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [routing]);
  React.useEffect(() => {
    listRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeId, adding, query, entries]);
  return <aside className="review-composition-navigation" aria-label="Composition navigation">
    <header className="review-composition-nav-heading"><div><h2 className="review-panel-title review-title-compositions">Compositions</h2><span className="review-panel-caption">{total - deleted} instances · {seeds - decided} left to review</span></div><div className="review-nav-actions"><label className="review-show-deleted"><input type="checkbox" checked={showDeleted} onChange={event => onShowDeleted(event.target.checked)}/> Show deleted{deleted > 0 ? ` (${deleted})` : ""}</label>{editable && <button type="button" className="review-add-composition" aria-label="Add composition" title="Add composition" onClick={onAdd}><Plus size={14}/> Add</button>}</div></header>
    <div className="review-occurrence-search"><div><Search size={14}/><input id="composition-evidence-search" aria-label="Find compositions by evidence text" type="search" value={query} onChange={e => onQuery(e.target.value)} placeholder="Search evidence text…"/>{query && <button type="button" aria-label="Clear evidence search" onClick={() => onQuery("")}><X size={13}/></button>}</div>{query && <span role="status">{entries.length} matching instances</span>}</div>
    <div ref={listRef} className="review-occurrence-list" aria-label="Composition instances"><div ref={contentRef} className="review-occurrence-content" style={{"--review-inheritance-gutter":`${routing.gutter}px`} as React.CSSProperties}>
      <svg className="review-inheritance-arrows" aria-hidden="true"><defs><marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 5 3 L 0 6 Z" fill="#8293a7"/></marker></defs>{connectors.map(connector => <path key={connector.id} data-inheritance-child={connector.arrow ? connector.id : undefined} data-inheritance-trunk={!connector.arrow ? connector.id : undefined} d={connector.path} fill="none" stroke="#8293a7" strokeWidth="1" strokeDasharray="1 3" strokeLinecap="round" markerEnd={connector.arrow ? `url(#${markerId})` : undefined}/>)}</svg>
      {ordered.map(entry => {
      const { composition, occurrence } = entry;
      const link = inheritanceBase(composition.data);
      const parent = link ? allEntries.find(item => Number(item.composition.data.node_no) === link) : undefined;
      const usedAsBase = allEntries.some(item => !item.composition.deleted && inheritanceBase(item.composition.data) === Number(composition.data.node_no));
      return <div key={composition.id} className={`review-occurrence-shell${composition.deleted ? " deleted" : ""}${link ? " review-derived-occurrence" : ""}`}>
        <button type="button" aria-label={`Composition Instance ${occurrence}: ${composition.data.composition_name || "Unnamed composition"}${composition.deleted ? ", deleted" : ""}${parent ? `, inherits from Composition Instance ${parent.occurrence}` : ""}`} aria-pressed={!adding && activeId === composition.id} aria-controls="description-composition-details" className="review-occurrence-row" onClick={() => onSelect(composition.id)}>
          <span ref={element => {if (element) badges.current.set(composition.id,element);else badges.current.delete(composition.id);}} className="review-occurrence-number" aria-label={`Composition Instance ${occurrence}`}>{occurrence}</span><strong title={composition.data.composition_name}>{composition.data.composition_name || "Unnamed composition"}</strong>
        </button>
        {editable && <div className="review-occurrence-actions">{composition.deleted ? <button type="button" className="review-recover" aria-label={`Recover composition instance ${occurrence}`} title="Recover composition" onClick={() => onCompositionAction(composition.id,"restore")}><RotateCcw size={14}/></button> : <>{composition.origin === "seed" && composition.decision === "pending" && <button type="button" aria-label={`Accept composition instance ${occurrence}`} title="Accept composition" onClick={() => onCompositionAction(composition.id,"accept")}><Check size={14}/></button>}<button type="button" className="review-hover-delete" aria-label={`Delete composition instance ${occurrence}`} title={usedAsBase ? "Unlink child instances before deleting their base" : "Delete composition"} disabled={usedAsBase} onClick={() => onCompositionAction(composition.id,"delete")}><X size={14}/></button></>}</div>}
      </div>;
    })}{!entries.length && <div className="review-occurrence-empty">{query ? <>No evidence matches this fragment.<button type="button" onClick={() => onQuery("")}>Clear search</button></> : "No composition instances yet."}</div>}</div></div>
  </aside>;
}

import React from "react";
import { MoreHorizontal } from "lucide-react";
import { createPortal } from "react-dom";

export type ReviewContextAction = { id: string; label: string; danger?: boolean; disabled?: boolean };

export function ReviewContextMenu({ children, actions, onAction, label = "More options", className = "" }: {
  children?: React.ReactNode; actions: ReviewContextAction[]; onAction: (id: string) => void;
  label?: string; className?: string;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(position.x, innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(position.y, innerHeight - rect.height - 8));
    if (x !== position.x || y !== position.y) setPosition({x,y});
  }, [position]);
  React.useEffect(() => {
    if (!position) return;
    const dismiss = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPosition(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") {event.preventDefault();event.stopPropagation();setPosition(null);} };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [position]);
  const show = (x: number, y: number) => setPosition({x:Math.max(8,Math.min(x,innerWidth-170)),y:Math.max(8,Math.min(y,innerHeight-actions.length*32-16))});
  return <div ref={root} className={`review-context-target ${className}`} onContextMenu={event => { if (!actions.length) return; event.preventDefault(); event.stopPropagation(); show(event.clientX,event.clientY); }}>
    {children}{actions.length > 0 && <button type="button" className="review-context-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={event => { const r=event.currentTarget.getBoundingClientRect(); show(r.right,r.bottom); }}><MoreHorizontal size={16}/></button>}
    {position && createPortal(<div ref={menu} className="review-context-menu" role="menu" aria-label={label} style={{left:position.x,top:position.y}} onKeyDown={event => { if (!["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return; event.preventDefault(); const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []); const current = items.indexOf(document.activeElement as HTMLButtonElement); items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus(); }}>{actions.map(action => <button type="button" role="menuitem" disabled={action.disabled} key={action.id} className={action.danger ? "danger" : ""} onClick={() => {setPosition(null);onAction(action.id);}}>{action.label}</button>)}</div>, document.body)}
  </div>;
}

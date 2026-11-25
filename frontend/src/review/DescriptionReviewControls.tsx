import React from "react";
import type { ReviewAction, ReviewDocument } from "./types";
import { descriptionReviewLabel, descriptionReviewState, descriptionReviewLocked } from "./descriptionReview";
import { ReviewContextMenu } from "./ReviewContextMenu";

export function DescriptionReviewControls({ document, pending, disabled, onAction }: {
  document: ReviewDocument; pending: number; disabled: boolean;
  onAction: (action: ReviewAction, options?: { sourceChecked?: boolean; reviewReason?: string }) => Promise<unknown>;
}) {
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [helpNote, setHelpNote] = React.useState(document.review_reason || "");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if(!helpOpen) return;
    const escape=(event:KeyboardEvent)=>{if(event.key === "Escape" && !event.defaultPrevented && !saving){event.preventDefault();setHelpOpen(false);}};
    window.addEventListener("keydown",escape);return()=>window.removeEventListener("keydown",escape);
  },[helpOpen,saving]);
  const reviewState = descriptionReviewState(document);
  const locked = descriptionReviewLocked(document);
  const blocked = Boolean(document.workflow?.has_blocking_source_gaps);
  const undone = new Set(document.events.filter(event => event.action === "undo").map(event => event.undoes_action_id));
  const undoAvailable = document.events.some(event => ["accept","edit","delete","add","restore","reverse"].includes(event.action) && event.composition_id && event.action_id && !undone.has(event.action_id));
  const run = async (action: ReviewAction, options = {}) => {
    setSaving(true);
    try { const saved = await onAction(action, options); if (saved) setHelpOpen(false); }
    finally { setSaving(false); }
  };
  return <div className="review-document-toolbar" aria-label="Document review">
    {reviewState !== "done" && reviewState !== "needs_help" && <span className="review-document-state">{descriptionReviewLabel(document)}</span>}
    <ReviewContextMenu label="Document actions" actions={[...(locked ? [{id:"reopen",label:"Unlock to review",disabled:disabled || saving}] : [{id:"done",label:"Finalize annotation",disabled:disabled || saving || pending > 0 || blocked},{id:"help",label:"Flag annotation",disabled:disabled || saving}]), ...(!locked && undoAvailable ? [{id:"undo",label:"Undo (Cntrl + Z)",disabled:disabled || saving}] : [])]} onAction={action => {
      if (action === "reopen") void run("reopen_review");
      if (action === "done" && !pending && !blocked) void run("mark_done", { sourceChecked: true });
      if (action === "help") setHelpOpen(true);
      if (action === "undo") void run("undo");
    }}/>
    {helpOpen && <div className="review-help-popover"><label>What needs attention?<textarea autoFocus value={helpNote} onChange={event => setHelpNote(event.target.value)}/></label><div><button className="review-primary" disabled={disabled || saving || !helpNote.trim()} onClick={() => void run("request_help", { reviewReason: helpNote })}>Flag annotation</button><button onClick={() => setHelpOpen(false)}>Cancel</button></div></div>}
  </div>;
}

export function FlagReasonPopover({ reason }: { reason: string }) {
  const [open,setOpen]=React.useState(false);
  const [left,setLeft]=React.useState(0);
  const root=React.useRef<HTMLDivElement>(null);
  const trigger=React.useRef<HTMLButtonElement>(null);
  const popover=React.useRef<HTMLDivElement>(null);
  const id=React.useId();
  React.useEffect(()=>setOpen(false),[reason]);
  React.useLayoutEffect(()=>{
    if(!open) return;
    const fit=()=>{const rect=root.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(360,window.innerWidth-24);setLeft(Math.max(12,Math.min(rect.left,window.innerWidth-width-12))-rect.left);};
    fit();window.addEventListener("resize",fit);return()=>window.removeEventListener("resize",fit);
  },[open]);
  React.useEffect(()=>{
    if(!open) return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key === "Escape" && !event.defaultPrevented){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus({preventScroll:true});}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    popover.current?.focus({preventScroll:true});
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[open]);
  return <div ref={root} className="review-flag-reason"><button ref={trigger} type="button" className="review-flag-reason-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={()=>setOpen(value=>!value)}>View reason</button>{open && <div ref={popover} id={id} role="dialog" aria-label="Flag reason" tabIndex={-1} className="review-flag-reason-popover" style={{left}}><strong>Flag reason</strong><p>{reason}</p></div>}</div>;
}

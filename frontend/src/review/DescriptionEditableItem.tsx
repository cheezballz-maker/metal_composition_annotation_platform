import React from "react";
import { X } from "lucide-react";

/** Direct editing and a separate hover action; read-only content has no controls. */
export function DescriptionEditableItem({ children, label, onEdit, onDelete, deleteLabel, deleteDisabled, className = "" }: {
  children: React.ReactNode; label: string; onEdit?: () => void; onDelete?: () => void;
  deleteLabel?: string; deleteDisabled?: string; className?: string;
}) {
  return <div className={`review-direct-item ${className}`}>
    {onEdit ? <button type="button" className="review-direct-content" aria-label={label} onClick={onEdit}>{children}</button> : <div className="review-direct-content">{children}</div>}
    {onDelete && <button type="button" className="review-hover-delete" aria-label={deleteLabel || `Delete ${label}`} title={deleteDisabled || deleteLabel || `Delete ${label}`} disabled={Boolean(deleteDisabled)} onClick={onDelete}><X size={14}/></button>}
  </div>;
}

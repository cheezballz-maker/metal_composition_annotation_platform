import React from "react";
import { ChevronRight } from "lucide-react";
import { SourceLink } from "./EvidenceFocus";
import type { RawEvidence } from "./types";

export function JsonNode({ label, value, scope }: { label: string; value: unknown; scope?: RawEvidence[] }) {
  const [open, setOpen] = React.useState(false);
  if (value === null || typeof value !== "object") return <div className="review-json-leaf"><span>{label}: </span><code>{JSON.stringify(value) ?? "undefined"}</code></div>;
  const entries = Object.entries(value);
  return <div className="review-json-branch">
    <details className="review-json-node" onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
      <summary><ChevronRight size={13}/><span>{label}</span><small>{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</small></summary>
      {open && <div className="review-json-children">{entries.length ? entries.map(([key, child]) => <JsonNode key={key} label={Array.isArray(value) && child && typeof child === "object" && "constituent_name" in child ? `${key}: ${String(child.constituent_name)}` : key} value={child} scope={scope}/>) : <code>{Array.isArray(value) ? "[]" : "{}"}</code>}</div>}
    </details>
    <SourceLink value={value} label={label} scope={scope}/>
  </div>;
}

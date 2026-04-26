/**
 * ConflictSourceCards — Scenario 2 from conflict_mockups_v2.html.
 *
 * Two self-contained source cards (Anchor + Variant) with header, metadata
 * strip, value row, snippet box, and audit footer. The Variant card adopts
 * a warm-orange tint via the .qx-card--variant CSS modifier.
 *
 * Styles live in src/index.css under the qx-* prefix so the global token
 * palette stays untouched. The local CSS vars on .qx-conflict-cards
 * mirror the mockup colors exactly.
 */

import { FileText } from "lucide-react";
import type { ReactNode } from "react";

export interface SourceCardData {
  doc_name: string;
  doc_url: string;
  metadata: string[]; // e.g. ["14 Mar 2025", "12pp", "signed by JM", "clause 4.2 · p.4"]
  field: string;      // e.g. "Amount"
  value: string;      // e.g. "EUR 1,240,000"
  snippet_loc: string;     // e.g. "p.4 · ln 47"
  snippet_link: string;    // anchor URL into the doc
  snippet_text: string;    // contract excerpt; uses {VALUE} or contains the highlight literally
  highlight: string;       // substring to wrap in <mark>
  audit_left: string;
  audit_right: string;
}

export interface ConflictSourceCardsProps {
  sectionLabel: string;
  anchor: SourceCardData;
  variant: SourceCardData;
}

export function ConflictSourceCards({
  sectionLabel,
  anchor,
  variant,
}: ConflictSourceCardsProps) {
  return (
    <section className="qx-conflict-cards">
      <div className="qx-section-label">{sectionLabel}</div>
      <div className="qx-cards-grid">
        <SourceCard data={anchor} role="anchor" />
        <SourceCard data={variant} role="variant" />
      </div>
    </section>
  );
}

function SourceCard({
  data,
  role,
}: {
  data: SourceCardData;
  role: "anchor" | "variant";
}) {
  const cardClass = role === "variant" ? "qx-card qx-card--variant" : "qx-card";
  const roleLabel = role === "variant" ? "Variant" : "Anchor";

  return (
    <div className={cardClass}>
      <header className="qx-card-header">
        <a
          className="qx-doc-link"
          href={data.doc_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText className="qx-doc-icon" strokeWidth={1.5} />
          {data.doc_name}
        </a>
        <span className="qx-role-badge">{roleLabel}</span>
      </header>

      <div className="qx-card-body">
        <div className="qx-meta-strip">
          {data.metadata.map((m, i) => (
            <span key={`${m}-${i}`}>{m}</span>
          ))}
        </div>

        <div className="qx-field-row">
          <span className="qx-field-label">{data.field}</span>
          <span className="qx-value">{data.value}</span>
        </div>

        <div className="qx-snippet-wrap">
          <div className="qx-snippet-head">
            <span>{data.snippet_loc}</span>
            <a href={data.snippet_link} target="_blank" rel="noopener noreferrer">
              ↗ open at line
            </a>
          </div>
          <div className="qx-snippet-text">
            {renderSnippetWithMark(data.snippet_text, data.value, data.highlight)}
          </div>
        </div>

        <div className="qx-audit">
          <span>{data.audit_left}</span>
          <span>{data.audit_right}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Wrap the highlight (or the resolved value where {VALUE} appears) in a <mark>.
 * Falls back to plain text if neither token is found.
 */
function renderSnippetWithMark(
  text: string,
  value: string,
  highlight: string
): ReactNode {
  // Resolve {VALUE} placeholder if present in the snippet template.
  const resolved = text.includes("{VALUE}") ? text.replace("{VALUE}", highlight) : text;
  if (!highlight) return resolved;
  const idx = resolved.indexOf(highlight);
  if (idx < 0) return resolved;
  return (
    <>
      {resolved.slice(0, idx)}
      <mark>{highlight}</mark>
      {resolved.slice(idx + highlight.length)}
    </>
  );
}

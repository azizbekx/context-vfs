/**
 * Adapter: backend conflict shapes → UI ConflictItem.
 *
 * The backend's `graph.conflicts` is heterogeneous (entity_match_review,
 * employee_name_inconsistency, human_edit). The Review screen renders a
 * single ConflictItem shape. Each branch here picks the most informative
 * fields and synthesizes the rest (severity, parties, verdict, evidence)
 * so the UI can stay shape-agnostic.
 */

import type {
  BackendConflict,
  EntityMatchReviewConflict,
  EmployeeNameInconsistencyConflict,
  PropertyChangeConflict,
} from "./api";
import type {
  AuditEntry,
  ConflictField,
  ConflictItem,
  EvidenceDoc,
  Severity,
  Verdict,
} from "./review-data";

const LENS_FALLBACK_BY_TYPE: Record<string, string> = {
  Client: "v_atlas",
  Vendor: "v_atlas",
  Employee: "p_jdoe",
  Customer: "a_acc88",
  Product: "i_inv77",
};

function lensFocusForEntity(entityRef?: string): string {
  if (!entityRef) return "p_jdoe";
  const [type] = entityRef.split(":");
  return LENS_FALLBACK_BY_TYPE[type] ?? "p_jdoe";
}

function ageLabel(detectedAt?: string): string {
  if (!detectedAt) return "—";
  const t = Date.parse(detectedAt);
  if (Number.isNaN(t)) return "—";
  const minutes = Math.floor((Date.now() - t) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function provenanceToEvidence(
  prov: { source_system?: string; file?: string; record_id?: string; ingested_at?: string } | undefined,
  side: "A" | "B",
  fallbackParty: string
): EvidenceDoc {
  const filename = prov?.file ?? `${prov?.source_system ?? "unknown"}.json`;
  const date = (prov?.ingested_at ?? "").slice(0, 10) || "—";
  return {
    side,
    party: fallbackParty,
    filename,
    pages: 1,
    date,
    uploader: prov?.source_system ?? "system",
    quote: `record ${prov?.record_id ?? "—"} from ${prov?.source_system ?? "—"}`,
    highlight: prov?.record_id ?? "",
  };
}

/* ================================================================ */
/* entity_match_review                                              */
/* ================================================================ */

function adaptEntityMatchReview(
  c: EntityMatchReviewConflict,
  index: number
): ConflictItem {
  const a = c.member_summaries[0];
  const b = c.member_summaries[1] ?? a;
  const partyA = a?.business_name || a?.name || a?.id || "Source A";
  const partyB = b?.business_name || b?.name || b?.id || "Source B";

  // Build conflict fields from member differences
  const fields: ConflictField[] = [];
  const pushIfDiffer = (label: string, va?: string | null, vb?: string | null) => {
    if ((va ?? "").trim() && (vb ?? "").trim() && va !== vb) {
      fields.push({
        label,
        sourceA: { label: "Source A", value: String(va) },
        sourceB: { label: "Source B", value: String(vb) },
      });
    }
  };
  pushIfDiffer("NAME", a?.business_name ?? a?.name, b?.business_name ?? b?.name);
  pushIfDiffer("TAX ID", a?.tax_id, b?.tax_id);
  pushIfDiffer("ADDRESS", a?.registered_address, b?.registered_address);
  pushIfDiffer("INDUSTRY", a?.industry, b?.industry);

  // Severity comes from how confident the resolver is. Lower match_score
  // means more uncertainty, which means more reason for human review.
  const severity: Severity =
    c.match_score < 0.6 ? "HIGH" : c.match_score < 0.8 ? "MED" : "LOW";

  // Match-score below the resolver's auto-merge threshold = the model
  // explicitly couldn't decide → recommend Escalate, not Reject/Accept.
  const verdict: Verdict = "Escalate";

  return {
    id: `Q-${1000 + index}`,
    severity,
    title: `Cross-source identity match — ${partyA} ↔ ${partyB}`,
    parties: [partyA, partyB],
    pausedAgentsCount: 0,
    ageLabel: ageLabel(c.detected_at),
    pausedAgents: [],
    unblockSummary: "No active workflows blocked",
    similarStat: `${c.member_types.join(" ↔ ")} · score ${c.match_score.toFixed(2)}`,
    verdict,
    confidence: c.match_score,
    rationale: `${c.review_reason}. Match signals: ${c.match_reasons.join("; ")}.`,
    conflicts: fields.length
      ? fields
      : [
          {
            label: "ENTITY",
            sourceA: { label: "Source A", value: a?.id ?? partyA },
            sourceB: { label: "Source B", value: b?.id ?? partyB },
          },
        ],
    collapsedMatchCount: 0,
    evidence: [
      {
        side: "A",
        party: partyA,
        filename: `${a?.type ?? "Source"}/${(a?.id ?? "").split(":")[1] ?? "—"}`,
        pages: 1,
        date: (c.detected_at ?? "").slice(0, 10) || "—",
        uploader: a?.type ?? "system",
        quote: `${a?.type ?? "Record"}: ${a?.business_name ?? a?.name ?? "—"} · ${a?.industry ?? ""}`,
        highlight: a?.business_name ?? a?.name ?? "",
      },
      {
        side: "B",
        party: partyB,
        filename: `${b?.type ?? "Source"}/${(b?.id ?? "").split(":")[1] ?? "—"}`,
        pages: 1,
        date: (c.detected_at ?? "").slice(0, 10) || "—",
        uploader: b?.type ?? "system",
        quote: `${b?.type ?? "Record"}: ${b?.business_name ?? b?.name ?? "—"} · ${b?.industry ?? ""}`,
        highlight: b?.business_name ?? b?.name ?? "",
      },
    ],
    audit: buildAudit(c.detected_at, "qontext-resolver", `flagged cluster, score ${c.match_score.toFixed(2)}`),
    lensFocusId: lensFocusForEntity(c.members[0]),
  };
}

/* ================================================================ */
/* employee_name_inconsistency                                      */
/* ================================================================ */

function adaptNameInconsistency(
  c: EmployeeNameInconsistencyConflict,
  index: number
): ConflictItem {
  const variantEntries = Object.entries(c.signature_variants).sort((x, y) => y[1] - x[1]);
  const topVariant = variantEntries[0]?.[0] ?? "(unknown)";
  const variantSummary = variantEntries
    .slice(0, 3)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");

  // Severity scales with how often the mismatch occurred.
  const severity: Severity =
    c.total_mismatched_emails >= 50
      ? "HIGH"
      : c.total_mismatched_emails >= 10
      ? "MED"
      : "LOW";

  // Three plausible interpretations: alias, shared mailbox, wrong sender_emp_id.
  // Confidence in any one is low → Escalate.
  return {
    id: `Q-${2000 + index}`,
    severity,
    title: `Email signature mismatch — ${c.hr_name} (${c.entity_id})`,
    parties: [c.hr_name, topVariant],
    pausedAgentsCount: 0,
    ageLabel: ageLabel(c.detected_at),
    pausedAgents: [],
    unblockSummary: `${c.total_mismatched_emails} emails affected`,
    similarStat: `${c.distinct_variant_count} signature variant${c.distinct_variant_count > 1 ? "s" : ""}`,
    verdict: "Escalate",
    confidence: Math.max(0.3, 1 - 0.15 * c.distinct_variant_count),
    rationale: `${c.total_mismatched_emails} emails sent under ${c.entity_id} were signed as someone other than HR-canonical "${c.hr_name}". Top variants: ${variantSummary}. Possible alias, shared mailbox, or wrong sender attribution.`,
    conflicts: [
      {
        label: "SIGNED NAME",
        sourceA: { label: "Source A", value: c.hr_name },
        sourceB: { label: "Source B", value: topVariant },
      },
    ],
    collapsedMatchCount: 0,
    evidence: [
      {
        side: "A",
        party: c.hr_name,
        filename: "HR/employees.json",
        pages: 1,
        date: (c.detected_at ?? "").slice(0, 10) || "—",
        uploader: "Human_Resource_Management",
        quote: `HR record: name = "${c.hr_name}", emp_id = ${c.entity_id.split(":")[1] ?? "—"}`,
        highlight: c.hr_name,
      },
      {
        side: "B",
        party: topVariant,
        filename: `Mail/sample × ${Math.min(c.sample_email_ids.length, 5)}`,
        pages: c.total_mismatched_emails,
        date: (c.detected_at ?? "").slice(0, 10) || "—",
        uploader: "Enterprise_Mail_System",
        quote: `Email signature: "${topVariant}" appearing on ${c.total_mismatched_emails} emails`,
        highlight: topVariant,
      },
    ],
    audit: buildAudit(c.detected_at, "qontext-detector", `flagged signature mismatch · ${c.total_mismatched_emails} emails`),
    lensFocusId: lensFocusForEntity(c.entity_id),
  };
}

/* ================================================================ */
/* property change (human_edit / source-driven update)              */
/* ================================================================ */

function adaptPropertyChange(c: PropertyChangeConflict, index: number): ConflictItem {
  const verdict: Verdict =
    c.conflict_type === "human_edit"
      ? "Accept"
      : c.resolution?.status === "auto_resolved"
      ? c.resolution?.winner === "new"
        ? "Reject"
        : "Accept"
      : "Escalate";

  const partyA = String(c.existing_value ?? "—").slice(0, 60);
  const partyB = String(c.new_value ?? "—").slice(0, 60);

  return {
    id: `Q-${3000 + index}`,
    severity: c.conflict_type === "human_edit" ? "LOW" : "MED",
    title: `${c.conflict_type === "human_edit" ? "Human override" : "Property change"} on ${c.entity_id} · ${c.field}`,
    parties: [partyA, partyB],
    pausedAgentsCount: 0,
    ageLabel: ageLabel(c.detected_at),
    pausedAgents: [],
    unblockSummary: "No active workflows blocked",
    similarStat: c.entity_type ?? "—",
    verdict,
    confidence: 1.0,
    rationale: c.resolution?.reason ?? `Property "${c.field}" on ${c.entity_id} changed from "${partyA}" to "${partyB}".`,
    conflicts: [
      {
        label: c.field.toUpperCase(),
        sourceA: { label: "Source A", value: String(c.existing_value ?? "—") },
        sourceB: { label: "Source B", value: String(c.new_value ?? "—") },
      },
    ],
    collapsedMatchCount: 0,
    evidence: [
      provenanceToEvidence(c.existing_provenance, "A", partyA),
      provenanceToEvidence(c.new_provenance, "B", partyB),
    ],
    audit: buildAudit(c.detected_at, c.new_provenance?.record_id ?? "system", c.resolution?.reason ?? "property changed"),
    lensFocusId: lensFocusForEntity(c.entity_id),
  };
}

/* ================================================================ */
/* Audit helper                                                      */
/* ================================================================ */

function buildAudit(detectedAt: string | undefined, actor: string, action: string): AuditEntry[] {
  const ts = (detectedAt ?? new Date().toISOString()).slice(0, 19).replace("T", " ");
  return [{ ts, actor, action }];
}

/* ================================================================ */
/* Public adapter                                                    */
/* ================================================================ */

export function adaptConflict(c: BackendConflict, index: number): ConflictItem | null {
  try {
    if (c.conflict_type === "entity_match_review") {
      return adaptEntityMatchReview(c as EntityMatchReviewConflict, index);
    }
    if (c.conflict_type === "employee_name_inconsistency") {
      return adaptNameInconsistency(c as EmployeeNameInconsistencyConflict, index);
    }
    // Treat anything else with field/existing_value as a property change.
    if ((c as PropertyChangeConflict).field !== undefined) {
      return adaptPropertyChange(c as PropertyChangeConflict, index);
    }
    return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("adaptConflict failed for", c, err);
    return null;
  }
}

/** Sort by severity (HIGH first) then by detection recency, so the queue
 *  surfaces the highest-impact pending items at the top. */
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };

export function adaptAll(backendConflicts: BackendConflict[]): ConflictItem[] {
  const items: ConflictItem[] = [];
  backendConflicts.forEach((c, i) => {
    const adapted = adaptConflict(c, i);
    if (adapted) items.push(adapted);
  });
  items.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    // Lower index = older detection in our synthetic ID scheme; we want
    // higher confidence first within a severity bucket.
    return b.confidence - a.confidence;
  });
  return items;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRight, ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";
import {
  QUEUE_STATS,
  type ConflictField,
  type ConflictItem,
  type Verdict,
} from "@/lib/review-data";
import { useConflicts } from "@/lib/useConflicts";
import { AvatarChip, Breadcrumb, DSButton, Kbd, SeverityBadge } from "@/components/ds";
import { ConflictSourceCards } from "@/components/ConflictSourceCards";

const VERDICT_COLOR: Record<Verdict, string> = {
  Reject: "text-coral",
  Accept: "text-mint",
  Escalate: "text-amber",
};

const VERDICT_OVERRIDE: Record<Verdict, Verdict> = {
  Reject: "Accept",
  Accept: "Reject",
  Escalate: "Accept",
};

/**
 * Map a raw conflict-field label to the compact "TYPE TAG" shown in the
 * detail header. Falls back to "{label} MISMATCH" for anything we haven't
 * special-cased — keeps the surface forgiving for new conflict types.
 */
const FIELD_TYPE_TAG: Record<string, string> = {
  AMOUNT: "AMOUNT MISMATCH",
  "RENEWAL AMOUNT": "AMOUNT MISMATCH",
  PARTY: "PARTY MISMATCH",
  "EFFECTIVE DATE": "DATE DIVERGENCE",
  "LEGAL ENTITY": "ENTITY MISMATCH",
  "PAYMENT TERMS": "TERMS MISMATCH",
  "GOVERNING LAW": "JURISDICTION CONFLICT",
  COUNTERPARTY: "COUNTERPARTY ALIAS",
  "INDEMNITY CAP": "WORDING VARIANCE",
  JURISDICTION: "JURISDICTION CONFLICT",
};

function typeTagFor(field: ConflictField): string {
  return FIELD_TYPE_TAG[field.label] ?? `${field.label} MISMATCH`;
}

/**
 * Pull a contextual phrase out of a conflict title, e.g.
 * "Contract value mismatch on MSA renewal — Acme vs. Beta" → "MSA renewal".
 * Returns "" if the title doesn't contain the "on …" pattern.
 */
function extractContext(title: string): string {
  const m = title.match(/\bon\s+(.+?)(\s+—|$)/i);
  if (!m) return "";
  return m[1].trim();
}

/** Pool of plausible matching field names — used purely for the collapsed
 *  "✓ X · Y · Z · N more match" line. Demo-grade. */
const MATCHING_FIELD_POOL = [
  "effective_date",
  "governing_law",
  "term_length",
  "currency",
  "auto_renewal",
  "payment_terms",
  "warranty",
  "indemnity_cap",
];

function matchingFieldNames(item: ConflictItem): string[] {
  const conflictingLabels = new Set(
    item.conflicts.map((c) => c.label.toLowerCase().replace(/\s+/g, "_"))
  );
  return MATCHING_FIELD_POOL.filter((n) => !conflictingLabels.has(n)).slice(
    0,
    item.collapsedMatchCount
  );
}

/* ------------------------------------------------------------------ */
/* Field-level diff computation                                        */
/* ------------------------------------------------------------------ */

interface FieldDiff {
  primary: string;       // big delta text e.g. "Δ +EUR 180,000"
  secondary?: string;    // small line e.g. "+14.5% · over 10% limit"
  warning: boolean;      // true when the diff exceeds an obvious threshold
}

function parseAmount(s: string): { num: number; currency: string } | null {
  const m = s.match(/^([A-Z]{2,3}|[€$£¥])\s*([0-9][0-9,.]*)/);
  if (!m) return null;
  const num = parseFloat(m[2].replace(/,/g, ""));
  if (Number.isNaN(num)) return null;
  return { num, currency: m[1] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(s: string): Date | null {
  // Native parser handles ISO + many common forms.
  const native = new Date(s);
  if (!Number.isNaN(native.getTime())) return native;
  // Fallback: "DD MMM YYYY"
  const m = s.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (m) {
    const idx = MONTHS.indexOf(m[2]);
    if (idx >= 0) return new Date(parseInt(m[3], 10), idx, parseInt(m[1], 10));
  }
  return null;
}

function semanticStringDiff(a: string, b: string): string {
  if (a === b) return "identical";
  // Suffix variation
  if (a.startsWith(b) || b.startsWith(a)) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    const suffix = longer.slice(shorter.length).trim();
    if (suffix) return `suffix '${suffix}' on one side`;
  }
  // Token overlap
  const tokensA = new Set(a.toLowerCase().split(/[\s.,]+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/[\s.,]+/).filter(Boolean));
  const intersection = [...tokensA].filter((t) => tokensB.has(t));
  const overlap = intersection.length / Math.max(tokensA.size, tokensB.size, 1);
  if (overlap >= 0.5) return "alias variation";
  return "different value";
}

function computeDiff(field: ConflictField): FieldDiff {
  const a = field.sourceA.value;
  const b = field.sourceB.value;

  // Numeric / currency
  const amountA = parseAmount(a);
  const amountB = parseAmount(b);
  if (amountA && amountB && amountA.currency === amountB.currency) {
    const delta = amountB.num - amountA.num;
    const pct = (delta / amountA.num) * 100;
    const sign = delta >= 0 ? "+" : "−";
    const abs = Math.abs(delta);
    const formatted = abs.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    const warning = Math.abs(pct) > 10;
    const secondary = `${sign}${Math.abs(pct).toFixed(1)}%${warning ? " · over 10% limit" : ""}`;
    return {
      primary: `Δ ${sign}${amountA.currency} ${formatted}`,
      secondary,
      warning,
    };
  }

  // Date diff
  const dateA = parseDate(a);
  const dateB = parseDate(b);
  if (dateA && dateB) {
    const days = Math.round((dateB.getTime() - dateA.getTime()) / 86_400_000);
    const sign = days >= 0 ? "+" : "−";
    return {
      primary: `Δ ${sign}${Math.abs(days)}d`,
      secondary: dateB > dateA ? "Source B later" : "Source A later",
      warning: Math.abs(days) > 7,
    };
  }

  // Semantic string
  return {
    primary: semanticStringDiff(a, b),
    secondary: undefined,
    warning: false,
  };
}

/**
 * Which side of the diff is "wrong" given the AI verdict — drives the
 * coral color treatment on the value cell. For Escalate, neither side is
 * red because the model isn't confident enough to call one wrong.
 */
function deviatingSide(verdict: Verdict): "A" | "B" | null {
  if (verdict === "Reject") return "B";
  if (verdict === "Accept") return "A";
  return null;
}

/**
 * Compute a delta string for the variant card's audit-right slot.
 * Returns a numeric delta when both values are parseable as the same
 * currency, otherwise returns null and the caller falls back to a
 * generic source label.
 */
function quickDelta(a: string, b: string): string | null {
  const numA = parseAmount(a);
  const numB = parseAmount(b);
  if (numA && numB && numA.currency === numB.currency) {
    const delta = numB.num - numA.num;
    const pct = (delta / numA.num) * 100;
    const sign = delta >= 0 ? "+" : "−";
    const formatted = Math.abs(delta).toLocaleString("en-US", {
      maximumFractionDigits: 0,
    });
    return `Δ ${sign}${numA.currency} ${formatted} · ${sign}${Math.abs(pct).toFixed(1)}%`;
  }
  return null;
}

/**
 * Map the selected ConflictItem to the SourceCardData pair the
 * ConflictSourceCards component renders. Pulls real values from the
 * conflict's first conflicting field + its two evidence records, so
 * each conflict in the queue shows its own source pair instead of a
 * single hardcoded example.
 */
function deriveSourceCards(item: ConflictItem) {
  const field = item.conflicts[0];
  const evA = item.evidence[0];
  const evB = item.evidence[1];

  const additional = item.conflicts.length - 1;
  const sectionLabel = additional > 0
    ? `Conflict · ${field.label.toLowerCase()} (+${additional} more field${additional > 1 ? "s" : ""} differ)`
    : `Conflict · ${field.label.toLowerCase()}`;

  const variantAuditRight =
    quickDelta(field.sourceA.value, field.sourceB.value) ??
    `from ${evB.uploader}`;

  const metaA = [
    evA.date,
    `${evA.pages}pp`,
    `from ${evA.uploader}`,
    evA.party,
  ].filter((s): s is string => Boolean(s) && s !== "—");
  const metaB = [
    evB.date,
    `${evB.pages}pp`,
    `from ${evB.uploader}`,
    evB.party,
  ].filter((s): s is string => Boolean(s) && s !== "—");

  return {
    sectionLabel,
    anchor: {
      doc_name: evA.filename,
      doc_url: "#",
      metadata: metaA,
      field: field.label,
      value: field.sourceA.value,
      snippet_loc: `record · ${evA.uploader}`,
      snippet_link: "#",
      snippet_text: evA.quote,
      highlight: evA.highlight || field.sourceA.value,
      audit_left: evA.date && evA.date !== "—" ? `ingested ${evA.date}` : "ingested —",
      audit_right: evA.uploader || "system",
    },
    variant: {
      doc_name: evB.filename,
      doc_url: "#",
      metadata: metaB,
      field: field.label,
      value: field.sourceB.value,
      snippet_loc: `record · ${evB.uploader}`,
      snippet_link: "#",
      snippet_text: evB.quote,
      highlight: evB.highlight || field.sourceB.value,
      audit_left: evB.date && evB.date !== "—" ? `ingested ${evB.date}` : "ingested —",
      audit_right: variantAuditRight,
    },
  };
}

export default function Review() {
  const navigate = useNavigate();

  // Backend-driven queue. Falls back to an empty list while loading.
  const { data: backendConflicts, isLoading, isError, error, refetch } = useConflicts();
  const conflicts: ConflictItem[] = backendConflicts ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState<number>(QUEUE_STATS.reviewed);
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [showMatching, setShowMatching] = useState<boolean>(false);

  // Auto-select the first item once the queue arrives.
  useEffect(() => {
    if (!selectedId && conflicts.length > 0) {
      setSelectedId(conflicts[0].id);
    }
  }, [conflicts, selectedId]);

  const selectedIndex = Math.max(
    0,
    conflicts.findIndex((c) => c.id === selectedId)
  );
  const item: ConflictItem | null = conflicts[selectedIndex] ?? null;

  const navigatingRef = useRef(false);

  const navigateToLens = (verdict: Verdict) => {
    if (!item) return;
    navigate("/lens", {
      state: {
        conflictId: item.id,
        verdict,
        confidence: item.confidence,
        focusId: item.lensFocusId,
        timestamp: Date.now(),
      },
    });
  };

  const handleSkip = () => {
    if (navigatingRef.current || conflicts.length === 0) return;
    toast("Skipped");
    const next = (selectedIndex + 1) % conflicts.length;
    setSelectedId(conflicts[next].id);
    setShowMatching(false);
  };

  const handleConfirm = () => {
    if (navigatingRef.current || !item) return;
    navigatingRef.current = true;
    toast(`Verdict confirmed: ${item.verdict}`);
    setReviewedCount((c) => c + 1);
    setConfirmedIds((s) => new Set(s).add(item.id));
    setTimeout(() => navigateToLens(item.verdict), 600);
  };

  const handleOverride = () => {
    if (navigatingRef.current || !item) return;
    const overridden = VERDICT_OVERRIDE[item.verdict];
    navigatingRef.current = true;
    toast(`Overridden: ${overridden} (was ${item.verdict})`);
    setReviewedCount((c) => c + 1);
    setConfirmedIds((s) => new Set(s).add(item.id));
    setTimeout(() => navigateToLens(overridden), 600);
  };

  // Keyboard shortcuts — A confirm, S skip, J/K navigate. Ignore in inputs.
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return false;
      return tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || conflicts.length === 0) return;
      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        handleSkip();
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        setSelectedId(conflicts[(selectedIndex + 1) % conflicts.length].id);
        setShowMatching(false);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setSelectedId(
          conflicts[(selectedIndex - 1 + conflicts.length) % conflicts.length].id
        );
        setShowMatching(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIndex, item, conflicts]); // eslint-disable-line react-hooks/exhaustive-deps

  const headerTypeTag = useMemo(
    () => (item?.conflicts[0] ? typeTagFor(item.conflicts[0]) : "FIELD MISMATCH"),
    [item]
  );
  const context = useMemo(() => (item ? extractContext(item.title) : ""), [item]);
  const matched = useMemo(() => (item ? matchingFieldNames(item) : []), [item]);
  const deviating = item ? deviatingSide(item.verdict) : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
      {/* ---------------- HEADER (unchanged per spec) ---------------- */}
      <header className="shrink-0 border-b border-hairline bg-bg relative">
        <div className="flex items-center px-5 py-3">
          <div className="flex items-center gap-3 flex-1">
            <span className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-coral/30 border border-coral/60" />
            <Breadcrumb segments={["qontext", "review", "conflicts"]} />
            <span className="ml-3 text-ink-faint text-meta hidden md:inline">
              Open sidebar <Kbd>Ctrl B</Kbd>
            </span>
          </div>
          <div className="text-center">
            <div className="text-meta text-ink">
              {reviewedCount} / {conflicts.length} reviewed
            </div>
            <div className="text-micro text-ink-faint mt-0.5">
              {isLoading ? "loading queue from backend…" : `${conflicts.length} pending review`}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-1 justify-end">
            <div className="flex items-center gap-1 surface-card px-1 py-1">
              <button className="px-3 py-1 text-meta text-ink bg-surface-2 rounded-sm">
                ⊞ Review
              </button>
              <button
                className="px-3 py-1 text-meta text-ink-muted hover:text-ink rounded-sm"
                onClick={() =>
                  toast("Confirm a verdict to open the Lens", {
                    description: "Press A on any conflict",
                  })
                }
              >
                ◎ Lens
              </button>
            </div>
            <AvatarChip initials="JM" />
          </div>
        </div>
      </header>

      {/* ---------------- BODY ---------------- */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar (unchanged per spec) */}
        <aside className="w-[300px] shrink-0 flex flex-col border-r border-hairline bg-bg">
          <div className="px-5 py-4 border-b border-hairline shrink-0">
            <div className="flex items-baseline justify-between">
              <span className="text-micro text-ink-faint">Queue</span>
              <span className="text-meta text-ink-muted">{conflicts.length} open</span>
            </div>
            <div className="text-micro text-ink-faint mt-1.5 normal-case tracking-normal">
              {isLoading
                ? "loading from backend…"
                : isError
                ? "backend offline — check api/server.py"
                : `Avg resolution ${QUEUE_STATS.avgResolutionSeconds}s · saving ${QUEUE_STATS.agentHoursSavedToday} agent-hours today`}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {isError && (
              <div className="px-5 py-6 text-meta text-coral">
                Failed to load conflicts: {String((error as Error)?.message ?? "unknown error")}
                <button
                  onClick={() => refetch()}
                  className="block mt-2 text-ink-muted underline hover:text-ink"
                >
                  retry
                </button>
              </div>
            )}
            {isLoading && conflicts.length === 0 && (
              <div className="px-5 py-6 inline-flex items-center gap-2 text-meta text-ink-faint">
                <Loader2 className="w-3 h-3 animate-spin" /> loading queue…
              </div>
            )}
            {!isLoading && !isError && conflicts.length === 0 && (
              <div className="px-5 py-6 text-meta text-ink-faint">
                No conflicts in the queue. Run the ingestion pipeline against
                a dataset to populate it.
              </div>
            )}
            {conflicts.map((c) => {
              const isActive = c.id === item.id;
              const isConfirmed = confirmedIds.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    setSelectedId(c.id);
                    setShowMatching(false);
                  }}
                  className={[
                    "w-full text-left px-5 py-4 border-b border-hairline transition-colors",
                    isActive
                      ? "bg-surface border-l-2 border-l-coral pl-[18px]"
                      : "hover:bg-surface",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-meta text-ink">{c.id}</span>
                    <SeverityBadge sev={c.severity} />
                  </div>
                  <div className="mt-2 text-meta text-ink leading-snug line-clamp-2 font-medium">
                    {c.title}
                  </div>
                  <div className="mt-1 text-meta text-ink-muted">
                    {c.parties[0]} ⇌ {c.parties[1]}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-micro text-ink-faint normal-case tracking-normal">
                      <span
                        className={[
                          "w-1.5 h-1.5 rounded-full",
                          c.pausedAgentsCount > 0 ? "bg-amber" : "bg-hairline",
                        ].join(" ")}
                      />
                      {c.pausedAgentsCount} agents paused
                    </span>
                    <span className="text-micro text-ink-faint normal-case tracking-normal">
                      {isConfirmed ? <span className="text-mint">✓ reviewed</span> : c.ageLabel}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ===================================================== */}
        {/* DETAIL PANE — rebuilt: diff is the hero                */}
        {/* ===================================================== */}
        <main className="flex-1 min-w-0 overflow-y-auto px-12 py-8 space-y-12">
          {!item && (
            <div className="h-full flex items-center justify-center text-ink-faint text-meta">
              {isLoading
                ? "loading conflict from backend…"
                : isError
                ? "Could not reach the backend. Start it with `python api/server.py --graph <file>` and refresh."
                : "Select a conflict from the queue."}
            </div>
          )}
          {item && (<>
          {/* [1] Compact header */}
          <section className="flex items-start justify-between gap-6">
            <div className="space-y-2">
              <div className="text-micro text-ink-faint flex items-center gap-3">
                <span className="text-ink-muted">{item.id}</span>
                <span>·</span>
                <SeverityBadge sev={item.severity} />
                <span>·</span>
                <span className="text-ink">{headerTypeTag}</span>
              </div>
              <div className="text-h1 text-ink">
                {item.parties[0]} <span className="text-ink-faint mx-1">⇌</span>{" "}
                {item.parties[1]}
                {context && (
                  <span className="text-ink-faint text-meta ml-3">· {context}</span>
                )}
              </div>
            </div>
            <div className="surface-card px-3 py-1.5 text-meta text-ink-muted shrink-0">
              {item.similarStat}
            </div>
          </section>

          {/* BLOCKED WORKFLOWS — kept above the cards per mockup order */}
          <section>
            <div className="text-micro text-ink-faint">BLOCKED WORKFLOWS</div>
            <div className="mt-3 space-y-1">
              {item.pausedAgents.length === 0 ? (
                <div className="text-meta text-ink-faint">
                  No agents currently blocked on this conflict.
                </div>
              ) : (
                item.pausedAgents.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between py-1"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber" />
                      <span className="text-meta text-ink">{a.id}</span>
                      <span className="text-meta text-ink-muted">{a.task}</span>
                    </div>
                    <span className="text-micro text-ink-faint normal-case tracking-normal">
                      paused {a.pausedFor}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="mt-3 text-meta text-ink-muted">{item.unblockSummary}</div>
          </section>

          {/* SOURCE CARDS — derived live from the selected ConflictItem.
              Anchor = item.evidence[0] + conflicts[0].sourceA.
              Variant = item.evidence[1] + conflicts[0].sourceB.
              The variant card's audit-right shows a numeric Δ when both
              values are parseable as the same currency, otherwise the
              source system. */}
          {(() => {
            const cards = deriveSourceCards(item);
            return (
              <ConflictSourceCards
                sectionLabel={cards.sectionLabel}
                anchor={cards.anchor}
                variant={cards.variant}
              />
            );
          })()}

          {/* === REMOVED below — replaced by ConflictSourceCards === */}
          <section style={{ display: "none" }}>
            <div className="text-micro text-ink-faint mb-5">CONFLICT</div>
            <div className="space-y-10">
              {item.conflicts.map((field, idx) => {
                const diff = computeDiff(field);
                const evA = item.evidence[0];
                const evB = item.evidence[1];
                const labelA = evA.filename.replace(/\.[^.]+$/, "");
                const labelB = evB.filename.replace(/\.[^.]+$/, "");

                const valueColorA =
                  deviating === "A" ? "text-coral" : "text-ink";
                const valueColorB =
                  deviating === "B" ? "text-coral" : "text-ink";

                return (
                  <div key={field.label}>
                    <div className="text-micro text-ink-faint mb-4">{field.label}</div>

                    <div className="grid grid-cols-[1fr_auto_1fr] gap-8 items-center">
                      {/* LEFT — Source A */}
                      <div className="text-right">
                        <div className="text-micro text-ink-faint normal-case tracking-normal">
                          {labelA} · {evA.pages}pp
                        </div>
                        <div className="text-micro text-ink-faint normal-case tracking-normal mt-0.5">
                          {evA.date}
                        </div>
                        <div className={`text-h1 mt-3 ${valueColorA} font-mono`}>
                          {field.sourceA.value}
                        </div>
                      </div>

                      {/* CENTER — delta */}
                      <div className="flex items-center gap-3 text-amber min-w-[260px] justify-center">
                        <span className="text-ink-faint text-meta">→</span>
                        <div className="text-center">
                          <div
                            className={
                              "font-mono whitespace-nowrap " +
                              (diff.primary.startsWith("Δ")
                                ? "text-[36px] leading-none font-medium"
                                : "text-meta")
                            }
                          >
                            {diff.primary}
                          </div>
                          {diff.secondary && (
                            <div
                              className={`text-micro mt-2 normal-case tracking-normal ${
                                diff.warning ? "text-coral" : "text-amber"
                              }`}
                            >
                              {diff.secondary}
                            </div>
                          )}
                        </div>
                        <span className="text-ink-faint text-meta">→</span>
                      </div>

                      {/* RIGHT — Source B */}
                      <div className="text-left">
                        <div className="text-micro text-ink-faint normal-case tracking-normal">
                          {labelB} · {evB.pages}pp
                        </div>
                        <div className="text-micro text-ink-faint normal-case tracking-normal mt-0.5">
                          {evB.date}
                        </div>
                        <div className={`text-h1 mt-3 ${valueColorB} font-mono`}>
                          {field.sourceB.value}
                        </div>
                      </div>
                    </div>

                    {idx < item.conflicts.length - 1 && (
                      <div className="border-t border-hairline mt-8" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Matching fields — collapsed by default */}
            <button
              onClick={() => setShowMatching((v) => !v)}
              className="mt-8 inline-flex items-center gap-2 text-meta text-ink-muted hover:text-ink"
            >
              {showMatching ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <span className="text-mint">✓</span>
              {matched.slice(0, Math.min(3, matched.length)).join(" · ")}
              {matched.length > 3 && (
                <span className="text-ink-faint">
                  · {matched.length - 3} more match
                </span>
              )}
              {matched.length <= 3 && matched.length > 0 && (
                <span className="text-ink-faint">match</span>
              )}
            </button>
            {showMatching && (
              <ul className="mt-3 ml-5 text-meta text-ink-faint space-y-1">
                {matched.map((m) => (
                  <li key={m}>· {m}: identical across both sources</li>
                ))}
              </ul>
            )}
          </section>
          {/* === END removed sections === */}

          <div className="h-2" />
          </>)}
        </main>
      </div>

      {/* ---------------- FOOTER (action bar) ---------------- */}
      <footer className="shrink-0 border-t border-hairline bg-bg px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-5 text-meta text-ink-faint">
          <span className="inline-flex items-center gap-2"><Kbd>A</Kbd> confirm</span>
          <span>·</span>
          <span className="inline-flex items-center gap-2"><Kbd>S</Kbd> skip</span>
          <span>·</span>
          <span className="inline-flex items-center gap-2"><Kbd>J/K</Kbd> navigate</span>
        </div>
        <div className="flex items-center gap-5">
          {item && (
            <button
              onClick={handleOverride}
              className="cta-ghost"
              title={`Disagree with the AI and confirm ${VERDICT_OVERRIDE[item.verdict]} instead`}
            >
              Override → {VERDICT_OVERRIDE[item.verdict]}
            </button>
          )}
          <DSButton variant="secondary" onClick={handleSkip} disabled={!item}>Skip</DSButton>
          <DSButton variant="primary" onClick={handleConfirm} disabled={!item}>
            Confirm {item?.verdict ?? "—"} <ArrowRight className="w-3.5 h-3.5" />
          </DSButton>
        </div>
      </footer>
    </div>
  );
}

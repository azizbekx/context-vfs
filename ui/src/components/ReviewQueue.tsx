import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  FileText,
  RefreshCw,
  X,
  Save,
  Sparkles,
} from 'lucide-react';
import { fetchReviews, resolveReview, fetchFactSources, fetchEntity } from '../api';

/**
 * Dedicated Review Queue page. Renders one row per open review_items
 * record, with a 2-column source-card detail per selected review.
 * Drives /reviews and /reviews/{id}/resolve only — no other endpoints.
 *
 * Schema (from context_base/storage.py + context_base/ingest.py):
 *   review_items: id, entity_id, conflict_type, predicate,
 *                 candidates_json, suggested_resolution, status,
 *                 created_at, resolved_at, resolution
 *   candidate    : { choice_id, fact_id, value, confidence,
 *                    source: "<dataset_path>#<record_id>" }
 *
 * Visual style follows the existing ui/ design system (light theme,
 * Inter body / JetBrains Mono mono, --accent teal anchor, --warning
 * amber variant) — see .rq-* block in src/index.css. The source-detail
 * drawer reuses the existing .source-panel class shared with App.tsx.
 */

interface Candidate {
  choice_id: string;
  fact_id?: string | null;
  value?: string;
  object_entity_id?: string;
  confidence?: number;
  /** Format: "<dataset_path>#<record_id>" (see ingest.py l.730) */
  source?: string;
  snippet?: string;
}

interface ReviewItem {
  id: string;
  entity_id: string;
  conflict_type: string;
  predicate: string;
  candidates_json: string;
  suggested_resolution?: string | null;
  status: string;
  created_at: string;
  resolved_at?: string | null;
  resolution?: string | null;
}

interface ReviewQueueProps {
  /** Optional: handler to switch to the Browser view and open an entity.
   *  When omitted, the entity_id heading renders as plain text. */
  onNavigateToEntity?: (entityId: string) => void;
}

/* ──────────────────────────────────────────────────────────────────── */
/* Helpers                                                               */
/* ──────────────────────────────────────────────────────────────────── */

function parseCandidates(raw: string): Candidate[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

interface ParsedSource {
  datasetPath: string;
  recordId: string | null;
  raw: string;
}

/** "Human_Resource_Management/Employees#emp_42" → split. */
function parseSource(source?: string): ParsedSource | null {
  if (!source) return null;
  const idx = source.indexOf('#');
  if (idx < 0) return { datasetPath: source, recordId: null, raw: source };
  return {
    datasetPath: source.slice(0, idx),
    recordId: source.slice(idx + 1),
    raw: source,
  };
}

function formatTimestamp(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function reviewVfsPath(reviewId: string): string {
  // Mirrors context_base/vfs.py l.97
  return `company/reviews/conflicts/${reviewId.replace(/:/g, '-')}.md`;
}

/**
 * For synthesized candidates that don't have a fact_id of their own
 * (e.g. ingest.py l.875 "investigate-resume" choice), fall back to
 * any fact on the same entity that was extracted from the same source
 * row. That fact's fact_id gives us a way to pull the dataset's
 * raw_json so the variant card can show the same preview as the anchor.
 */
function resolveFactIdFromSource(
  source: string | undefined,
  entityFacts: any[] | undefined
): string | null {
  if (!source || !entityFacts) return null;
  const idx = source.indexOf('#');
  if (idx < 0) return null;
  const path = source.slice(0, idx);
  const recordId = source.slice(idx + 1);
  const match = entityFacts.find(
    (f) => f.dataset_path === path && f.record_id === recordId && f.id
  );
  return match?.id ?? null;
}

/* ──────────────────────────────────────────────────────────────────── */
/* Top-level component                                                   */
/* ──────────────────────────────────────────────────────────────────── */

export default function ReviewQueue({ onNavigateToEntity }: ReviewQueueProps) {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [sourcePanel, setSourcePanel] = useState<unknown | null>(null);
  const [sourcePanelLoading, setSourcePanelLoading] = useState(false);

  // Lazy caches keyed by id so re-selecting hits the cache.
  // - entityCache: /entities/{id} payload (entity + facts + edges).
  //   Not displayed in the UI — used internally to resolve a fallback
  //   fact_id for synthesized candidates that have no fact_id of their own.
  // - factSourceCache: /facts/{id}/sources `fact` objects, each carrying
  //   the raw_json column from the dataset row that produced the value.
  const [entityCache, setEntityCache] = useState<Record<string, any>>({});
  const [factSourceCache, setFactSourceCache] = useState<Record<string, any>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchReviews();
      const open = (data?.reviews ?? []).filter(
        (r: ReviewItem) => r.status === 'open'
      );
      setReviews(open);
      setSelectedId((prev) => prev ?? open[0]?.id ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load reviews from /api/reviews.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedIndex = useMemo(
    () => reviews.findIndex((r) => r.id === selectedId),
    [reviews, selectedId]
  );
  const selected = selectedIndex >= 0 ? reviews[selectedIndex] : null;

  const advanceSelection = useCallback(() => {
    if (reviews.length === 0) return;
    const next = (selectedIndex + 1) % reviews.length;
    setSelectedId(reviews[next].id);
  }, [reviews, selectedIndex]);

  const handleResolve = useCallback(
    async (reviewId: string, choiceId: string) => {
      if (resolving) return;
      setResolving(true);
      setError(null);
      try {
        await resolveReview(reviewId, choiceId);
        setReviewedIds((s) => new Set(s).add(reviewId));
        const filtered = reviews.filter((r) => r.id !== reviewId);
        setReviews(filtered);
        const wasSelected = reviewId === selectedId;
        setSelectedId(
          wasSelected
            ? filtered[Math.min(selectedIndex, filtered.length - 1)]?.id ?? null
            : selectedId
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not resolve review.'
        );
      } finally {
        setResolving(false);
      }
    },
    [resolving, reviews, selectedId, selectedIndex]
  );

  const openFactSource = useCallback(async (factId: string) => {
    setSourcePanelLoading(true);
    setError(null);
    try {
      const data = await fetchFactSources(factId);
      // App.tsx uses data.fact for the inspector — fall back to the full
      // payload so we surface whatever the backend returned.
      setSourcePanel(data?.fact ?? data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not fetch source record.'
      );
    } finally {
      setSourcePanelLoading(false);
    }
  }, []);

  // Keyboard: J/K navigate, A confirm top, S skip.
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      return (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || reviews.length === 0) return;
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        const next = (selectedIndex + 1) % reviews.length;
        setSelectedId(reviews[next].id);
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const prev = (selectedIndex - 1 + reviews.length) % reviews.length;
        setSelectedId(reviews[prev].id);
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        advanceSelection();
      } else if ((e.key === 'a' || e.key === 'A') && selected) {
        const cands = parseCandidates(selected.candidates_json);
        const top = [...cands].sort(
          (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)
        )[0];
        if (top) handleResolve(selected.id, top.choice_id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviews, selectedIndex, selected, advanceSelection, handleResolve]);

  // Two-stage prefetch on review selection:
  //   1. Fetch the entity (silently, used only to resolve fallback fact_ids
  //      for synthesized candidates).
  //   2. For each candidate — using the candidate's own fact_id when present,
  //      or a fact_id from entity.facts matching the same dataset_path +
  //      record_id when not — fetch /facts/{id}/sources so SourcePreview
  //      can render the raw row from the dataset.
  // Fire-and-forget; any failure just leaves the cache empty and the
  // per-card preview shows its "loading" placeholder until the fetch lands.
  useEffect(() => {
    if (!selected) return;
    const eid = selected.entity_id;
    if (!entityCache[eid]) {
      fetchEntity(eid)
        .then((data: any) => setEntityCache((c) => ({ ...c, [eid]: data })))
        .catch(() => undefined);
      return;
    }
    const entity = entityCache[eid];
    const cands = parseCandidates(selected.candidates_json);
    cands.forEach((c) => {
      const factId = c.fact_id ?? resolveFactIdFromSource(c.source, entity?.facts);
      if (factId && !factSourceCache[factId]) {
        fetchFactSources(factId)
          .then((data: any) =>
            setFactSourceCache((cache) => ({
              ...cache,
              [factId]: data?.fact ?? data,
            }))
          )
          .catch(() => undefined);
      }
    });
  }, [selected, entityCache, factSourceCache]);

  return (
    <div className="rq-shell">
      {/* QUEUE SIDEBAR */}
      <aside className="rq-queue">
        <div className="rq-queue-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>Review Queue</div>
            <div className="rq-queue-stats">
              <span className="rq-stat-pill">{reviews.length} remaining</span>
              {reviewedIds.size > 0 && (
                <span className="rq-stat-pill rq-stat-resolved">{reviewedIds.size} resolved</span>
              )}
            </div>
          </div>
          <button
            className="btn-icon"
            onClick={refresh}
            title="Refresh queue"
            disabled={loading}
          >
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="rq-queue-list">
          {loading && reviews.length === 0 && (
            <div className="rq-queue-empty">Loading reviews…</div>
          )}
          {!loading && reviews.length === 0 && !error && (
            <div className="rq-queue-empty">
              No open reviews. Run the ingestion pipeline to populate the queue.
            </div>
          )}
          {reviews.map((r) => {
            const cands = parseCandidates(r.candidates_json);
            const isActive = r.id === selectedId;
            const wasReviewed = reviewedIds.has(r.id);
            return (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`rq-queue-item${isActive ? ' is-active' : ''}`}
              >
                <div className="rq-queue-row">
                  <span className="rq-queue-id">{r.id.slice(0, 16)}</span>
                  <span className="rq-conflict-type">
                    {r.conflict_type.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="rq-queue-pred">{r.predicate}</div>
                <div className="rq-queue-row">
                  <span className="rq-queue-entity">{r.entity_id}</span>
                  <span className="rq-queue-meta">
                    {wasReviewed ? '✓ resolved' : `${cands.length} candidates`}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* DETAIL */}
      <main className="rq-detail">
        {error && (
          <div className="rq-error">
            <AlertTriangle size={14} />
            <span>{error}</span>
            <button className="btn-icon" onClick={() => setError(null)}>
              <X size={13} />
            </button>
          </div>
        )}

        {!selected && !error && !loading && (
          <div className="rq-empty">
            <p>Select a review on the left to inspect candidates and resolve.</p>
          </div>
        )}

        {selected && (
          <ReviewDetail
            review={selected}
            resolving={resolving}
            onResolve={handleResolve}
            onOpenFactSource={openFactSource}
            onNavigateToEntity={onNavigateToEntity}
            factSources={factSourceCache}
            entityFacts={entityCache[selected.entity_id]?.facts}
          />
        )}
      </main>

      {/* SHARED .source-panel drawer (same class as App.tsx fact-source panel) */}
      {(sourcePanel || sourcePanelLoading) && (
        <div className="source-panel">
          <header>
            <h3>Source record</h3>
            <button className="btn-sm" onClick={() => setSourcePanel(null)}>
              <X size={13} />
            </button>
          </header>
          {sourcePanelLoading ? (
            <div style={{ padding: 12, fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
          ) : (
            <pre>{JSON.stringify(sourcePanel, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Detail panel                                                          */
/* ──────────────────────────────────────────────────────────────────── */

function ReviewDetail({
  review,
  resolving,
  onResolve,
  onOpenFactSource,
  onNavigateToEntity,
  factSources,
  entityFacts,
}: {
  review: ReviewItem;
  resolving: boolean;
  onResolve: (reviewId: string, choiceId: string) => void;
  onOpenFactSource: (factId: string) => void;
  onNavigateToEntity?: (entityId: string) => void;
  factSources: Record<string, any>;
  entityFacts?: any[];
}) {
  const candidates = useMemo(
    () => parseCandidates(review.candidates_json),
    [review.candidates_json]
  );
  const sorted = useMemo(
    () => [...candidates].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)),
    [candidates]
  );
  const anchor = sorted[0];
  const variant = sorted[1];
  const others = sorted.slice(2);

  const reviewVfs = reviewVfsPath(review.id);

  return (
    <div className="rq-detail-inner">
      <header className="rq-detail-header">
        <div className="rq-detail-meta">
          <span className="rq-conflict-type-strong">
            {review.conflict_type.replace(/_/g, ' ')}
          </span>
          <span className="rq-meta-sep">·</span>
          <span className="rq-pred-tag">{review.predicate}</span>
          <span className="rq-meta-sep">·</span>
          <span>created {formatTimestamp(review.created_at)}</span>
        </div>

        <h2 className="rq-detail-entity">
          {onNavigateToEntity ? (
            <button
              className="rq-entity-link"
              onClick={() => onNavigateToEntity(review.entity_id)}
              title="Open this entity in the Context Browser"
            >
              {review.entity_id}
              <ExternalLink size={13} />
            </button>
          ) : (
            review.entity_id
          )}
        </h2>

        <div className="rq-vfs-refs">
          <span className="rq-vfs-ref-label">VFS</span>
          <code className="rq-vfs-path">{reviewVfs}</code>
        </div>

        {review.suggested_resolution && (
          <div className="rq-suggestion">
            <div className="rq-suggestion-icon"><Sparkles size={15} /></div>
            <div>
              <div className="rq-suggestion-label">AI Suggestion</div>
              <div className="rq-suggestion-text">{review.suggested_resolution}</div>
            </div>
          </div>
        )}
      </header>

      {/* Inline diff bar — one-liner, only when both sides parse as same numeric */}
      <InlineDiffBar a={anchor?.value} b={variant?.value} predicate={review.predicate} />

      {/* Cards are the hero — section label removed so they sit immediately
          under the header. Per the latest brief: "die zwei kacheln oben". */}

      {(() => {
        // Resolve effective fact_ids + factSources up here so we can compute
        // a shared keyOrder across both raw_jsons → "Age" lines up on both
        // cards at the same vertical row, "Email" lines up too, etc.
        const anchorFactId = anchor
          ? anchor.fact_id ?? resolveFactIdFromSource(anchor.source, entityFacts)
          : null;
        const variantFactId = variant
          ? variant.fact_id ?? resolveFactIdFromSource(variant.source, entityFacts)
          : null;
        const anchorFactSource = anchorFactId ? factSources[anchorFactId] : undefined;
        const variantFactSource = variantFactId ? factSources[variantFactId] : undefined;
        const sharedKeyOrder = computeSharedKeyOrder(
          parseRawJson(anchorFactSource?.raw_json),
          parseRawJson(variantFactSource?.raw_json),
          review.predicate
        );

        return (
          <div className="rq-cards-grid">
            {anchor && (
              <SourceCard
                candidate={anchor}
                role="anchor"
                predicate={review.predicate}
                disabled={resolving}
                onAccept={() => onResolve(review.id, anchor.choice_id)}
                onOpenFactSource={onOpenFactSource}
                effectiveFactId={anchorFactId}
                factSources={factSources}
                keyOrder={sharedKeyOrder}
              />
            )}
            {variant && (
              <SourceCard
                candidate={variant}
                role="variant"
                predicate={review.predicate}
                disabled={resolving}
                onAccept={() => onResolve(review.id, variant.choice_id)}
                onOpenFactSource={onOpenFactSource}
                effectiveFactId={variantFactId}
                factSources={factSources}
                keyOrder={sharedKeyOrder}
              />
            )}
            {!anchor && !variant && (
              <div className="rq-empty">No candidates attached to this review.</div>
            )}
          </div>
        );
      })()}

      {others.length > 0 && (
        <>
          <div className="rq-section-label">Additional candidates</div>
          <div className="rq-others-list">
            {others.map((c) => {
              const src = parseSource(c.source);
              return (
                <div key={c.choice_id} className="rq-other-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rq-other-value">
                      {c.value || c.object_entity_id || '—'}
                    </div>
                    <div className="rq-other-meta">
                      {src ? (
                        <>
                          <code className="rq-vfs-path-inline">{src.datasetPath}</code>
                          {src.recordId && (
                            <span className="rq-record-pill">{src.recordId}</span>
                          )}
                          <span className="rq-meta-sep">·</span>
                        </>
                      ) : null}
                      {Math.round((c.confidence ?? 0) * 100)}% confidence
                      {c.fact_id && (
                        <>
                          <span className="rq-meta-sep">·</span>
                          <button
                            className="rq-link-btn"
                            onClick={() => onOpenFactSource(c.fact_id as string)}
                          >
                            view source record
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn-sm"
                    disabled={resolving}
                    onClick={() => onResolve(review.id, c.choice_id)}
                  >
                    Accept
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Source card — anchor (highest confidence) vs variant (second)        */
/* ──────────────────────────────────────────────────────────────────── */

function SourceCard({
  candidate,
  role,
  predicate,
  disabled,
  onAccept,
  onOpenFactSource,
  effectiveFactId,
  factSources,
  keyOrder,
}: {
  candidate: Candidate;
  role: 'anchor' | 'variant';
  predicate: string;
  disabled: boolean;
  onAccept: () => void;
  onOpenFactSource: (factId: string) => void;
  /** The fact_id we should use to fetch the source record. Either the
   *  candidate's own fact_id or, when synthesized, a fallback from
   *  entity.facts matching the same dataset_path + record_id. */
  effectiveFactId: string | null;
  factSources: Record<string, any>;
  /** Shared key order computed across both cards' raw_jsons so the same
   *  field name appears at the same vertical row in both grids. */
  keyOrder: string[];
}) {
  const confidence = Math.round((candidate.confidence ?? 0) * 100);
  const value = candidate.value || candidate.object_entity_id || '—';
  const src = parseSource(candidate.source);
  const factSource = effectiveFactId ? factSources[effectiveFactId] : undefined;
  const ingestedAt = factSource?.updated_at as string | undefined;

  return (
    <div className={`rq-card rq-card--${role}`}>
      <header className="rq-card-header">
        <div className="rq-card-source">
          <FileText size={12} />
          {src ? (
            <>
              <span className="rq-card-source-path" title={src.raw}>
                {src.datasetPath}
              </span>
              {src.recordId && (
                <span className="rq-record-pill">{src.recordId}</span>
              )}
            </>
          ) : (
            <span className="rq-card-source-path">{candidate.choice_id}</span>
          )}
        </div>
        <span className={`rq-role-badge rq-role-${role}`}>
          {role === 'anchor' ? 'Highest confidence' : 'Variant'}
        </span>
      </header>

      <div className="rq-card-body">
        <div className="rq-field-row">
          <span className="rq-field-label">{predicate}</span>
          <span className="rq-confidence">{confidence}%</span>
        </div>

        <div className="rq-value">{value}</div>

        {candidate.snippet && (
          <div className="rq-snippet-wrap">
            <div className="rq-snippet-text">{candidate.snippet}</div>
          </div>
        )}

        {/* File preview — raw_json record fields lazy-loaded via fetchFactSources.
            Rendered for every card that has a source path (anchor with own
            fact_id, variant fallback to a sibling fact on the same source row).
            keyOrder is shared with the other card so rows line up. */}
        {effectiveFactId && (
          <SourcePreview
            factId={effectiveFactId}
            factSource={factSource}
            highlightField={predicate}
            keyOrder={keyOrder}
          />
        )}

        {ingestedAt && (
          <div className="rq-source-ingested">ingested {formatTimestamp(ingestedAt)}</div>
        )}

        <footer className="rq-card-foot">
          <div className="rq-card-foot-meta-col">
            <span className="rq-card-foot-meta">choice_id: {candidate.choice_id}</span>
            {effectiveFactId ? (
              <button
                className="rq-link-btn"
                onClick={() => onOpenFactSource(effectiveFactId)}
                title="Open the underlying source record from the dataset"
              >
                <ExternalLink size={11} /> view source record
              </button>
            ) : src ? (
              <span className="rq-card-foot-meta">no fact on file for this row</span>
            ) : null}
          </div>
          <button
            className={`btn-sm ${role === 'anchor' ? 'btn-primary' : ''}`}
            disabled={disabled}
            onClick={onAccept}
          >
            <Save size={12} /> Accept this value <ChevronRight size={12} />
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Inline diff bar — only shown when both sides parse as same currency  */
/* ──────────────────────────────────────────────────────────────────── */

function parseAmount(s?: string): { num: number; currency: string } | null {
  if (!s) return null;
  const m = s.match(/([A-Z]{2,3}|[€$£¥])\s*([0-9][0-9,.]*)/);
  if (!m) return null;
  const num = parseFloat(m[2].replace(/,/g, ''));
  if (Number.isNaN(num)) return null;
  return { num, currency: m[1] };
}

function InlineDiffBar({
  a,
  b,
  predicate,
}: {
  a?: string;
  b?: string;
  predicate: string;
}) {
  const numA = parseAmount(a);
  const numB = parseAmount(b);
  if (!numA || !numB || numA.currency !== numB.currency) return null;

  const delta = numB.num - numA.num;
  const pct = (delta / numA.num) * 100;
  const sign = delta >= 0 ? '+' : '−';
  const fmt = Math.abs(delta).toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <div className="rq-diff-bar">
      <span className="rq-diff-label">{predicate}</span>
      <span className="rq-diff-old">{a}</span>
      <span className="rq-diff-arrow">→</span>
      <span className="rq-diff-new">{b}</span>
      <span className="rq-diff-pill">
        Δ {sign}{numA.currency} {fmt} · {sign}{Math.abs(pct).toFixed(1)}%
      </span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Source preview — raw_json from the dataset row, lazy-loaded via      */
/* fetchFactSources. Highlights the contested predicate so reviewers   */
/* can see exactly which field came from this row.                      */
/* ──────────────────────────────────────────────────────────────────── */

function parseRawJson(raw?: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Build a single ordered key list shared by both source cards so the same
 * data type ("Age", "Email", …) lines up at the same vertical row in
 * both grids. Order: the contested predicate first, then keys present in
 * BOTH records (preserving anchor order), then anchor-only, then variant-only.
 * Capped to N entries so cards don't grow unbounded.
 */
function computeSharedKeyOrder(
  anchor: Record<string, unknown> | null,
  variant: Record<string, unknown> | null,
  highlightField: string,
  limit = 8
): string[] {
  const aKeys = anchor ? Object.keys(anchor) : [];
  const bKeys = variant ? Object.keys(variant) : [];
  const aSetLower = new Set(aKeys.map((k) => k.toLowerCase()));
  const bSetLower = new Set(bKeys.map((k) => k.toLowerCase()));

  const result: string[] = [];
  const seenLower = new Set<string>();
  const push = (k: string) => {
    const kl = k.toLowerCase();
    if (seenLower.has(kl)) return;
    seenLower.add(kl);
    result.push(k);
  };

  // 1. The contested predicate first (whichever side has it)
  const hl = highlightField.toLowerCase();
  const fromA = aKeys.find((k) => k.toLowerCase() === hl);
  const fromB = bKeys.find((k) => k.toLowerCase() === hl);
  if (fromA) push(fromA);
  else if (fromB) push(fromB);

  // 2. Keys present in both, preserving anchor order
  for (const k of aKeys) {
    if (bSetLower.has(k.toLowerCase())) push(k);
  }
  // 3. Anchor-only
  for (const k of aKeys) push(k);
  // 4. Variant-only
  for (const k of bKeys) {
    if (!aSetLower.has(k.toLowerCase())) push(k);
  }

  return result.slice(0, limit);
}

/** Case-insensitive lookup so "Age" / "age" / "AGE" all collapse. */
function lookupCaseInsensitive(
  obj: Record<string, unknown> | null,
  key: string
): unknown | undefined {
  if (!obj) return undefined;
  const kl = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === kl) return obj[k];
  }
  return undefined;
}

function SourcePreview({
  factId,
  factSource,
  highlightField,
  keyOrder,
}: {
  factId: string;
  factSource?: any;
  highlightField: string;
  /** Shared with the sibling card so rows line up. When the union is
   *  smaller than 1, the preview still renders an empty placeholder grid
   *  so the two cards stay the same height. */
  keyOrder: string[];
}) {
  if (!factSource) {
    return (
      <div className="rq-source-preview">
        <div className="rq-source-preview-head">
          <span>Source record · loading</span>
          <span style={{ fontFamily: 'var(--mono)' }}>{factId.slice(0, 16)}</span>
        </div>
        <div className="rq-source-preview-body">
          <div className="rq-source-preview-loading">fetching raw record from dataset…</div>
        </div>
      </div>
    );
  }

  const raw = parseRawJson(factSource.raw_json);
  const datasetPath = factSource.dataset_path as string | undefined;
  const recordId = factSource.record_id as string | undefined;

  // Use the shared keyOrder so the same fields appear at the same vertical
  // row in both cards. Cells without a value in this card render as "—",
  // keeping row count and alignment identical across the pair.
  const entries: Array<[string, string]> = keyOrder.map((k) => {
    const v = lookupCaseInsensitive(raw, k);
    if (v == null) return [k, '—'];
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const trimmed = text.length > 220 ? text.slice(0, 220) + '…' : text;
    return [k, trimmed];
  });

  return (
    <div className="rq-source-preview">
      <div className="rq-source-preview-head">
        <span>Source record</span>
        <span style={{ fontFamily: 'var(--mono)' }}>
          {datasetPath ?? '—'}{recordId ? ` # ${recordId}` : ''}
        </span>
      </div>
      <div className="rq-source-preview-body">
        {entries.length === 0 ? (
          <div className="rq-source-preview-loading">no parseable raw_json on this record</div>
        ) : (
          <div className="rq-source-preview-grid">
            {entries.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span
                  className="rq-source-preview-key"
                  style={
                    k.toLowerCase() === highlightField.toLowerCase()
                      ? { color: 'var(--warning)' }
                      : undefined
                  }
                >
                  {k}
                </span>
                <span
                  className="rq-source-preview-val"
                  style={
                    k.toLowerCase() === highlightField.toLowerCase()
                      ? { color: 'var(--warning)', fontWeight: 600 }
                      : undefined
                  }
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

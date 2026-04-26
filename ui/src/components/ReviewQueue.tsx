import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  FileText,
  RefreshCw,
  X,
  Save,
} from 'lucide-react';
import { fetchReviews, resolveReview, fetchFactSources } from '../api';

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

  return (
    <div className="rq-shell">
      {/* QUEUE SIDEBAR */}
      <aside className="rq-queue">
        <div className="rq-queue-header">
          <span className="rq-label">Review queue</span>
          <span className="rq-count">{reviews.length} open</span>
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
}: {
  review: ReviewItem;
  resolving: boolean;
  onResolve: (reviewId: string, choiceId: string) => void;
  onOpenFactSource: (factId: string) => void;
  onNavigateToEntity?: (entityId: string) => void;
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
            <span className="rq-label">AI suggestion</span>
            <span>{review.suggested_resolution}</span>
          </div>
        )}
      </header>

      <div className="rq-section-label">
        Conflicting values · {review.predicate}
      </div>

      <div className="rq-cards-grid">
        {anchor && (
          <SourceCard
            candidate={anchor}
            role="anchor"
            predicate={review.predicate}
            disabled={resolving}
            onAccept={() => onResolve(review.id, anchor.choice_id)}
            onOpenFactSource={onOpenFactSource}
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
          />
        )}
        {!anchor && !variant && (
          <div className="rq-empty">No candidates attached to this review.</div>
        )}
      </div>

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
}: {
  candidate: Candidate;
  role: 'anchor' | 'variant';
  predicate: string;
  disabled: boolean;
  onAccept: () => void;
  onOpenFactSource: (factId: string) => void;
}) {
  const confidence = Math.round((candidate.confidence ?? 0) * 100);
  const value = candidate.value || candidate.object_entity_id || '—';
  const src = parseSource(candidate.source);

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

        <footer className="rq-card-foot">
          <div className="rq-card-foot-meta-col">
            <span className="rq-card-foot-meta">choice_id: {candidate.choice_id}</span>
            {candidate.fact_id ? (
              <button
                className="rq-link-btn"
                onClick={() => onOpenFactSource(candidate.fact_id as string)}
                title="Open the underlying source record from the dataset"
              >
                <ExternalLink size={11} /> view source record
              </button>
            ) : src ? (
              <span className="rq-card-foot-meta">no fact_id (synthesized)</span>
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

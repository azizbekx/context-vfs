import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  RefreshCw,
  X,
  Save,
} from 'lucide-react';
import { fetchReviews, resolveReview } from '../api';

/**
 * Dedicated Review Queue page. Renders one row per open review_items
 * record, with a 2-column source-card detail per selected review.
 * Drives /reviews and /reviews/{id}/resolve only — no other endpoints.
 *
 * Schema reminder (from context_base/storage.py):
 *   review_items: id, entity_id, conflict_type, predicate,
 *                 candidates_json, suggested_resolution, status,
 *                 created_at, resolved_at, resolution
 *   candidate    : { choice_id, value, confidence, source_id?, snippet? }
 *
 * Visual style follows the existing ui/ design system (light theme,
 * Inter body / JetBrains Mono mono, --accent teal anchor, --warning
 * amber variant) — see .rq-* block in src/index.css.
 */

interface Candidate {
  choice_id: string;
  value?: string;
  object_entity_id?: string;
  confidence?: number;
  source_id?: string;
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

function parseCandidates(raw: string): Candidate[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
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

export default function ReviewQueue() {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());

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
        // Optimistic: drop it from the local queue and step forward.
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

  // Keyboard navigation: J/K through queue, A confirm top suggestion, S skip.
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
        // Confirm the highest-confidence candidate.
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
          />
        )}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Detail panel                                                          */
/* -------------------------------------------------------------------- */

function ReviewDetail({
  review,
  resolving,
  onResolve,
}: {
  review: ReviewItem;
  resolving: boolean;
  onResolve: (reviewId: string, choiceId: string) => void;
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
        <h2 className="rq-detail-entity">{review.entity_id}</h2>
        {review.suggested_resolution && (
          <div className="rq-suggestion">
            <span className="rq-label">AI suggestion</span>
            <span>{review.suggested_resolution}</span>
          </div>
        )}
      </header>

      <div className="rq-section-label">
        Conflicting values · clause {review.predicate}
      </div>

      <div className="rq-cards-grid">
        {anchor && (
          <SourceCard
            candidate={anchor}
            role="anchor"
            predicate={review.predicate}
            disabled={resolving}
            onAccept={() => onResolve(review.id, anchor.choice_id)}
          />
        )}
        {variant && (
          <SourceCard
            candidate={variant}
            role="variant"
            predicate={review.predicate}
            disabled={resolving}
            onAccept={() => onResolve(review.id, variant.choice_id)}
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
            {others.map((c) => (
              <div key={c.choice_id} className="rq-other-row">
                <div>
                  <div className="rq-other-value">
                    {c.value || c.object_entity_id || '—'}
                  </div>
                  <div className="rq-other-meta">
                    {c.source_id ? `${c.source_id} · ` : ''}
                    {Math.round((c.confidence ?? 0) * 100)}% confidence
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
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Source card — anchor (highest confidence) vs variant (second)        */
/* -------------------------------------------------------------------- */

function SourceCard({
  candidate,
  role,
  predicate,
  disabled,
  onAccept,
}: {
  candidate: Candidate;
  role: 'anchor' | 'variant';
  predicate: string;
  disabled: boolean;
  onAccept: () => void;
}) {
  const confidence = Math.round((candidate.confidence ?? 0) * 100);
  const value = candidate.value || candidate.object_entity_id || '—';
  return (
    <div className={`rq-card rq-card--${role}`}>
      <header className="rq-card-header">
        <div className="rq-card-source">
          <FileText size={12} />
          <span>{candidate.source_id ?? candidate.choice_id}</span>
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
          <span className="rq-card-foot-meta">choice_id: {candidate.choice_id}</span>
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

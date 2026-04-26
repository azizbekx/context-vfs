import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { OBJECTS, SCENARIOS, type ObjectType } from "@/lib/lens-data";
import Graph3D from "@/components/Graph3D";
import { AvatarChip, Breadcrumb, DSButton } from "@/components/ds";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { Verdict } from "@/lib/review-data";

interface LensNavState {
  conflictId: string;
  verdict: Verdict;
  confidence: number;
  focusId: string;
  timestamp: number;
}

const VERDICT_COLOR: Record<Verdict, string> = {
  Reject: "text-coral border-coral",
  Accept: "text-mint border-mint",
  Escalate: "text-amber border-amber",
};

const TYPE_DOT: Record<ObjectType, string> = {
  Shipment: "bg-coral",
  Person: "bg-ink",
  Organization: "bg-ink-muted",
  Vendor: "bg-ink-muted",
  Account: "bg-ink-muted",
  Document: "bg-ink-muted",
  Location: "bg-ink-muted",
  Invoice: "bg-amber",
};

export default function Lens() {
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as LensNavState | null;

  // Hooks must run before any early return.
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);
  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0],
    [scenarioId]
  );
  const initialFocus = navState?.focusId ?? scenario.focusId;
  const [focusId, setFocusId] = useState<string>(initialFocus);
  const [query, setQuery] = useState<string>(scenario.query);

  // Don't reset focusId on the initial mount — only on actual scenario
  // switches. Previously this useEffect overrode the navState.focusId
  // immediately, sending the user to the wrong node.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setFocusId(scenario.focusId);
    setQuery(scenario.query);
  }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (navState) {
      toast(`Lens opened from ${navState.conflictId} · ${navState.verdict}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!navState) {
    return <Navigate to="/" replace />;
  }

  const focusObject =
    OBJECTS[focusId] ?? OBJECTS[scenario.focusId] ?? OBJECTS[SCENARIOS[0].focusId];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
      {/* ---------------- TOP BAR ---------------- */}
      <header className="shrink-0 border-b border-hairline bg-bg">
        <div className="flex items-center px-5 py-3">
          <div className="flex items-center gap-3 flex-1">
            <span className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-coral/30 border border-coral/60" />
            <Breadcrumb segments={["qontext", "lens", scenario.name]} />
          </div>

          <div className="flex items-center gap-6">
            {SCENARIOS.map((s) => {
              const active = s.id === scenarioId;
              return (
                <button
                  key={s.id}
                  onClick={() => setScenarioId(s.id)}
                  className={[
                    "pb-2 text-meta transition-colors",
                    active ? "border-b-2 border-coral text-ink" : "text-ink-muted hover:text-ink",
                  ].join(" ")}
                >
                  {s.name}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 flex-1 justify-end">
            <span
              className={`badge-mono ${VERDICT_COLOR[navState.verdict]}`}
              style={{ borderWidth: 1 }}
            >
              {navState.conflictId} · {navState.verdict}
            </span>
            <DSButton variant="ghost" onClick={() => navigate("/")}>
              <ArrowLeft className="w-3.5 h-3.5" /> back
            </DSButton>
            <AvatarChip initials="JM" />
          </div>
        </div>

        {/* Query row */}
        <div className="flex items-center gap-4 px-5 py-3 border-t border-hairline">
          <span className="text-micro text-ink-faint">QUERY</span>
          <input
            className="input-line flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <DSButton
            variant="primary"
            onClick={() => {
              setFocusId(scenario.focusId);
              toast("Re-running query");
            }}
          >
            Run <ArrowRight className="w-3.5 h-3.5" />
          </DSButton>
        </div>
      </header>

      {/* ---------------- MAIN ---------------- */}
      <main className="relative flex min-h-0 flex-1">
        {/* Graph */}
        <section className="flex-1 min-w-0 relative">
          <div className="absolute top-4 left-4 z-10 text-micro text-ink-faint">
            [LENS] / [{scenario.name.toUpperCase()}] / [FOCUS:{focusId}]
          </div>

          <ErrorBoundary label="3D scene crashed">
            <Graph3D
              focusId={focusId}
              scenarioForeground={scenario.foregroundNodeIds}
              onSelect={setFocusId}
              verdict={navState.verdict}
              conflictId={navState.conflictId}
              focusFromConflict={navState.focusId}
            />
          </ErrorBoundary>

          {/* Results panel */}
          <div className="absolute bottom-5 left-5 w-[300px] z-10">
            <div className="surface-card p-3">
              <div className="text-micro text-ink-faint">[RECENTER ON]</div>
              <div className="mt-3 space-y-1">
                {scenario.results.map((r) => {
                  const active = r.id === focusId;
                  return (
                    <button
                      key={r.id}
                      onClick={() => setFocusId(r.id)}
                      className={[
                        "w-full flex items-center gap-3 py-2 px-2 transition-colors",
                        active ? "border-l-2 border-coral bg-bg pl-[6px]" : "hover:bg-bg",
                      ].join(" ")}
                    >
                      <span className={`w-1.5 h-1.5 rounded-sm ${TYPE_DOT[r.type]}`} />
                      <div className="flex-1 text-left min-w-0">
                        <div className="text-meta text-ink truncate">{r.name}</div>
                        <div className="text-micro text-ink-faint normal-case tracking-normal truncate">
                          {r.reason}
                        </div>
                      </div>
                      <span className="text-micro text-ink-muted normal-case tracking-normal">
                        {Math.round(r.score * 100)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Inspector */}
        <aside className="hidden md:flex w-[360px] shrink-0 flex-col border-l border-hairline bg-bg overflow-hidden">
          <div className="px-5 pt-5 pb-4 border-b border-hairline">
            <div className="text-micro text-ink-faint">
              [{focusObject.type.toUpperCase()}] / [{focusObject.id}]
            </div>
            <h2 className="mt-1 text-[22px] leading-tight font-medium text-ink">
              {focusObject.name}
            </h2>
            <p className="mt-2 text-body text-ink-muted">{focusObject.summary}</p>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
            <section>
              <div className="text-micro text-ink-faint">[PROPERTIES]</div>
              <dl className="mt-3">
                {focusObject.properties.map((p) => (
                  <div
                    key={p.key}
                    className="flex items-center justify-between py-1.5 border-b border-hairline"
                  >
                    <dt className="text-micro text-ink-faint normal-case tracking-normal">{p.key}</dt>
                    <dd className="text-meta text-ink text-right">{p.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <div className="text-micro text-ink-faint">[DIRECT RELATIONS]</div>
              <div className="mt-3 space-y-1">
                {focusObject.relations.map((r) => (
                  <button
                    key={r.targetId}
                    onClick={() => setFocusId(r.targetId)}
                    className="w-full flex items-center justify-between py-2 px-2 hover:border-l-2 hover:border-coral hover:bg-surface transition-colors text-left"
                  >
                    <span className="text-meta text-ink">{r.label}</span>
                    <span className="text-micro text-ink-faint">[{r.kind}]</span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <div className="text-micro text-ink-faint">[PROVENANCE]</div>
              <div className="mt-3 space-y-2">
                {focusObject.provenance.map((p, i) => (
                  <div key={i} className="surface-nested p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-meta text-ink">{p.source}</span>
                      <span className="text-meta text-coral">{Math.round(p.confidence * 100)}%</span>
                    </div>
                    <div className="text-meta text-ink-muted mt-1">{p.detail}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </aside>
      </main>
    </div>
  );
}

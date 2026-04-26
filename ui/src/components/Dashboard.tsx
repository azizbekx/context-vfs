import { useEffect, useState } from 'react';
import { Database, FileText, GitBranch, AlertTriangle, Layers, Hexagon, ShieldCheck, CheckCircle2, Clock, Server } from 'lucide-react';
import { fetchStats } from '../api';

interface Stats {
  entities: number;
  facts: number;
  edges: number;
  sources: number;
  open_reviews: number;
  by_type: Record<string, number>;
  edges_by_type?: Record<string, number>;
}

const BAR_COLORS = [
  '#10B981', '#A78BFA', '#60A5FA', '#4ADE80', '#FCD34D',
  '#F87171', '#38BDF8', '#C084FC', '#FBBF24', '#94A3B8',
];

function BarChart({ data, title }: { data: Record<string, number>; title: string }) {
  const sorted = Object.entries(data).sort(([, a], [, b]) => b - a).slice(0, 12);
  const max = sorted[0]?.[1] ?? 1;
  return (
    <div className="dash-chart-section">
      <h3 className="dash-section-label">{title}</h3>
      <div className="bar-chart">
        {sorted.map(([type, count], i) => (
          <div key={type} className="bar-row">
            <div className="bar-label" title={type}>{type}</div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.max((count / max) * 100, 1.5)}%`,
                  backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                }}
              />
            </div>
            <div className="bar-count">{count.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchStats().then(setStats).catch(() => setError(true));
  }, []);

  if (error) return (
    <div className="dashboard">
      <div className="empty-state">
        <AlertTriangle size={32} />
        <p>Could not load stats. Is the backend running?</p>
      </div>
    </div>
  );

  if (!stats) return (
    <div className="dashboard"><div className="loading-center"><div className="spinner" /></div></div>
  );

  const cards = [
    { label: 'Entities', value: stats.entities, Icon: Database, color: '#10B981', soft: 'rgba(16,185,129,.12)' },
    { label: 'Facts', value: stats.facts, Icon: FileText, color: '#A78BFA', soft: 'rgba(167,139,250,.12)' },
    { label: 'Edges', value: stats.edges, Icon: GitBranch, color: '#60A5FA', soft: 'rgba(96,165,250,.12)' },
    { label: 'Sources', value: stats.sources, Icon: Layers, color: '#4ADE80', soft: 'rgba(74,222,128,.12)' },
    { label: 'Open Reviews', value: stats.open_reviews, Icon: AlertTriangle, color: '#FCD34D', soft: 'rgba(252,211,77,.12)' },
  ];

  const edgesByType = stats.edges_by_type && Object.keys(stats.edges_by_type).length > 0
    ? Object.entries(stats.edges_by_type).sort(([, a], [, b]) => b - a)
    : null;

  const typeEntries = Object.entries(stats.by_type).sort(([, a], [, b]) => b - a);

  const DATA_SOURCE_META: Record<string, { label: string; icon: string }> = {
    employee: { label: 'HR / People', icon: '👤' },
    client: { label: 'B2B Clients', icon: '🏢' },
    customer: { label: 'B2C Customers', icon: '🛒' },
    product: { label: 'Product Catalog', icon: '📦' },
    email_thread: { label: 'Email System', icon: '✉️' },
    conversation: { label: 'Chat Platform', icon: '💬' },
    ticket: { label: 'IT Ticketing', icon: '🎫' },
    repo: { label: 'GitHub Repos', icon: '💻' },
    policy: { label: 'Policy Docs', icon: '📋' },
    project: { label: 'Project Tracker', icon: '📊' },
    qa_post: { label: 'Internal Q&A', icon: '❓' },
    social_post: { label: 'Social Platform', icon: '📣' },
    order: { label: 'Order PDFs', icon: '🧾' },
    review: { label: 'Product Reviews', icon: '⭐' },
  };

  return (
    <div className="dashboard">
      <div className="dash-header">
        <h2 className="dash-title">Context Base Overview</h2>
        <p className="dash-subtitle">Live knowledge graph statistics for Inazuma.co</p>
      </div>

      <div className="dashboard-grid">
        {cards.map(({ label, value, Icon, color, soft }) => (
          <div key={label} className="stat-card" style={{ borderLeftColor: color }}>
            <div className="stat-card-icon" style={{ background: soft, color }}>
              <Icon size={20} />
            </div>
            <div className="stat-card-body">
              <div className="stat-card-label">{label}</div>
              <div className="stat-card-value">{value.toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="dash-charts">
        {Object.keys(stats.by_type).length > 0 && (
          <BarChart data={stats.by_type} title="Entities by Type" />
        )}
        {stats.edges_by_type && Object.keys(stats.edges_by_type).length > 0 && (
          <BarChart data={stats.edges_by_type} title="Edges by Type" />
        )}
      </div>

      {/* ── Two-column: Knowledge Graph + Conflict Resolution ── */}
      <div className="dash-two-col">
        <div className="dash-panel">
          <div className="dash-panel-header">
            <Hexagon size={14} />
            <span>Knowledge Graph</span>
          </div>
          <div className="dash-panel-body">
            <p className="dash-panel-hero">
              <strong>{stats.entities.toLocaleString()}</strong> entities connected by{' '}
              <strong>{stats.edges.toLocaleString()}</strong> relationships across{' '}
              <strong>{stats.sources.toLocaleString()}</strong> data sources
            </p>
            {edgesByType && (
              <div className="dash-pill-grid">
                {edgesByType.slice(0, 12).map(([type, count]) => (
                  <span key={type} className="dash-pill">
                    <span className="dash-pill-label">{type}</span>
                    <span className="dash-pill-count">{count.toLocaleString()}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-header">
            <ShieldCheck size={14} />
            <span>Conflict Resolution</span>
          </div>
          <div className="dash-panel-body">
            <ConflictBar open={stats.open_reviews} />
            <div className="dash-conflict-legend">
              <span className="dash-conflict-legend-item">
                <Clock size={12} />
                <strong>{stats.open_reviews.toLocaleString()}</strong> pending review
              </span>
            </div>
            <p className="dash-conflict-note">
              Conflicting facts from overlapping sources are flagged automatically.
              Each review surfaces the competing values with provenance and confidence scores.
            </p>
          </div>
        </div>
      </div>

      {/* ── Data Source Coverage ── */}
      <div className="dash-sources-section">
        <div className="dash-panel-header" style={{ marginBottom: 16 }}>
          <Server size={14} />
          <span>Ingested Data Sources</span>
        </div>
        <div className="dash-source-grid">
          {typeEntries.map(([type, count]) => {
            const meta = DATA_SOURCE_META[type];
            return (
              <div key={type} className="dash-source-card">
                <div className="dash-source-card-top">
                  <span className="dash-source-icon">{meta?.icon ?? '📁'}</span>
                  <CheckCircle2 size={12} className="dash-source-status" />
                </div>
                <div className="dash-source-name">{meta?.label ?? type}</div>
                <div className="dash-source-type">{type}</div>
                <div className="dash-source-count">{count.toLocaleString()} entities</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ConflictBar({ open }: { open: number }) {
  return (
    <div className="dash-conflict-bar-wrap">
      <div className="dash-conflict-bar">
        <div
          className="dash-conflict-bar-seg dash-conflict-bar-pending"
          style={{ width: '100%' }}
          title={`${open} pending`}
        />
      </div>
      <div className="dash-conflict-bar-labels">
        <span>{open.toLocaleString()} pending</span>
      </div>
    </div>
  );
}

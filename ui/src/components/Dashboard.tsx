import { useEffect, useState } from 'react';
import { Database, FileText, GitBranch, AlertTriangle, Layers } from 'lucide-react';
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
  '#0d9488', '#7c3aed', '#2563eb', '#16a34a', '#d97706',
  '#e11d48', '#0891b2', '#9333ea', '#ca8a04', '#78716c',
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
    { label: 'Entities', value: stats.entities, Icon: Database, color: '#0d9488', soft: '#e6f4f1' },
    { label: 'Facts', value: stats.facts, Icon: FileText, color: '#7c3aed', soft: '#ede9fe' },
    { label: 'Edges', value: stats.edges, Icon: GitBranch, color: '#2563eb', soft: '#dbeafe' },
    { label: 'Sources', value: stats.sources, Icon: Layers, color: '#16a34a', soft: '#dcfce7' },
    { label: 'Open Reviews', value: stats.open_reviews, Icon: AlertTriangle, color: '#d97706', soft: '#fef3c7' },
  ];

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
    </div>
  );
}

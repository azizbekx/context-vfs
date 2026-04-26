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
    { label: 'Entities', value: stats.entities, icon: <Database size={16} /> },
    { label: 'Facts', value: stats.facts, icon: <FileText size={16} /> },
    { label: 'Edges', value: stats.edges, icon: <GitBranch size={16} /> },
    { label: 'Sources', value: stats.sources, icon: <Layers size={16} /> },
    { label: 'Open Reviews', value: stats.open_reviews, icon: <AlertTriangle size={16} /> },
  ];

  return (
    <div className="dashboard">
      <h2 style={{ fontSize: 20, marginBottom: 20 }}>Context Base Overview</h2>
      <div className="dashboard-grid">
        {cards.map(c => (
          <div key={c.label} className="stat-card">
            <div className="stat-card-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {c.icon} {c.label}
            </div>
            <div className="stat-card-value">{c.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      {Object.keys(stats.by_type).length > 0 && (
        <>
          <h3 style={{ fontSize: 14, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 12 }}>
            Entities by Type
          </h3>
          <div className="type-grid">
            {Object.entries(stats.by_type)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => (
                <div key={type} className="type-chip">
                  <span>{type}</span>
                  <strong>{count}</strong>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

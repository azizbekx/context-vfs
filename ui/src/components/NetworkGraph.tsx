import { useRef, useEffect, useState, useCallback } from 'react';
import * as d3 from 'd3';

const TYPE_COLORS: Record<string, string> = {
  employee: '#3B82F6',
  client: '#F59E0B',
  customer: '#EF4444',
  product: '#EC4899',
  project: '#10B981',
  ticket: '#F97316',
  policy: '#8B5CF6',
  email_thread: '#06B6D4',
  conversation: '#06B6D4',
  repo: '#6366F1',
};

const DEFAULT_COLOR = '#64748B';

function colorFor(type: string): string {
  return TYPE_COLORS[type] || DEFAULT_COLOR;
}

interface Neighbor {
  entity_id: string;
  name: string;
  type: string;
  relation: string;
  direction: string;
}

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  type: string;
  isCenter: boolean;
  isSummary?: boolean;
  summaryCount?: number;
  summaryType?: string;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  relation: string;
}

interface Props {
  entity: { entity: { id: string; name: string; type: string } };
  neighbors: Neighbor[];
  onNodeClick: (entityId: string) => void;
}

const MAX_PER_TYPE = 5;
const MAX_TOTAL = 30;

function buildGraphData(
  entity: Props['entity'],
  neighbors: Neighbor[],
): { nodes: GraphNode[]; links: GraphLink[] } {
  const center: GraphNode = {
    id: entity.entity.id,
    name: entity.entity.name,
    type: entity.entity.type,
    isCenter: true,
  };

  const nodes: GraphNode[] = [center];
  const links: GraphLink[] = [];
  const seen = new Set<string>([center.id]);

  if (neighbors.length > MAX_TOTAL) {
    const grouped = new Map<string, Neighbor[]>();
    for (const n of neighbors) {
      const key = n.relation;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(n);
    }

    for (const [relation, group] of grouped) {
      const shown = group.slice(0, MAX_PER_TYPE);
      const remaining = group.length - shown.length;

      for (const n of shown) {
        if (seen.has(n.entity_id)) continue;
        seen.add(n.entity_id);
        nodes.push({ id: n.entity_id, name: n.name, type: n.type, isCenter: false });
        links.push({ source: center.id, target: n.entity_id, relation });
      }

      if (remaining > 0) {
        const summaryId = `__summary__${relation}`;
        nodes.push({
          id: summaryId,
          name: `+${remaining} more`,
          type: group[0].type,
          isCenter: false,
          isSummary: true,
          summaryCount: remaining,
          summaryType: relation,
        });
        links.push({ source: center.id, target: summaryId, relation });
      }
    }
  } else {
    for (const n of neighbors) {
      if (seen.has(n.entity_id)) continue;
      seen.add(n.entity_id);
      nodes.push({ id: n.entity_id, name: n.name, type: n.type, isCenter: false });
      links.push({ source: center.id, target: n.entity_id, relation: n.relation });
    }
  }

  return { nodes, links };
}

const NODE_W = 140;
const NODE_H = 48;
const CENTER_W = 170;
const CENTER_H = 56;

export default function NetworkGraph({ entity, neighbors, onNodeClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; id: string; type: string } | null>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);

  const handleNodeClick = useCallback(
    (nodeId: string, isSummary?: boolean) => {
      if (isSummary) return;
      if (nodeId === entity.entity.id) return;
      onNodeClick(nodeId);
    },
    [entity.entity.id, onNodeClick],
  );

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const { nodes, links } = buildGraphData(entity, neighbors);

    const svgSel = d3.select(svg);
    svgSel.selectAll('*').remove();
    svgSel.attr('width', width).attr('height', height);

    const defs = svgSel.append('defs');
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      const filter = defs.append('filter').attr('id', `glow-${type}`).attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
      filter.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
      filter.append('feFlood').attr('flood-color', color).attr('flood-opacity', '0.25');
      filter.append('feComposite').attr('in2', 'blur').attr('operator', 'in');
      const merge = filter.append('feMerge');
      merge.append('feMergeNode');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
    }
    const centerFilter = defs.append('filter').attr('id', 'glow-center').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    centerFilter.append('feGaussianBlur').attr('stdDeviation', '5').attr('result', 'blur');
    centerFilter.append('feFlood').attr('flood-color', '#ffffff').attr('flood-opacity', '0.3');
    centerFilter.append('feComposite').attr('in2', 'blur').attr('operator', 'in');
    const centerMerge = centerFilter.append('feMerge');
    centerMerge.append('feMergeNode');
    centerMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    const defaultFilter = defs.append('filter').attr('id', 'glow-default').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    defaultFilter.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
    defaultFilter.append('feFlood').attr('flood-color', DEFAULT_COLOR).attr('flood-opacity', '0.25');
    defaultFilter.append('feComposite').attr('in2', 'blur').attr('operator', 'in');
    const defaultMerge = defaultFilter.append('feMerge');
    defaultMerge.append('feMergeNode');
    defaultMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    const g = svgSel.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svgSel.call(zoom);
    svgSel.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));

    const linkGroup = g.append('g').attr('class', 'links');
    const linkSel = linkGroup
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(links)
      .join('line')
      .attr('stroke', 'rgba(255,255,255,0.19)')
      .attr('stroke-width', 1.5);

    const labelGroup = g.append('g').attr('class', 'link-labels');
    const labelSel = labelGroup
      .selectAll<SVGTextElement, GraphLink>('text')
      .data(links)
      .join('text')
      .text((d) => d.relation)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.35)')
      .attr('font-size', '9px')
      .attr('font-family', 'Inter, sans-serif')
      .attr('dy', -4)
      .style('pointer-events', 'none');

    const nodeGroup = g.append('g').attr('class', 'nodes');
    const nodeSel = nodeGroup
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes, (d) => d.id)
      .join('g')
      .attr('cursor', (d) => (d.isSummary ? 'default' : 'pointer'))
      .on('click', (_event, d) => handleNodeClick(d.id, d.isSummary))
      .on('mouseenter', (event, d) => {
        if (d.isSummary) return;
        const rect = container.getBoundingClientRect();
        const svgPoint = svg.createSVGPoint();
        svgPoint.x = event.clientX;
        svgPoint.y = event.clientY;
        setTooltip({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top - 10,
          id: d.id,
          type: d.type,
        });
      })
      .on('mouseleave', () => setTooltip(null));

    nodeSel.each(function (d) {
      const el = d3.select(this);
      const w = d.isCenter ? CENTER_W : NODE_W;
      const h = d.isCenter ? CENTER_H : NODE_H;
      const color = d.isCenter ? '#fff' : colorFor(d.type);
      const filterName = d.isCenter
        ? 'url(#glow-center)'
        : TYPE_COLORS[d.type]
          ? `url(#glow-${d.type})`
          : 'url(#glow-default)';

      el.append('rect')
        .attr('x', -w / 2)
        .attr('y', -h / 2)
        .attr('width', w)
        .attr('height', h)
        .attr('rx', 10)
        .attr('fill', d.isCenter ? '#1A1D27' : '#141620')
        .attr('stroke', color)
        .attr('stroke-width', d.isCenter ? 2 : 1.5)
        .attr('filter', filterName)
        .classed('graph-node-rect', true);

      if (!d.isSummary) {
        el.append('text')
          .text(d.type)
          .attr('y', -h / 2 + 14)
          .attr('text-anchor', 'middle')
          .attr('fill', color)
          .attr('font-size', '9px')
          .attr('font-weight', '600')
          .attr('font-family', 'Inter, sans-serif')
          .attr('text-transform', 'uppercase')
          .style('text-transform', 'uppercase')
          .style('pointer-events', 'none');
      }

      const displayName = d.name.length > 20 ? d.name.slice(0, 19) + '…' : d.name;
      el.append('text')
        .text(displayName)
        .attr('y', d.isSummary ? 4 : 8)
        .attr('text-anchor', 'middle')
        .attr('fill', d.isCenter ? '#E4E4E7' : d.isSummary ? '#9CA3AF' : '#E4E4E7')
        .attr('font-size', d.isCenter ? '13px' : d.isSummary ? '11px' : '12px')
        .attr('font-weight', d.isCenter ? '600' : '500')
        .attr('font-family', 'Inter, sans-serif')
        .style('pointer-events', 'none');
    });

    const drag = d3
      .drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeSel.call(drag);

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(160),
      )
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(0, 0))
      .force('collision', d3.forceCollide<GraphNode>().radius((d) => (d.isCenter ? 60 : 50)))
      .alpha(1)
      .alphaDecay(0.03);

    simulationRef.current = simulation;

    simulation.on('tick', () => {
      linkSel
        .attr('x1', (d) => (d.source as GraphNode).x!)
        .attr('y1', (d) => (d.source as GraphNode).y!)
        .attr('x2', (d) => (d.target as GraphNode).x!)
        .attr('y2', (d) => (d.target as GraphNode).y!);

      labelSel
        .attr('x', (d) => ((d.source as GraphNode).x! + (d.target as GraphNode).x!) / 2)
        .attr('y', (d) => ((d.source as GraphNode).y! + (d.target as GraphNode).y!) / 2);

      nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    return () => {
      simulation.stop();
      simulationRef.current = null;
    };
  }, [entity, neighbors, handleNodeClick]);

  return (
    <div ref={containerRef} className="network-graph-container">
      <svg ref={svgRef} />
      {tooltip && (
        <div
          className="graph-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="graph-tooltip-id">{tooltip.id}</div>
          <div className="graph-tooltip-type">{tooltip.type}</div>
        </div>
      )}
    </div>
  );
}

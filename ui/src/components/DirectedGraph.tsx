import { useRef, useEffect, useState, useCallback } from 'react';
import { Maximize2 } from 'lucide-react';
import * as d3 from 'd3';
import { readGraphTheme } from '../graphTheme';

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

interface LayoutNode {
  id: string;
  name: string;
  type: string;
  isCenter: boolean;
  isSummary?: boolean;
  x: number;
  y: number;
}

interface LayoutLink {
  source: LayoutNode;
  target: LayoutNode;
  relation: string;
}

interface Props {
  entity: { entity: { id: string; name: string; type: string } };
  neighbors: Neighbor[];
  onNodeClick: (entityId: string) => void;
}

const NODE_W = 140;
const NODE_H = 44;
const CENTER_W = 170;
const CENTER_H = 56;
const FIT_PADDING = 60;
const COL_GAP = 280;
const ROW_GAP = 12;
const GROUP_GAP = 28;
const GROUP_LABEL_H = 22;
const MAX_PER_GROUP = 5;

function buildLayout(
  entity: Props['entity'],
  neighbors: Neighbor[],
): { nodes: LayoutNode[]; links: LayoutLink[] } {
  const incoming = neighbors.filter((n) => n.direction === 'incoming');
  const outgoing = neighbors.filter((n) => n.direction !== 'incoming');

  const center: LayoutNode = {
    id: entity.entity.id,
    name: entity.entity.name,
    type: entity.entity.type,
    isCenter: true,
    x: 0,
    y: 0,
  };

  const nodes: LayoutNode[] = [center];
  const links: LayoutLink[] = [];

  function layoutColumn(
    items: Neighbor[],
    xOffset: number,
  ): void {
    const grouped = new Map<string, Neighbor[]>();
    for (const n of items) {
      if (!grouped.has(n.relation)) grouped.set(n.relation, []);
      grouped.get(n.relation)!.push(n);
    }

    const seen = new Set<string>([center.id]);
    let yPos = 0;

    for (const [relation, group] of grouped) {
      yPos += GROUP_LABEL_H;
      const shown = group.slice(0, MAX_PER_GROUP);
      const remaining = group.length - shown.length;

      for (const n of shown) {
        if (seen.has(n.entity_id)) continue;
        seen.add(n.entity_id);
        const node: LayoutNode = {
          id: n.entity_id,
          name: n.name,
          type: n.type,
          isCenter: false,
          x: xOffset,
          y: yPos,
        };
        nodes.push(node);
        if (xOffset < 0) {
          links.push({ source: node, target: center, relation });
        } else {
          links.push({ source: center, target: node, relation });
        }
        yPos += NODE_H + ROW_GAP;
      }

      if (remaining > 0) {
        const summaryNode: LayoutNode = {
          id: `__summary__${relation}__${xOffset}`,
          name: `+${remaining} more`,
          type: group[0].type,
          isCenter: false,
          isSummary: true,
          x: xOffset,
          y: yPos,
        };
        nodes.push(summaryNode);
        if (xOffset < 0) {
          links.push({ source: summaryNode, target: center, relation });
        } else {
          links.push({ source: center, target: summaryNode, relation });
        }
        yPos += NODE_H + ROW_GAP;
      }

      yPos += GROUP_GAP;
    }

    // Vertically center the column around y=0
    const columnNodes = nodes.filter((n) => !n.isCenter && n.x === xOffset);
    if (columnNodes.length) {
      const minY = Math.min(...columnNodes.map((n) => n.y));
      const maxY = Math.max(...columnNodes.map((n) => n.y));
      const shift = (minY + maxY) / 2;
      for (const n of columnNodes) n.y -= shift;
    }
  }

  layoutColumn(incoming, -COL_GAP);
  layoutColumn(outgoing, COL_GAP);

  return { nodes, links };
}

function curvedPathLR(sx: number, sy: number, tx: number, ty: number): string {
  const mx = (sx + tx) / 2;
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

export default function DirectedGraph({ entity, neighbors, onNodeClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; id: string; type: string } | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodesRef = useRef<LayoutNode[]>([]);

  const fitToView = useCallback((animated = true) => {
    const svg = svgRef.current;
    const container = containerRef.current;
    const zoomBehavior = zoomRef.current;
    if (!svg || !container || !zoomBehavior) return;

    const nodes = nodesRef.current;
    if (!nodes.length) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const hw = (n.isCenter ? CENTER_W : NODE_W) / 2 + 10;
      const hh = (n.isCenter ? CENTER_H : NODE_H) / 2 + 10;
      if (n.x - hw < minX) minX = n.x - hw;
      if (n.y - hh < minY) minY = n.y - hh;
      if (n.x + hw > maxX) maxX = n.x + hw;
      if (n.y + hh > maxY) maxY = n.y + hh;
    }

    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw <= 0 || bh <= 0) return;

    const scale = Math.min(
      (width - FIT_PADDING * 2) / bw,
      (height - FIT_PADDING * 2) / bh,
      1.8,
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const transform = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale)
      .translate(-cx, -cy);

    const sel = d3.select(svg);
    if (animated) {
      sel.transition().duration(600).ease(d3.easeCubicOut).call(zoomBehavior.transform, transform);
    } else {
      sel.call(zoomBehavior.transform, transform);
    }
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const t = readGraphTheme();
    const { nodes, links } = buildLayout(entity, neighbors);
    nodesRef.current = nodes;

    const svgSel = d3.select(svg);
    svgSel.selectAll('*').remove();
    svgSel.attr('width', width).attr('height', height);

    const defs = svgSel.append('defs');

    // Glow filters
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      const filter = defs.append('filter').attr('id', `dglow-${type}`)
        .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
      filter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '6').attr('result', 'blur');
      filter.append('feFlood').attr('flood-color', color).attr('flood-opacity', t.glowOpacity);
      filter.append('feComposite').attr('in2', 'blur').attr('operator', 'in').attr('result', 'glow');
      const merge = filter.append('feMerge');
      merge.append('feMergeNode').attr('in', 'glow');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
    }

    const centerFilter = defs.append('filter').attr('id', 'dglow-center')
      .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
    centerFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '8').attr('result', 'blur');
    centerFilter.append('feFlood').attr('flood-color', t.centerGlow.replace(/[\d.]+\)$/, '1)')).attr('flood-opacity', '0.45');
    centerFilter.append('feComposite').attr('in2', 'blur').attr('operator', 'in').attr('result', 'glow');
    const centerMerge = centerFilter.append('feMerge');
    centerMerge.append('feMergeNode').attr('in', 'glow');
    centerMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    const defaultFilter = defs.append('filter').attr('id', 'dglow-default')
      .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
    defaultFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '6').attr('result', 'blur');
    defaultFilter.append('feFlood').attr('flood-color', DEFAULT_COLOR).attr('flood-opacity', t.glowOpacity);
    defaultFilter.append('feComposite').attr('in2', 'blur').attr('operator', 'in').attr('result', 'glow');
    const defaultMerge = defaultFilter.append('feMerge');
    defaultMerge.append('feMergeNode').attr('in', 'glow');
    defaultMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Arrowheads
    defs.append('marker').attr('id', 'darrow')
      .attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-3.5L8,0L0,3.5').attr('fill', t.arrow);

    defs.append('marker').attr('id', 'darrow-bright')
      .attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-3.5L8,0L0,3.5').attr('fill', t.arrowBright);

    const g = svgSel.append('g');

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on('zoom', (event) => g.attr('transform', event.transform));

    zoomRef.current = zoomBehavior;
    svgSel.call(zoomBehavior);
    svgSel.call(zoomBehavior.transform, d3.zoomIdentity.translate(width / 2, height / 2));

    // Build link index for hover
    const nodeLinks = new Map<string, Set<number>>();
    links.forEach((l, i) => {
      if (!nodeLinks.has(l.source.id)) nodeLinks.set(l.source.id, new Set());
      if (!nodeLinks.has(l.target.id)) nodeLinks.set(l.target.id, new Set());
      nodeLinks.get(l.source.id)!.add(i);
      nodeLinks.get(l.target.id)!.add(i);
    });

    // Column labels
    const hasIncoming = nodes.some((n) => !n.isCenter && n.x < 0);
    const hasOutgoing = nodes.some((n) => !n.isCenter && n.x > 0);
    const labelG = g.append('g').attr('class', 'col-labels');
    if (hasIncoming) {
      labelG.append('text')
        .text('INCOMING')
        .attr('x', -COL_GAP).attr('y', -height / 2 + 20)
        .attr('text-anchor', 'middle')
        .attr('fill', t.labelDim)
        .attr('font-size', '10px').attr('font-weight', '700')
        .attr('font-family', 'Inter, sans-serif')
        .attr('letter-spacing', '0.1em')
        .style('pointer-events', 'none');
    }
    if (hasOutgoing) {
      labelG.append('text')
        .text('OUTGOING')
        .attr('x', COL_GAP).attr('y', -height / 2 + 20)
        .attr('text-anchor', 'middle')
        .attr('fill', t.labelDim)
        .attr('font-size', '10px').attr('font-weight', '700')
        .attr('font-family', 'Inter, sans-serif')
        .attr('letter-spacing', '0.1em')
        .style('pointer-events', 'none');
    }

    // Group labels per relation type
    const groupLabelG = g.append('g').attr('class', 'group-labels');
    const seenGroups = new Set<string>();
    for (const link of links) {
      const col = link.source.isCenter ? link.target : link.source;
      const key = `${col.x}__${link.relation}`;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const sameGroup = links.filter((l) => {
        const c = l.source.isCenter ? l.target : l.source;
        return c.x === col.x && l.relation === link.relation;
      });
      const topY = Math.min(...sameGroup.map((l) => {
        const c = l.source.isCenter ? l.target : l.source;
        return c.y;
      }));
      groupLabelG.append('text')
        .text(link.relation)
        .attr('x', col.x)
        .attr('y', topY - NODE_H / 2 - 8)
        .attr('text-anchor', 'middle')
        .attr('fill', t.label)
        .attr('font-size', '9px').attr('font-weight', '600')
        .attr('font-family', 'Inter, sans-serif')
        .style('text-transform', 'uppercase')
        .style('pointer-events', 'none');
    }

    // Edges
    const linkGroup = g.append('g').attr('class', 'links');
    const linkSel = linkGroup.selectAll<SVGPathElement, LayoutLink>('path')
      .data(links).join('path')
      .attr('fill', 'none')
      .attr('stroke', t.edge)
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#darrow)')
      .attr('d', (d) => {
        const sw = (d.source.isCenter ? CENTER_W : NODE_W) / 2 + 4;
        const tw = (d.target.isCenter ? CENTER_W : NODE_W) / 2 + 4;
        const sx = d.source.x + (d.target.x > d.source.x ? sw : -sw);
        const tx = d.target.x + (d.source.x > d.target.x ? tw : -tw);
        return curvedPathLR(sx, d.source.y, tx, d.target.y);
      });

    // Nodes
    const nodeGroup = g.append('g').attr('class', 'nodes');
    const nodeSel = nodeGroup.selectAll<SVGGElement, LayoutNode>('g')
      .data(nodes, (d) => d.id).join('g')
      .attr('transform', (d) => `translate(${d.x},${d.y})`)
      .attr('cursor', (d) => (d.isSummary ? 'default' : 'pointer'))
      .on('click', (_event, d) => {
        if (d.isSummary || d.isCenter) return;
        onNodeClick(d.id);
      })
      .on('mouseenter', function (event, d) {
        if (!d.isSummary) {
          const rect = container.getBoundingClientRect();
          setTooltip({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top - 10,
            id: d.id,
            type: d.type,
          });
        }
        const connectedSet = nodeLinks.get(d.id) || new Set<number>();
        linkSel.attr('stroke', (_l, i) =>
          connectedSet.has(i) ? t.edgeHover : t.edgeDim,
        ).attr('stroke-width', (_l, i) =>
          connectedSet.has(i) ? 2.2 : 1,
        ).attr('marker-end', (_l, i) =>
          connectedSet.has(i) ? 'url(#darrow-bright)' : 'url(#darrow)',
        );
        nodeSel.style('opacity', (n) => {
          if (n.id === d.id) return 1;
          const isConnected = links.some((l, i) => connectedSet.has(i) && (l.source.id === n.id || l.target.id === n.id));
          return isConnected ? 1 : 0.25;
        });
      })
      .on('mouseleave', () => {
        setTooltip(null);
        linkSel.attr('stroke', t.edge).attr('stroke-width', 1.5).attr('marker-end', 'url(#darrow)');
        nodeSel.style('opacity', 1);
      });

    nodeSel.each(function (d) {
      const el = d3.select(this);
      const w = d.isCenter ? CENTER_W : NODE_W;
      const h = d.isCenter ? CENTER_H : NODE_H;
      const color = d.isCenter ? t.centerStroke : colorFor(d.type);
      const filterName = d.isCenter
        ? 'url(#dglow-center)'
        : TYPE_COLORS[d.type] ? `url(#dglow-${d.type})` : 'url(#dglow-default)';

      el.append('rect')
        .attr('x', -w / 2).attr('y', -h / 2)
        .attr('width', w).attr('height', h)
        .attr('rx', 10)
        .attr('fill', d.isCenter ? t.centerFill : t.nodeFill)
        .attr('stroke', color)
        .attr('stroke-width', d.isCenter ? 2 : 1.5)
        .attr('filter', filterName);

      if (!d.isSummary) {
        el.append('text')
          .text(d.type)
          .attr('y', -h / 2 + 14)
          .attr('text-anchor', 'middle')
          .attr('fill', color)
          .attr('font-size', '9px').attr('font-weight', '600')
          .attr('font-family', 'Inter, sans-serif')
          .style('text-transform', 'uppercase')
          .style('pointer-events', 'none');
      }

      const displayName = d.name.length > 20 ? d.name.slice(0, 19) + '\u2026' : d.name;
      el.append('text')
        .text(displayName)
        .attr('y', d.isSummary ? 4 : 8)
        .attr('text-anchor', 'middle')
        .attr('fill', d.isCenter ? t.text : d.isSummary ? t.textMuted : t.text)
        .attr('font-size', d.isCenter ? '13px' : d.isSummary ? '11px' : '12px')
        .attr('font-weight', d.isCenter ? '600' : '500')
        .attr('font-family', 'Inter, sans-serif')
        .style('pointer-events', 'none');
    });

    // Initial fit
    requestAnimationFrame(() => fitToView(true));

    return () => { zoomRef.current = null; };
  }, [entity, neighbors, onNodeClick, fitToView]);

  return (
    <div ref={containerRef} className="network-graph-container">
      <svg ref={svgRef} />
      <button className="graph-fit-btn" onClick={() => fitToView(true)} title="Fit to view">
        <Maximize2 size={14} />
      </button>
      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="graph-tooltip-id">{tooltip.id}</div>
          <div className="graph-tooltip-type">{tooltip.type}</div>
        </div>
      )}
    </div>
  );
}

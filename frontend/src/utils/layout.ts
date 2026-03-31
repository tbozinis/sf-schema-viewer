/**
 * Layout utilities using ELK for automatic node positioning and edge routing.
 */

import ELK, {
  type ElkEdgeSection,
  type ElkExtendedEdge,
  type ElkNode,
} from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';
import {
  calculateDynamicHeight,
  calculateEdgeCountsPerNode,
  type EdgeCounts,
} from './layoutHelpers';

export interface ElkLayoutPoint {
  x: number;
  y: number;
}

export interface ElkLayoutSection {
  id: string;
  startPoint: ElkLayoutPoint;
  bendPoints?: ElkLayoutPoint[];
  endPoint: ElkLayoutPoint;
  incomingSections?: string[];
  outgoingSections?: string[];
}

export interface ElkLayoutPath {
  sections: ElkLayoutSection[];
}

interface LayoutOptions {
  direction: 'RIGHT' | 'DOWN';
  nodeWidth: number;
  nodeHeight: number;
  nodeSpacing: number;
  layerSpacing: number;
  edgeNodeBetweenLayers: number;
}

const DEFAULT_OPTIONS: LayoutOptions = {
  direction: 'RIGHT',
  nodeWidth: 280,
  nodeHeight: 300,
  nodeSpacing: 100,
  layerSpacing: 200,
  edgeNodeBetweenLayers: 50,
};

const elk = new ELK();

function readDimension(value: unknown, fallback: number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function getNodeRenderDimensions(
  node: Node,
  fallbackWidth: number = DEFAULT_OPTIONS.nodeWidth,
  fallbackHeight: number = DEFAULT_OPTIONS.nodeHeight
) {
  return {
    width: readDimension(node.width ?? node.style?.width, fallbackWidth),
    height: readDimension(node.height ?? node.style?.height, fallbackHeight),
  };
}

function getLayoutDimensions(
  node: Node,
  options: LayoutOptions,
  edgeCounts: Map<string, EdgeCounts>
) {
  const nodeData = node.data as { collapsed?: boolean; fields?: unknown[] };
  const fieldCount = nodeData.collapsed ? 0 : Math.min(nodeData.fields?.length ?? 0, 10);
  const fieldBasedHeight = 60 + fieldCount * 28;
  const nodeEdgeCounts = edgeCounts.get(node.id) || { left: 0, right: 0, top: 0, bottom: 0 };
  const edgeBasedHeight = calculateDynamicHeight(nodeEdgeCounts);
  const dynamicHeight = Math.max(fieldBasedHeight, edgeBasedHeight);
  const explicitDimensions = getNodeRenderDimensions(node, options.nodeWidth, options.nodeHeight);

  return {
    width: explicitDimensions.width,
    height: readDimension(
      node.height ?? node.style?.height,
      Math.min(dynamicHeight, options.nodeHeight)
    ),
  };
}

function mapElkSection(section: ElkEdgeSection): ElkLayoutSection {
  return {
    id: section.id,
    startPoint: {
      x: section.startPoint.x,
      y: section.startPoint.y,
    },
    bendPoints: section.bendPoints?.map((point) => ({
      x: point.x,
      y: point.y,
    })),
    endPoint: {
      x: section.endPoint.x,
      y: section.endPoint.y,
    },
    incomingSections: section.incomingSections,
    outgoingSections: section.outgoingSections,
  };
}

/**
 * Apply ELK layout to nodes and edges.
 */
export async function applyElkLayout(
  nodes: Node[],
  edges: Edge[],
  options: Partial<LayoutOptions> = {}
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edgeCounts = calculateEdgeCountsPerNode(edges);
  const dimensionsById = new Map(
    nodes.map((node) => [node.id, getLayoutDimensions(node, opts, edgeCounts)])
  );

  const elkGraph: ElkNode = {
    id: 'layout-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': opts.direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.spacing.edgeNodeBetweenLayers': String(opts.edgeNodeBetweenLayers),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.layerSpacing),
      'elk.spacing.nodeNode': String(opts.nodeSpacing),
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
    },
    children: nodes.map((node) => {
      const dimensions = dimensionsById.get(node.id);

      return {
        id: node.id,
        width: dimensions?.width ?? opts.nodeWidth,
        height: dimensions?.height ?? opts.nodeHeight,
      };
    }),
    edges: edges.map<ElkExtendedEdge>((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layoutedGraph = await elk.layout(elkGraph);
  const childrenById = new Map(
    (layoutedGraph.children ?? []).map((child) => [child.id, child])
  );
  const edgesById = new Map(
    (layoutedGraph.edges ?? []).map((edge) => [edge.id, edge])
  );

  const layoutedNodes = nodes.map((node) => {
    const layoutedNode = childrenById.get(node.id);
    const fallbackDimensions = dimensionsById.get(node.id) ?? {
      width: opts.nodeWidth,
      height: opts.nodeHeight,
    };
    const width = readDimension(layoutedNode?.width, fallbackDimensions.width);
    const height = readDimension(layoutedNode?.height, fallbackDimensions.height);

    return {
      ...node,
      position: {
        x: readDimension(layoutedNode?.x, node.position.x),
        y: readDimension(layoutedNode?.y, node.position.y),
      },
      width,
      height,
      initialWidth: width,
      initialHeight: height,
      measured: {
        width,
        height,
      },
      style: {
        ...(node.style ?? {}),
        width,
        height,
      },
    };
  });

  const layoutedEdges = edges.map((edge) => {
    const layoutedEdge = edgesById.get(edge.id);
    const sections = layoutedEdge?.sections?.map(mapElkSection) ?? [];

    return {
      ...edge,
      data: {
        ...(edge.data ?? {}),
        elkPath: sections.length > 0 ? { sections } : undefined,
      },
    };
  });

  return { nodes: layoutedNodes, edges: layoutedEdges };
}

/**
 * Get viewport to fit all nodes.
 */
export function getViewportForNodes(
  nodes: Node[],
  padding = 50
): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) {
    return { x: 0, y: 0, width: 800, height: 600 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const { width, height } = getNodeRenderDimensions(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

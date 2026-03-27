import { Position, type Edge, type Node } from '@xyflow/react';

type RoutingNode = Node<Record<string, unknown>>;
type RoutingEdge = Edge<Record<string, unknown>>;
type CorridorOrientation = 'horizontal' | 'vertical';

export type EdgeRoutingMode = 'curved' | 'orthogonal';

export interface OrthogonalRoutingOptions {
  protectedRouting?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  start: Point;
  end: Point;
  orientation: 'horizontal' | 'vertical';
}

export interface OrthogonalRoute {
  points: Point[];
  segments: Segment[];
  labelX: number;
  labelY: number;
  sourceCardX: number;
  sourceCardY: number;
  targetCardX: number;
  targetCardY: number;
  isSelfLoop: boolean;
}

const NODE_CLEARANCE = 36;
const PROTECTED_NODE_CLEARANCE = 52;
const PARALLEL_LANE_SPACING = 28;
const CARDINALITY_OFFSET = 12;
const SELF_LOOP_WIDTH = 72;
const SELF_LOOP_SPACING = 26;
const SELF_LOOP_HEIGHT = 44;
const LINE_JUMP_RADIUS = 10;
const LINE_JUMP_HEIGHT = 9;
const LINE_JUMP_ENDPOINT_PADDING = 18;
const LINE_JUMP_MIN_GAP = LINE_JUMP_RADIUS * 2 + 4;
const SIDE_ANCHOR_PADDING = 18;
const MIN_SIDE_ANCHOR_SPACING = 12;

function hasMeasuredSize(
  node: RoutingNode | undefined
): node is RoutingNode & { measured: { width: number; height: number } } {
  return !!node?.measured?.width && !!node?.measured?.height;
}

function pointsEqual(a: Point, b: Point) {
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function getFieldName(edge: RoutingEdge) {
  return ((edge.data as Record<string, unknown> | undefined)?.fieldName as string | undefined) ?? '';
}

function getNodeCenter(node: RoutingNode & { measured: { width: number; height: number } }) {
  return {
    x: node.position.x + node.measured.width / 2,
    y: node.position.y + node.measured.height / 2,
  };
}

export function getTargetSide(
  sourceNode: RoutingNode | undefined,
  targetNode: RoutingNode | undefined
): Position {
  if (!hasMeasuredSize(sourceNode) || !hasMeasuredSize(targetNode)) {
    return Position.Left;
  }

  const sourceCenter = getNodeCenter(sourceNode);
  const targetCenter = getNodeCenter(targetNode);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const horizontalDominant = Math.abs(dx) > Math.abs(dy) * 0.5;

  if (horizontalDominant) {
    return dx > 0 ? Position.Left : Position.Right;
  }
  return dy > 0 ? Position.Top : Position.Bottom;
}

function getSourceSide(
  sourceNode: RoutingNode | undefined,
  targetNode: RoutingNode | undefined
): Position {
  const targetSide = getTargetSide(sourceNode, targetNode);
  if (targetSide === Position.Left) return Position.Right;
  if (targetSide === Position.Right) return Position.Left;
  if (targetSide === Position.Top) return Position.Bottom;
  return Position.Top;
}

function compareProjectedCoordinate(a: number, b: number) {
  if (Math.abs(a - b) < 0.5) {
    return 0;
  }

  return a - b;
}

function clampCoordinate(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getOrderingCoordinates(
  node: RoutingNode & { measured: { width: number; height: number } },
  side: Position
) {
  const center = getNodeCenter(node);

  if (side === Position.Left || side === Position.Right) {
    return { primary: center.y, secondary: center.x };
  }

  return { primary: center.x, secondary: center.y };
}

function getSideCoordinateBounds(
  node: RoutingNode & { measured: { width: number; height: number } },
  side: Position
) {
  if (side === Position.Left || side === Position.Right) {
    return {
      min: node.position.y + SIDE_ANCHOR_PADDING,
      max: node.position.y + node.measured.height - SIDE_ANCHOR_PADDING,
      usable: Math.max(node.measured.height - SIDE_ANCHOR_PADDING * 2, 0),
    };
  }

  return {
    min: node.position.x + SIDE_ANCHOR_PADDING,
    max: node.position.x + node.measured.width - SIDE_ANCHOR_PADDING,
    usable: Math.max(node.measured.width - SIDE_ANCHOR_PADDING * 2, 0),
  };
}

function getDesiredSideCoordinate(
  edge: RoutingEdge,
  side: Position,
  role: 'source' | 'target',
  getNode: (id: string) => RoutingNode | undefined
) {
  const otherNodeId = role === 'source' ? edge.target : edge.source;
  const otherNode = getNode(otherNodeId);

  if (!hasMeasuredSize(otherNode)) {
    return null;
  }

  const center = getNodeCenter(otherNode);
  return side === Position.Left || side === Position.Right ? center.y : center.x;
}

export function compareEdgesBySidePosition(
  a: RoutingEdge,
  b: RoutingEdge,
  side: Position,
  role: 'source' | 'target',
  getNode: (id: string) => RoutingNode | undefined
) {
  const aOtherId = role === 'source' ? a.target : a.source;
  const bOtherId = role === 'source' ? b.target : b.source;
  const aOtherNode = getNode(aOtherId);
  const bOtherNode = getNode(bOtherId);

  if (hasMeasuredSize(aOtherNode) && hasMeasuredSize(bOtherNode)) {
    const aCoordinates = getOrderingCoordinates(aOtherNode, side);
    const bCoordinates = getOrderingCoordinates(bOtherNode, side);
    const primaryDiff = compareProjectedCoordinate(aCoordinates.primary, bCoordinates.primary);

    if (primaryDiff !== 0) {
      return primaryDiff;
    }

    const secondaryDiff = compareProjectedCoordinate(aCoordinates.secondary, bCoordinates.secondary);
    if (secondaryDiff !== 0) {
      return secondaryDiff;
    }
  }

  if (aOtherId !== bOtherId) {
    return aOtherId.localeCompare(bOtherId);
  }

  const fieldDiff = getFieldName(a).localeCompare(getFieldName(b));
  if (fieldDiff !== 0) {
    return fieldDiff;
  }

  return a.id.localeCompare(b.id);
}

export function getAdaptiveSideAnchor(
  edge: RoutingEdge,
  allEdges: RoutingEdge[],
  node: RoutingNode & { measured: { width: number; height: number } },
  side: Position,
  role: 'source' | 'target',
  getNode: (id: string) => RoutingNode | undefined
): Point {
  const anchor = getAnchorPoint(node, side);
  const relatedEdges = allEdges
    .filter((candidate) => {
      if (role === 'source' && candidate.source !== edge.source) return false;
      if (role === 'target' && candidate.target !== edge.target) return false;

      const candidateSourceNode = getNode(candidate.source);
      const candidateTargetNode = getNode(candidate.target);
      if (!hasMeasuredSize(candidateSourceNode) || !hasMeasuredSize(candidateTargetNode)) {
        return false;
      }

      const candidateSide = role === 'source'
        ? getSourceSide(candidateSourceNode, candidateTargetNode)
        : getTargetSide(candidateSourceNode, candidateTargetNode);

      return candidateSide === side;
    })
    .sort((a, b) => compareEdgesBySidePosition(a, b, side, role, getNode));

  if (relatedEdges.length <= 1) {
    return anchor;
  }

  const { min, max, usable } = getSideCoordinateBounds(node, side);
  const maxSpacing = relatedEdges.length > 1 ? usable / (relatedEdges.length - 1) : usable;
  const minSpacing = Math.max(
    MIN_SIDE_ANCHOR_SPACING,
    Math.min(28, relatedEdges.length > 0 ? usable / relatedEdges.length : usable)
  );
  const spacing = Math.max(Math.min(minSpacing, maxSpacing || minSpacing), MIN_SIDE_ANCHOR_SPACING);

  const entries = relatedEdges.map((candidate) => ({
    edgeId: candidate.id,
    desired: clampCoordinate(
      getDesiredSideCoordinate(candidate, side, role, getNode) ??
        (side === Position.Left || side === Position.Right
          ? node.position.y + node.measured.height / 2
          : node.position.x + node.measured.width / 2),
      min,
      max
    ),
  }));

  if (entries.length === 0) {
    return anchor;
  }

  const assigned = entries.map((entry) => entry.desired);

  for (let index = 1; index < assigned.length; index += 1) {
    assigned[index] = Math.max(assigned[index], assigned[index - 1] + spacing);
  }

  assigned[assigned.length - 1] = Math.min(assigned[assigned.length - 1], max);
  for (let index = assigned.length - 2; index >= 0; index -= 1) {
    assigned[index] = Math.min(assigned[index], assigned[index + 1] - spacing);
  }

  assigned[0] = Math.max(assigned[0], min);
  for (let index = 1; index < assigned.length; index += 1) {
    assigned[index] = Math.max(assigned[index], assigned[index - 1] + spacing);
  }

  const entryIndex = entries.findIndex((entry) => entry.edgeId === edge.id);
  if (entryIndex < 0) {
    return anchor;
  }

  const coordinate = clampCoordinate(assigned[entryIndex], min, max);

  if (side === Position.Left || side === Position.Right) {
    return { x: anchor.x, y: coordinate };
  }

  return { x: coordinate, y: anchor.y };
}

function sortEdgesForLaneGroup(a: RoutingEdge, b: RoutingEdge) {
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  if (a.target !== b.target) return a.target.localeCompare(b.target);
  return getFieldName(a).localeCompare(getFieldName(b));
}

function getAnchorPoint(
  node: RoutingNode & { measured: { width: number; height: number } },
  position: Position
): Point {
  const center = getNodeCenter(node);

  if (position === Position.Left) {
    return { x: node.position.x, y: center.y };
  }
  if (position === Position.Right) {
    return { x: node.position.x + node.measured.width, y: center.y };
  }
  if (position === Position.Top) {
    return { x: center.x, y: node.position.y };
  }
  return { x: center.x, y: node.position.y + node.measured.height };
}

function getSideOffsetPoint(point: Point, side: Position, offset: number): Point {
  if (side === Position.Left) return { x: point.x - offset, y: point.y };
  if (side === Position.Right) return { x: point.x + offset, y: point.y };
  if (side === Position.Top) return { x: point.x, y: point.y - offset };
  return { x: point.x, y: point.y + offset };
}

function dedupePoints(points: Point[]): Point[] {
  return points.filter((point, index) => index === 0 || !pointsEqual(point, points[index - 1]));
}

function toSegments(points: Point[]): Segment[] {
  const segments: Segment[] = [];

  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    if (pointsEqual(start, end)) continue;

    segments.push({
      start,
      end,
      orientation: Math.abs(start.y - end.y) < 0.001 ? 'horizontal' : 'vertical',
    });
  }

  return segments;
}

function getSegmentLength(segment: Segment) {
  return segment.orientation === 'horizontal'
    ? Math.abs(segment.end.x - segment.start.x)
    : Math.abs(segment.end.y - segment.start.y);
}

function getSegmentMidpoint(segment: Segment): Point {
  return {
    x: (segment.start.x + segment.end.x) / 2,
    y: (segment.start.y + segment.end.y) / 2,
  };
}

function getLabelPoint(points: Point[], segments: Segment[]): Point {
  if (segments.length === 0) {
    return points[0] ?? { x: 0, y: 0 };
  }

  const middleSegments = segments.length > 2 ? segments.slice(1, -1) : segments;
  let chosen = middleSegments[0];
  let longest = getSegmentLength(chosen);

  for (const segment of middleSegments.slice(1)) {
    const length = getSegmentLength(segment);
    if (length > longest) {
      chosen = segment;
      longest = length;
    }
  }

  return getSegmentMidpoint(chosen);
}

function buildOrthogonalPoints(
  sourceAnchor: Point,
  targetAnchor: Point,
  sourceSide: Position,
  targetSide: Position,
  clearance = NODE_CLEARANCE
): Point[] {
  const sourceExit = getSideOffsetPoint(sourceAnchor, sourceSide, clearance);
  const targetEntry = getSideOffsetPoint(targetAnchor, targetSide, clearance);

  let points: Point[];

  const sourceHorizontal = sourceSide === Position.Left || sourceSide === Position.Right;
  const targetHorizontal = targetSide === Position.Left || targetSide === Position.Right;

  if (sourceHorizontal && targetHorizontal) {
    const midX = (sourceExit.x + targetEntry.x) / 2;
    points = [
      sourceAnchor,
      sourceExit,
      { x: midX, y: sourceExit.y },
      { x: midX, y: targetEntry.y },
      targetEntry,
      targetAnchor,
    ];
  } else if (!sourceHorizontal && !targetHorizontal) {
    const midY = (sourceExit.y + targetEntry.y) / 2;
    points = [
      sourceAnchor,
      sourceExit,
      { x: sourceExit.x, y: midY },
      { x: targetEntry.x, y: midY },
      targetEntry,
      targetAnchor,
    ];
  } else if (sourceHorizontal) {
    points = [
      sourceAnchor,
      sourceExit,
      { x: targetEntry.x, y: sourceExit.y },
      targetEntry,
      targetAnchor,
    ];
  } else {
    points = [
      sourceAnchor,
      sourceExit,
      { x: sourceExit.x, y: targetEntry.y },
      targetEntry,
      targetAnchor,
    ];
  }

  return dedupePoints(points);
}

function buildOrthogonalPointsWithCorridor(
  sourceAnchor: Point,
  sourceExit: Point,
  targetEntry: Point,
  targetAnchor: Point,
  corridorOrientation: CorridorOrientation,
  corridorCoordinate: number
) {
  if (corridorOrientation === 'vertical') {
    return dedupePoints([
      sourceAnchor,
      sourceExit,
      { x: corridorCoordinate, y: sourceExit.y },
      { x: corridorCoordinate, y: targetEntry.y },
      targetEntry,
      targetAnchor,
    ]);
  }

  return dedupePoints([
    sourceAnchor,
    sourceExit,
    { x: sourceExit.x, y: corridorCoordinate },
    { x: targetEntry.x, y: corridorCoordinate },
    targetEntry,
    targetAnchor,
  ]);
}

function getParallelLaneBias(
  edge: RoutingEdge,
  allEdges: RoutingEdge[],
  sourceSide: Position,
  targetSide: Position,
  getNode: (id: string) => RoutingNode | undefined
) {
  const grouped = allEdges
    .filter((candidate) => {
      if (candidate.source === candidate.target) return false;
      if (candidate.id !== edge.id && candidate.source !== edge.source && candidate.target !== edge.target) {
        return false;
      }

      const candidateSourceNode = getNode(candidate.source);
      const candidateTargetNode = getNode(candidate.target);
      if (!hasMeasuredSize(candidateSourceNode) || !hasMeasuredSize(candidateTargetNode)) {
        return false;
      }

      return (
        getSourceSide(candidateSourceNode, candidateTargetNode) === sourceSide &&
        getTargetSide(candidateSourceNode, candidateTargetNode) === targetSide
      );
    })
    .sort(sortEdgesForLaneGroup);

  const index = grouped.findIndex((candidate) => candidate.id === edge.id);
  if (index < 0 || grouped.length <= 1) {
    return 0;
  }

  return index - (grouped.length - 1) / 2;
}

function buildProtectedOrthogonalPoints(
  edge: RoutingEdge,
  allEdges: RoutingEdge[],
  sourceAnchor: Point,
  targetAnchor: Point,
  sourceSide: Position,
  targetSide: Position,
  getNode: (id: string) => RoutingNode | undefined
) {
  const sourceExit = getSideOffsetPoint(sourceAnchor, sourceSide, PROTECTED_NODE_CLEARANCE);
  const targetEntry = getSideOffsetPoint(targetAnchor, targetSide, PROTECTED_NODE_CLEARANCE);
  const corridorOrientation: CorridorOrientation =
    sourceSide === Position.Left || sourceSide === Position.Right ? 'vertical' : 'horizontal';
  const laneBias = getParallelLaneBias(edge, allEdges, sourceSide, targetSide, getNode);
  const preferredCoordinate =
    corridorOrientation === 'vertical'
      ? (sourceExit.x + targetEntry.x) / 2 + laneBias * PARALLEL_LANE_SPACING
      : (sourceExit.y + targetEntry.y) / 2 + laneBias * PARALLEL_LANE_SPACING;
  return buildOrthogonalPointsWithCorridor(
    sourceAnchor,
    sourceExit,
    targetEntry,
    targetAnchor,
    corridorOrientation,
    preferredCoordinate
  );
}

function buildSelfLoopRoute(
  edge: RoutingEdge,
  allEdges: RoutingEdge[],
  node: RoutingNode & { measured: { width: number; height: number } }
): OrthogonalRoute {
  const selfEdges = allEdges
    .filter((candidate) => candidate.source === edge.source && candidate.target === edge.target)
    .sort((a, b) => getFieldName(a).localeCompare(getFieldName(b)));

  const selfIndex = Math.max(0, selfEdges.findIndex((candidate) => candidate.id === edge.id));
  const verticalOffset = (selfIndex - (selfEdges.length - 1) / 2) * SELF_LOOP_SPACING;

  const start: Point = {
    x: node.position.x + node.measured.width,
    y: node.position.y + node.measured.height / 2 - 14 + verticalOffset,
  };
  const end: Point = {
    x: node.position.x + node.measured.width,
    y: node.position.y + node.measured.height / 2 + 14 + verticalOffset,
  };
  const outerX = start.x + SELF_LOOP_WIDTH;
  const topY = start.y - SELF_LOOP_HEIGHT;
  const bottomY = end.y + SELF_LOOP_HEIGHT;

  const points = dedupePoints([
    start,
    { x: outerX, y: start.y },
    { x: outerX, y: topY },
    { x: outerX + 16, y: topY },
    { x: outerX + 16, y: bottomY },
    { x: outerX, y: bottomY },
    { x: outerX, y: end.y },
    end,
  ]);
  const segments = toSegments(points);
  const labelPoint = { x: outerX + 16, y: (topY + bottomY) / 2 };

  return {
    points,
    segments,
    labelX: labelPoint.x,
    labelY: labelPoint.y,
    sourceCardX: 0,
    sourceCardY: 0,
    targetCardX: 0,
    targetCardY: 0,
    isSelfLoop: true,
  };
}

function getDistributedAnchor(
  edge: RoutingEdge,
  allEdges: RoutingEdge[],
  node: RoutingNode & { measured: { width: number; height: number } },
  side: Position,
  role: 'source' | 'target',
  getNode: (id: string) => RoutingNode | undefined
): Point {
  return getAdaptiveSideAnchor(edge, allEdges, node, side, role, getNode);
}

export function buildOrthogonalRouteMap(
  edges: RoutingEdge[],
  _nodes: RoutingNode[],
  getNode: (id: string) => RoutingNode | undefined,
  options: OrthogonalRoutingOptions = {}
): Map<string, OrthogonalRoute> {
  const routes = new Map<string, OrthogonalRoute>();
  const clearance = options.protectedRouting ? PROTECTED_NODE_CLEARANCE : NODE_CLEARANCE;

  for (const edge of edges) {
    const sourceNode = getNode(edge.source);
    const targetNode = getNode(edge.target);
    if (!hasMeasuredSize(sourceNode) || !hasMeasuredSize(targetNode)) {
      continue;
    }

    if (edge.source === edge.target) {
      routes.set(edge.id, buildSelfLoopRoute(edge, edges, sourceNode));
      continue;
    }

    const sourceSide = getSourceSide(sourceNode, targetNode);
    const targetSide = getTargetSide(sourceNode, targetNode);
    const sourceAnchor = getDistributedAnchor(edge, edges, sourceNode, sourceSide, 'source', getNode);
    const targetAnchor = getDistributedAnchor(edge, edges, targetNode, targetSide, 'target', getNode);
    const points = options.protectedRouting
      ? buildProtectedOrthogonalPoints(
          edge,
          edges,
          sourceAnchor,
          targetAnchor,
          sourceSide,
          targetSide,
          getNode
        )
      : buildOrthogonalPoints(sourceAnchor, targetAnchor, sourceSide, targetSide, clearance);
    const segments = toSegments(points);
    const labelPoint = getLabelPoint(points, segments);
    const sourceCardPoint = getSideOffsetPoint(
      getSideOffsetPoint(sourceAnchor, sourceSide, clearance),
      sourceSide,
      CARDINALITY_OFFSET
    );
    const targetCardPoint = getSideOffsetPoint(
      getSideOffsetPoint(targetAnchor, targetSide, clearance),
      targetSide,
      CARDINALITY_OFFSET
    );

    routes.set(edge.id, {
      points,
      segments,
      labelX: labelPoint.x,
      labelY: labelPoint.y,
      sourceCardX: sourceCardPoint.x,
      sourceCardY: sourceCardPoint.y,
      targetCardX: targetCardPoint.x,
      targetCardY: targetCardPoint.y,
      isSelfLoop: false,
    });
  }

  return routes;
}

function isInteriorCrossing(value: number, start: number, end: number) {
  const min = Math.min(start, end) + LINE_JUMP_ENDPOINT_PADDING;
  const max = Math.max(start, end) - LINE_JUMP_ENDPOINT_PADDING;
  return value > min && value < max;
}

function buildHorizontalSegmentPath(segment: Segment, jumpXs: number[]) {
  const y = segment.start.y;
  const sign = segment.end.x >= segment.start.x ? 1 : -1;
  const sortedJumpXs = [...jumpXs].sort((a, b) => (sign === 1 ? a - b : b - a));

  let path = '';
  let lastJumpX: number | null = null;

  for (const jumpX of sortedJumpXs) {
    if (lastJumpX !== null && Math.abs(jumpX - lastJumpX) < LINE_JUMP_MIN_GAP) {
      continue;
    }
    lastJumpX = jumpX;

    const beforeX = jumpX - sign * LINE_JUMP_RADIUS;
    const afterX = jumpX + sign * LINE_JUMP_RADIUS;
    const cp1X = beforeX + sign * LINE_JUMP_RADIUS * 0.55;
    const cp2X = jumpX - sign * LINE_JUMP_RADIUS * 0.35;
    const cp3X = jumpX + sign * LINE_JUMP_RADIUS * 0.35;
    const cp4X = afterX - sign * LINE_JUMP_RADIUS * 0.55;
    const peakY = y - LINE_JUMP_HEIGHT;

    path += ` L ${beforeX} ${y}`;
    path += ` C ${cp1X} ${y} ${cp2X} ${peakY} ${jumpX} ${peakY}`;
    path += ` C ${cp3X} ${peakY} ${cp4X} ${y} ${afterX} ${y}`;
  }

  path += ` L ${segment.end.x} ${segment.end.y}`;
  return path;
}

export function buildOrthogonalPathWithLineJumps(
  edgeId: string,
  routes: Map<string, OrthogonalRoute>
) {
  const route = routes.get(edgeId);
  if (!route || route.points.length === 0) {
    return '';
  }

  const jumpMap = new Map<number, number[]>();

  route.segments.forEach((segment, segmentIndex) => {
    if (segment.orientation !== 'horizontal') {
      return;
    }

    for (const [otherId, otherRoute] of routes) {
      if (otherId === edgeId || otherRoute.isSelfLoop) continue;

      for (const otherSegment of otherRoute.segments) {
        if (otherSegment.orientation !== 'vertical') continue;

        const intersectionX = otherSegment.start.x;
        const intersectionY = segment.start.y;

        if (
          !isInteriorCrossing(intersectionX, segment.start.x, segment.end.x) ||
          !isInteriorCrossing(intersectionY, otherSegment.start.y, otherSegment.end.y)
        ) {
          continue;
        }

        const jumpXs = jumpMap.get(segmentIndex) ?? [];
        jumpXs.push(intersectionX);
        jumpMap.set(segmentIndex, jumpXs);
      }
    }
  });

  let path = `M ${route.points[0].x} ${route.points[0].y}`;

  route.segments.forEach((segment, segmentIndex) => {
    if (segment.orientation === 'vertical') {
      path += ` L ${segment.end.x} ${segment.end.y}`;
      return;
    }

    const jumpXs = jumpMap.get(segmentIndex) ?? [];
    if (jumpXs.length === 0) {
      path += ` L ${segment.end.x} ${segment.end.y}`;
      return;
    }

    path += buildHorizontalSegmentPath(segment, jumpXs);
  });

  return path;
}

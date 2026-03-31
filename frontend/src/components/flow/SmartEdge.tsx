/**
 * Smart edge that supports both curved rendering and ELK-driven orthogonal paths.
 */

import { memo, useMemo } from 'react';
import {
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  useEdges,
  useNodes,
  type Edge,
  type EdgeProps,
  type Node,
} from '@xyflow/react';
import type { ElkLayoutPath } from '../../utils/layout';
import { useAppStore } from '../../store';

export type EdgeRoutingMode = 'curved' | 'orthogonal';

type RoutingNode = Node<Record<string, unknown>>;
type RoutingEdge = Edge<SmartEdgeData, 'simpleFloating'>;
type ElkPathSection = ElkLayoutPath['sections'][number];

interface EdgePoint {
  x: number;
  y: number;
}

interface NodeSize {
  width: number;
  height: number;
}

interface Segment {
  start: EdgePoint;
  end: EdgePoint;
  orientation: 'horizontal' | 'vertical';
}

interface OrthogonalRoute {
  points: EdgePoint[];
  segments: Segment[];
  isSelfLoop: boolean;
}

// Edge data type
export interface SmartEdgeData {
  fieldName: string;
  relationshipType: 'lookup' | 'master-detail';
  sourceObject: string;
  targetObject: string;
  sourceCardinality?: string;
  targetCardinality?: string;
  edgeIndex?: number;
  totalEdges?: number;
  elkPath?: ElkLayoutPath;
  [key: string]: unknown;
}

export type SmartEdgeType = Edge<SmartEdgeData, 'simpleFloating'>;
type SmartEdgeProps = EdgeProps<SmartEdgeType>;

interface EdgeGeometry {
  edgePath: string;
  labelX: number;
  labelY: number;
  sourceCardX: number;
  sourceCardY: number;
  targetCardX: number;
  targetCardY: number;
  isSelfLoop: boolean;
}

const SIDE_PADDING = 20;
const CARDINALITY_OFFSET = 25;
const LINE_JUMP_RADIUS = 8;
const LINE_JUMP_HEIGHT = 6;
const LINE_JUMP_ENDPOINT_PADDING = 28;
const LINE_JUMP_MIN_GAP = LINE_JUMP_RADIUS * 2 + 8;

function isSamePoint(a: EdgePoint | undefined, b: EdgePoint | undefined) {
  return !!a && !!b && Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function hasMeasuredSize(
  node: RoutingNode | undefined
): node is RoutingNode & { measured: NodeSize } {
  return !!node?.measured?.width && !!node?.measured?.height;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function dedupePoints(points: EdgePoint[]) {
  return points.filter((point, index) => {
    if (index === 0) {
      return true;
    }

    return !isSamePoint(point, points[index - 1]);
  });
}

function hasAxisAlignedConnection(start: EdgePoint, end: EdgePoint) {
  return Math.abs(start.x - end.x) < 0.001 || Math.abs(start.y - end.y) < 0.001;
}

function getOrthogonalCorner(points: EdgePoint[], nextPoint: EdgePoint) {
  const previousPoint = points[points.length - 1];
  const beforePreviousPoint = points[points.length - 2];

  if (!beforePreviousPoint) {
    return { x: nextPoint.x, y: previousPoint.y };
  }

  const previousSegmentIsHorizontal =
    Math.abs(beforePreviousPoint.y - previousPoint.y) < 0.001;

  if (previousSegmentIsHorizontal) {
    return { x: nextPoint.x, y: previousPoint.y };
  }

  return { x: previousPoint.x, y: nextPoint.y };
}

function forceOrthogonalPoints(points: EdgePoint[]) {
  if (points.length < 2) {
    return points;
  }

  const normalizedPoints: EdgePoint[] = [points[0]];

  for (const point of points.slice(1)) {
    const previousPoint = normalizedPoints[normalizedPoints.length - 1];

    if (hasAxisAlignedConnection(previousPoint, point)) {
      normalizedPoints.push(point);
      continue;
    }

    const cornerPoint = getOrthogonalCorner(normalizedPoints, point);
    if (!isSamePoint(previousPoint, cornerPoint)) {
      normalizedPoints.push(cornerPoint);
    }
    normalizedPoints.push(point);
  }

  return simplifyOrthogonalPoints(normalizedPoints);
}

function simplifyOrthogonalPoints(points: EdgePoint[]) {
  const dedupedPoints = dedupePoints(points);

  return dedupedPoints.filter((point, index) => {
    if (index === 0 || index === dedupedPoints.length - 1) {
      return true;
    }

    const previous = dedupedPoints[index - 1];
    const next = dedupedPoints[index + 1];
    const horizontal = Math.abs(previous.y - point.y) < 0.001 && Math.abs(point.y - next.y) < 0.001;
    const vertical = Math.abs(previous.x - point.x) < 0.001 && Math.abs(point.x - next.x) < 0.001;

    return !(horizontal || vertical);
  });
}

function getNodeCenter(node: RoutingNode, size: NodeSize) {
  return {
    x: node.position.x + size.width / 2,
    y: node.position.y + size.height / 2,
  };
}

function getConnectionSides(
  sourceNode: RoutingNode,
  sourceSize: NodeSize,
  targetNode: RoutingNode,
  targetSize: NodeSize
) {
  const sourceCenter = getNodeCenter(sourceNode, sourceSize);
  const targetCenter = getNodeCenter(targetNode, targetSize);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const horizontalDominant = Math.abs(dx) > Math.abs(dy) * 0.5;

  if (horizontalDominant) {
    return dx > 0
      ? { source: Position.Right, target: Position.Left }
      : { source: Position.Left, target: Position.Right };
  }

  return dy > 0
    ? { source: Position.Bottom, target: Position.Top }
    : { source: Position.Top, target: Position.Bottom };
}

function getDistributedAnchor(
  node: RoutingNode,
  size: NodeSize,
  side: Position,
  edgeIndex: number,
  totalEdges: number
): EdgePoint {
  const safeTotalEdges = Math.max(totalEdges, 1);
  const safeIndex = clamp(edgeIndex, 0, safeTotalEdges - 1);

  if (side === Position.Left || side === Position.Right) {
    const minY = node.position.y + SIDE_PADDING;
    const maxY = node.position.y + size.height - SIDE_PADDING;
    const y = safeTotalEdges === 1
      ? node.position.y + size.height / 2
      : minY + ((maxY - minY) * safeIndex) / Math.max(safeTotalEdges - 1, 1);

    return {
      x: side === Position.Left ? node.position.x : node.position.x + size.width,
      y,
    };
  }

  const minX = node.position.x + SIDE_PADDING;
  const maxX = node.position.x + size.width - SIDE_PADDING;
  const x = safeTotalEdges === 1
    ? node.position.x + size.width / 2
    : minX + ((maxX - minX) * safeIndex) / Math.max(safeTotalEdges - 1, 1);

  return {
    x,
    y: side === Position.Top ? node.position.y : node.position.y + size.height,
  };
}

function getSelfLoopAnchor(
  node: RoutingNode,
  size: NodeSize,
  edgeIndex: number,
  totalEdges: number
) {
  return getDistributedAnchor(node, size, Position.Right, edgeIndex, totalEdges);
}

function findSectionContinuation(
  sections: ElkPathSection[],
  visitedSectionIds: Set<string>,
  currentSectionEndPoint: EdgePoint
) {
  return sections.find((section) =>
    !visitedSectionIds.has(section.id) &&
    isSamePoint(section.startPoint, currentSectionEndPoint)
  );
}

function orderElkSections(elkPath: ElkLayoutPath | undefined) {
  if (!elkPath?.sections?.length) {
    return [];
  }

  const sections = elkPath.sections;
  const sectionsById = new Map(sections.map((section) => [section.id, section]));
  const visitedSectionIds = new Set<string>();
  const orderedSections: ElkPathSection[] = [];
  const rootSections = sections.filter((section) =>
    !(section.incomingSections ?? []).some((sectionId) => sectionsById.has(sectionId))
  );

  function appendSectionChain(startSection: ElkPathSection) {
    let currentSection: ElkPathSection | undefined = startSection;

    while (currentSection && !visitedSectionIds.has(currentSection.id)) {
      visitedSectionIds.add(currentSection.id);
      orderedSections.push(currentSection);

      const linkedSections: ElkPathSection[] = (currentSection.outgoingSections ?? [])
        .map((sectionId) => sectionsById.get(sectionId))
        .filter((section): section is ElkPathSection =>
          !!section && !visitedSectionIds.has(section.id)
        );
      const nextLinkedSection: ElkPathSection | undefined = linkedSections[0];

      currentSection =
        nextLinkedSection ??
        findSectionContinuation(sections, visitedSectionIds, currentSection.endPoint);
    }
  }

  for (const rootSection of rootSections) {
    appendSectionChain(rootSection);
  }

  for (const section of sections) {
    if (!visitedSectionIds.has(section.id)) {
      appendSectionChain(section);
    }
  }

  return orderedSections;
}

function flattenElkPoints(elkPath: ElkLayoutPath | undefined) {
  const orderedSections = orderElkSections(elkPath);
  const points: EdgePoint[] = [];

  for (const section of orderedSections) {
    const sectionPoints = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ];

    for (const point of sectionPoints) {
      if (!isSamePoint(points[points.length - 1], point)) {
        points.push(point);
      }
    }
  }

  return forceOrthogonalPoints(points);
}

function getOrthogonalBridgeFromAnchor(
  anchor: EdgePoint,
  targetPoint: EdgePoint,
  side: Position
) {
  if (Math.abs(anchor.x - targetPoint.x) < 0.001 || Math.abs(anchor.y - targetPoint.y) < 0.001) {
    return null;
  }

  if (side === Position.Left || side === Position.Right) {
    return { x: targetPoint.x, y: anchor.y };
  }

  return { x: anchor.x, y: targetPoint.y };
}

function getOrthogonalBridgeToAnchor(
  sourcePoint: EdgePoint,
  anchor: EdgePoint,
  side: Position
) {
  if (Math.abs(anchor.x - sourcePoint.x) < 0.001 || Math.abs(anchor.y - sourcePoint.y) < 0.001) {
    return null;
  }

  if (side === Position.Left || side === Position.Right) {
    return { x: sourcePoint.x, y: anchor.y };
  }

  return { x: anchor.x, y: sourcePoint.y };
}

function buildFallbackOrthogonalPoints(
  sourceAnchor: EdgePoint,
  targetAnchor: EdgePoint,
  sourceSide: Position,
  targetSide: Position
) {
  if (Math.abs(sourceAnchor.x - targetAnchor.x) < 0.001 || Math.abs(sourceAnchor.y - targetAnchor.y) < 0.001) {
    return [sourceAnchor, targetAnchor];
  }

  const sourceBridge = getOrthogonalBridgeFromAnchor(sourceAnchor, targetAnchor, sourceSide);
  const targetBridge = getOrthogonalBridgeToAnchor(sourceAnchor, targetAnchor, targetSide);

  return simplifyOrthogonalPoints(
    [
      sourceAnchor,
      ...(sourceBridge ? [sourceBridge] : []),
      ...(targetBridge ? [targetBridge] : []),
      targetAnchor,
    ]
  );
}

function toSegments(points: EdgePoint[]) {
  const segments: Segment[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];

    if (isSamePoint(start, end)) {
      continue;
    }

    const orientation = Math.abs(start.x - end.x) < 0.001 ? 'vertical' : 'horizontal';
    segments.push({ start, end, orientation });
  }

  return segments;
}

function getPolylineLength(points: EdgePoint[]) {
  let totalLength = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
  }

  return totalLength;
}

function getPointAlongPolyline(points: EdgePoint[], distance: number) {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  if (points.length === 1 || distance <= 0) {
    return points[0];
  }

  let remainingDistance = distance;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);

    if (segmentLength === 0) {
      continue;
    }

    if (remainingDistance <= segmentLength) {
      const ratio = remainingDistance / segmentLength;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }

    remainingDistance -= segmentLength;
  }

  return points[points.length - 1];
}

function getPolylineMidpoint(points: EdgePoint[]) {
  return getPointAlongPolyline(points, getPolylineLength(points) / 2);
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

function buildOrthogonalPathWithLineJumps(
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
      if (otherId === edgeId || otherRoute.isSelfLoop) {
        continue;
      }

      for (const otherSegment of otherRoute.segments) {
        if (otherSegment.orientation !== 'vertical') {
          continue;
        }

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

function buildCurrentOrthogonalRoute(
  edge: RoutingEdge,
  nodeById: Map<string, RoutingNode>
) {
  const sourceNode = nodeById.get(edge.source);
  const targetNode = nodeById.get(edge.target);

  if (!hasMeasuredSize(sourceNode) || !hasMeasuredSize(targetNode)) {
    return null;
  }

  const edgeIndex = edge.data?.edgeIndex ?? 0;
  const totalEdges = edge.data?.totalEdges ?? 1;
  const elkPoints = flattenElkPoints(edge.data?.elkPath);

  if (edge.source === edge.target) {
    if (elkPoints.length < 2) {
      return null;
    }

    const currentAnchor = getSelfLoopAnchor(sourceNode, sourceNode.measured, edgeIndex, totalEdges);
    const deltaX = currentAnchor.x - elkPoints[0].x;
    const deltaY = currentAnchor.y - elkPoints[0].y;
    const translatedPoints = elkPoints.map((point) => ({
      x: point.x + deltaX,
      y: point.y + deltaY,
    }));
    const points = forceOrthogonalPoints(translatedPoints);

    return {
      points,
      segments: toSegments(points),
      isSelfLoop: true,
    };
  }

  const { source: sourceSide, target: targetSide } = getConnectionSides(
    sourceNode,
    sourceNode.measured,
    targetNode,
    targetNode.measured
  );
  const sourceAnchor = getDistributedAnchor(
    sourceNode,
    sourceNode.measured,
    sourceSide,
    edgeIndex,
    totalEdges
  );
  const targetAnchor = getDistributedAnchor(
    targetNode,
    targetNode.measured,
    targetSide,
    edgeIndex,
    totalEdges
  );

  if (elkPoints.length < 2) {
    const points = forceOrthogonalPoints(
      buildFallbackOrthogonalPoints(sourceAnchor, targetAnchor, sourceSide, targetSide)
    );
    return {
      points,
      segments: toSegments(points),
      isSelfLoop: false,
    };
  }

  const innerPoints = elkPoints.slice(1, -1);
  const firstInnerPoint = innerPoints[0] ?? elkPoints[1];
  const lastInnerPoint = innerPoints[innerPoints.length - 1] ?? elkPoints[elkPoints.length - 2];
  const sourceBridge = firstInnerPoint
    ? getOrthogonalBridgeFromAnchor(sourceAnchor, firstInnerPoint, sourceSide)
    : null;
  const targetBridge = lastInnerPoint
    ? getOrthogonalBridgeToAnchor(lastInnerPoint, targetAnchor, targetSide)
    : null;
  const points = forceOrthogonalPoints([
    sourceAnchor,
    ...(sourceBridge ? [sourceBridge] : []),
    ...innerPoints,
    ...(targetBridge ? [targetBridge] : []),
    targetAnchor,
  ]);

  return {
    points,
    segments: toSegments(points),
    isSelfLoop: false,
  };
}

function buildOrthogonalRouteMap(
  edges: RoutingEdge[],
  nodeById: Map<string, RoutingNode>
) {
  const routes = new Map<string, OrthogonalRoute>();

  for (const edge of edges) {
    const route = buildCurrentOrthogonalRoute(edge, nodeById);
    if (route) {
      routes.set(edge.id, route);
    }
  }

  return routes;
}

function buildOrthogonalGeometry(
  edgeId: string,
  routes: Map<string, OrthogonalRoute>
): EdgeGeometry | null {
  const route = routes.get(edgeId);
  if (!route || route.points.length < 2) {
    return null;
  }

  const label = getPolylineMidpoint(route.points);
  const sourceCard = getPointAlongPolyline(route.points, CARDINALITY_OFFSET);
  const targetCard = getPointAlongPolyline([...route.points].reverse(), CARDINALITY_OFFSET);

  return {
    edgePath: buildOrthogonalPathWithLineJumps(edgeId, routes),
    labelX: label.x,
    labelY: label.y,
    sourceCardX: sourceCard.x,
    sourceCardY: sourceCard.y,
    targetCardX: targetCard.x,
    targetCardY: targetCard.y,
    isSelfLoop: route.isSelfLoop,
  };
}

function SmartEdge({
  id,
  source,
  target,
  data,
  selected,
}: SmartEdgeProps) {
  const allNodes = useNodes<RoutingNode>();
  const allEdges = useEdges<SmartEdgeType>();
  const animateEdges = useAppStore((state) => state.badgeSettings.animateEdges);
  const showEdgeLabels = useAppStore((state) => state.badgeSettings.showEdgeLabels);
  const edgeRoutingMode = useAppStore((state) => state.edgeRoutingMode);

  const nodeById = useMemo(
    () => new Map(allNodes.map((node) => [node.id, node])),
    [allNodes]
  );
  const sourceNode = nodeById.get(source);
  const targetNode = nodeById.get(target);

  const curvedGeometry = useMemo((): EdgeGeometry | null => {
    if (!hasMeasuredSize(sourceNode) || !hasMeasuredSize(targetNode)) {
      return null;
    }

    const sourceWidth = sourceNode.measured.width;
    const sourceHeight = sourceNode.measured.height;

    if (source === target) {
      const loopWidth = 60;
      const loopHeight = 50;

      const selfEdges = allEdges
        .filter((edge) => edge.source === source && edge.target === target)
        .sort((a, b) => {
          const aField = (a.data as SmartEdgeData | undefined)?.fieldName ?? '';
          const bField = (b.data as SmartEdgeData | undefined)?.fieldName ?? '';
          return aField.localeCompare(bField);
        });

      const selfEdgeIndex = selfEdges.findIndex((edge) => edge.id === id);
      const totalSelfEdges = selfEdges.length;
      const verticalOffset =
        (selfEdgeIndex - (totalSelfEdges - 1) / 2) * (loopHeight + 20);

      const startX = sourceNode.position.x + sourceWidth;
      const startY = sourceNode.position.y + sourceHeight / 2 - 15 + verticalOffset;
      const endX = sourceNode.position.x + sourceWidth;
      const endY = sourceNode.position.y + sourceHeight / 2 + 15 + verticalOffset;
      const cp1X = startX + loopWidth;
      const cp1Y = startY - loopHeight / 2;
      const cp2X = endX + loopWidth;
      const cp2Y = endY + loopHeight / 2;

      return {
        edgePath: `M ${startX} ${startY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${endX} ${endY}`,
        labelX: startX + loopWidth + 10,
        labelY: (startY + endY) / 2,
        sourceCardX: 0,
        sourceCardY: 0,
        targetCardX: 0,
        targetCardY: 0,
        isSelfLoop: true,
      };
    }

    const { source: sourcePos, target: targetPos } = getConnectionSides(
      sourceNode,
      sourceNode.measured,
      targetNode,
      targetNode.measured
    );
    const edgeIndex = data?.edgeIndex ?? 0;
    const totalEdges = data?.totalEdges ?? 1;
    const sourceAnchor = getDistributedAnchor(
      sourceNode,
      sourceNode.measured,
      sourcePos,
      edgeIndex,
      totalEdges
    );
    const targetAnchor = getDistributedAnchor(
      targetNode,
      targetNode.measured,
      targetPos,
      edgeIndex,
      totalEdges
    );
    const [edgePath, labelX, labelY] = getBezierPath({
      sourceX: sourceAnchor.x,
      sourceY: sourceAnchor.y,
      sourcePosition: sourcePos,
      targetX: targetAnchor.x,
      targetY: targetAnchor.y,
      targetPosition: targetPos,
    });

    const sourceCard = {
      x: sourcePos === Position.Left || sourcePos === Position.Right
        ? sourceAnchor.x + (sourcePos === Position.Right ? CARDINALITY_OFFSET : -CARDINALITY_OFFSET)
        : sourceAnchor.x,
      y: sourcePos === Position.Top || sourcePos === Position.Bottom
        ? sourceAnchor.y + (sourcePos === Position.Bottom ? CARDINALITY_OFFSET : -CARDINALITY_OFFSET)
        : sourceAnchor.y,
    };
    const targetCard = {
      x: targetPos === Position.Left || targetPos === Position.Right
        ? targetAnchor.x + (targetPos === Position.Right ? CARDINALITY_OFFSET : -CARDINALITY_OFFSET)
        : targetAnchor.x,
      y: targetPos === Position.Top || targetPos === Position.Bottom
        ? targetAnchor.y + (targetPos === Position.Bottom ? CARDINALITY_OFFSET : -CARDINALITY_OFFSET)
        : targetAnchor.y,
    };

    return {
      edgePath,
      labelX,
      labelY,
      sourceCardX: sourceCard.x,
      sourceCardY: sourceCard.y,
      targetCardX: targetCard.x,
      targetCardY: targetCard.y,
      isSelfLoop: false,
    };
  }, [
    allEdges,
    data?.edgeIndex,
    data?.totalEdges,
    id,
    source,
    sourceNode,
    target,
    targetNode,
  ]);

  const orthogonalGeometry = useMemo(() => {
    const routes = buildOrthogonalRouteMap(allEdges, nodeById);
    return buildOrthogonalGeometry(id, routes);
  }, [allEdges, id, nodeById]);

  const edgeGeometry =
    edgeRoutingMode === 'orthogonal' ? orthogonalGeometry ?? curvedGeometry : curvedGeometry;

  if (!edgeGeometry) {
    return null;
  }

  const {
    edgePath,
    labelX,
    labelY,
    sourceCardX,
    sourceCardY,
    targetCardX,
    targetCardY,
    isSelfLoop,
  } = edgeGeometry;
  const isMasterDetail = data?.relationshipType === 'master-detail';
  const sourceCard = data?.sourceCardinality || 'N';
  const targetCard = data?.targetCardinality || '1';

  return (
    <>
      <path
        id={id}
        className={`relationship-edge ${isMasterDetail ? 'master-detail' : 'lookup'} ${selected ? 'selected' : ''} ${animateEdges ? 'animated' : ''}`}
        d={edgePath}
        markerEnd={`url(#${isMasterDetail ? 'arrow-filled' : 'arrow-hollow'})`}
      />

      <EdgeLabelRenderer>
        {!isSelfLoop && (
          <>
            <div
              className="cardinality-label source"
              style={{
                transform: `translate(-50%, -50%) translate(${sourceCardX}px, ${sourceCardY}px)`,
              }}
            >
              {sourceCard}
            </div>
            <div
              className="cardinality-label target"
              style={{
                transform: `translate(-50%, -50%) translate(${targetCardX}px, ${targetCardY}px)`,
              }}
            >
              {targetCard}
            </div>
          </>
        )}

        {showEdgeLabels && (
          <div
            className={`edge-label ${isMasterDetail ? 'master-detail' : 'lookup'} ${selected ? 'selected' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <span className="field-name">{data?.fieldName}</span>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export default memo(SmartEdge);

export type RelationshipEdgeData = SmartEdgeData;
export type RelationshipEdgeType = SmartEdgeType;

export function EdgeMarkerDefs() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        <marker
          id="arrow-filled"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#DC2626" />
        </marker>

        <marker
          id="arrow-hollow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="none" stroke="#0176D3" strokeWidth="1.5" />
        </marker>
      </defs>
    </svg>
  );
}

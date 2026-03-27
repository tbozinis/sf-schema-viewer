/**
 * Smart edge that supports both curved and orthogonal routing modes.
 */

import { memo, useMemo } from 'react';
import {
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  useReactFlow,
  type Edge,
  type Node,
  type EdgeProps,
} from '@xyflow/react';
import { useAppStore } from '../../store';
import {
  buildOrthogonalPathWithLineJumps,
  buildOrthogonalRouteMap,
  getAdaptiveSideAnchor,
  type EdgeRoutingMode,
} from './edgeRouting';

// Edge data type
export interface SmartEdgeData {
  fieldName: string;
  relationshipType: 'lookup' | 'master-detail';
  sourceObject: string;
  targetObject: string;
  sourceCardinality?: string;
  targetCardinality?: string;
  // For multiple edges between same nodes - enables visual offset
  edgeIndex?: number;
  totalEdges?: number;
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

function SmartEdge({
  id,
  source,
  target,
  data,
  selected,
}: SmartEdgeProps) {
  const { getNode, getNodes, getEdges } = useReactFlow();
  const animateEdges = useAppStore((state) => state.badgeSettings.animateEdges);
  const showEdgeLabels = useAppStore((state) => state.badgeSettings.showEdgeLabels);
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const edgeRoutingMode = useAppStore((state) => state.edgeRoutingMode);
  const orthogonalProtectedRouting = useAppStore((state) => state.orthogonalProtectedRouting);

  const sourceNode = getNode(source);
  const targetNode = getNode(target);
  const effectiveRoutingMode: EdgeRoutingMode =
    activeWorkspace === 'core' ? edgeRoutingMode : 'curved';

  const curvedGeometry = useMemo((): EdgeGeometry | null => {
    if (!sourceNode || !targetNode) {
      return null;
    }

    if (!sourceNode.measured?.width || !targetNode.measured?.width) {
      return null;
    }

    const sourceWidth = sourceNode.measured.width;
    const sourceHeight = sourceNode.measured.height!;
    const targetWidth = targetNode.measured.width;
    const targetHeight = targetNode.measured.height!;

    if (source === target) {
      const loopWidth = 60;
      const loopHeight = 50;

      const allEdges = getEdges();
      const selfEdges = allEdges.filter((edge) => edge.source === source && edge.target === target);
      selfEdges.sort((a, b) => {
        const aField = (a.data as SmartEdgeData | undefined)?.fieldName ?? '';
        const bField = (b.data as SmartEdgeData | undefined)?.fieldName ?? '';
        return aField.localeCompare(bField);
      });

      const selfEdgeIndex = selfEdges.findIndex((edge) => edge.id === id);
      const totalSelfEdges = selfEdges.length;
      const verticalOffset = (selfEdgeIndex - (totalSelfEdges - 1) / 2) * (loopHeight + 20);

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

    const sourceCenterX = sourceNode.position.x + sourceWidth / 2;
    const sourceCenterY = sourceNode.position.y + sourceHeight / 2;
    const targetCenterX = targetNode.position.x + targetWidth / 2;
    const targetCenterY = targetNode.position.y + targetHeight / 2;
    const dx = targetCenterX - sourceCenterX;
    const dy = targetCenterY - sourceCenterY;
    const horizontalDominant = Math.abs(dx) > Math.abs(dy) * 0.5;

    let sourceX: number;
    let sourceY: number;
    let targetX: number;
    let targetY: number;
    let sourcePos: Position;
    let targetPos: Position;

    if (horizontalDominant) {
      if (dx > 0) {
        sourcePos = Position.Right;
        sourceX = sourceNode.position.x + sourceWidth;
        sourceY = sourceCenterY;
        targetPos = Position.Left;
        targetX = targetNode.position.x;
        targetY = targetCenterY;
      } else {
        sourcePos = Position.Left;
        sourceX = sourceNode.position.x;
        sourceY = sourceCenterY;
        targetPos = Position.Right;
        targetX = targetNode.position.x + targetWidth;
        targetY = targetCenterY;
      }
    } else if (dy > 0) {
      sourcePos = Position.Bottom;
      sourceX = sourceCenterX;
      sourceY = sourceNode.position.y + sourceHeight;
      targetPos = Position.Top;
      targetX = targetCenterX;
      targetY = targetNode.position.y;
    } else {
      sourcePos = Position.Top;
      sourceX = sourceCenterX;
      sourceY = sourceNode.position.y;
      targetPos = Position.Bottom;
      targetX = targetCenterX;
      targetY = targetNode.position.y + targetHeight;
    }

    const allEdges = getEdges() as Edge<Record<string, unknown>>[];
    const sourceAnchor = getAdaptiveSideAnchor(
      { id, source, target, data: (data as Record<string, unknown> | undefined) ?? {} } as Edge<Record<string, unknown>>,
      allEdges,
      sourceNode as Node<Record<string, unknown>> & { measured: { width: number; height: number } },
      sourcePos,
      'source',
      (nodeId) => getNode(nodeId) as Node<Record<string, unknown>> | undefined
    );
    const targetAnchor = getAdaptiveSideAnchor(
      { id, source, target, data: (data as Record<string, unknown> | undefined) ?? {} } as Edge<Record<string, unknown>>,
      allEdges,
      targetNode as Node<Record<string, unknown>> & { measured: { width: number; height: number } },
      targetPos,
      'target',
      (nodeId) => getNode(nodeId) as Node<Record<string, unknown>> | undefined
    );

    sourceX = sourceAnchor.x;
    sourceY = sourceAnchor.y;
    targetX = targetAnchor.x;
    targetY = targetAnchor.y;

    const [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition: sourcePos,
      targetX,
      targetY,
      targetPosition: targetPos,
    });

    const cardinalityOffset = 25;
    let sourceCardX = sourceX;
    let sourceCardY = sourceY;
    let targetCardX = targetX;
    let targetCardY = targetY;

    if (sourcePos === Position.Right) sourceCardX += cardinalityOffset;
    if (sourcePos === Position.Left) sourceCardX -= cardinalityOffset;
    if (sourcePos === Position.Top) sourceCardY -= cardinalityOffset;
    if (sourcePos === Position.Bottom) sourceCardY += cardinalityOffset;
    if (targetPos === Position.Right) targetCardX += cardinalityOffset;
    if (targetPos === Position.Left) targetCardX -= cardinalityOffset;
    if (targetPos === Position.Top) targetCardY -= cardinalityOffset;
    if (targetPos === Position.Bottom) targetCardY += cardinalityOffset;

    return {
      edgePath,
      labelX,
      labelY,
      sourceCardX,
      sourceCardY,
      targetCardX,
      targetCardY,
      isSelfLoop: false,
    };
  }, [
    id,
    source,
    target,
    sourceNode?.position.x,
    sourceNode?.position.y,
    sourceNode?.measured?.width,
    sourceNode?.measured?.height,
    targetNode?.position.x,
    targetNode?.position.y,
    targetNode?.measured?.width,
    targetNode?.measured?.height,
    getEdges,
    getNode,
    (data as Record<string, unknown> | undefined)?._refresh,
  ]);

  const orthogonalGeometry = useMemo((): EdgeGeometry | null => {
    if (!sourceNode || !targetNode || !sourceNode.measured?.width || !targetNode.measured?.width) {
      return null;
    }

    const routes = buildOrthogonalRouteMap(
      getEdges() as Edge<Record<string, unknown>>[],
      getNodes() as Node<Record<string, unknown>>[],
      (nodeId) => getNode(nodeId) as Node<Record<string, unknown>> | undefined
      ,
      { protectedRouting: orthogonalProtectedRouting }
    );
    const route = routes.get(id);
    if (!route) {
      return null;
    }

    return {
      edgePath: buildOrthogonalPathWithLineJumps(id, routes),
      labelX: route.labelX,
      labelY: route.labelY,
      sourceCardX: route.sourceCardX,
      sourceCardY: route.sourceCardY,
      targetCardX: route.targetCardX,
      targetCardY: route.targetCardY,
      isSelfLoop: route.isSelfLoop,
    };
  }, [
    id,
    sourceNode?.position.x,
    sourceNode?.position.y,
    sourceNode?.measured?.width,
    sourceNode?.measured?.height,
    targetNode?.position.x,
    targetNode?.position.y,
    targetNode?.measured?.width,
    targetNode?.measured?.height,
    getEdges,
    getNodes,
    getNode,
    orthogonalProtectedRouting,
    (data as Record<string, unknown> | undefined)?._refresh,
  ]);

  const edgeGeometry =
    effectiveRoutingMode === 'orthogonal' ? orthogonalGeometry ?? curvedGeometry : curvedGeometry;

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

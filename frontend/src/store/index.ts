/**
 * Zustand store for application state management.
 */

import { create } from 'zustand';
import type { Node, Edge } from '@xyflow/react';
import type {
  ApiVersionInfo,
  AuthStatus,
  FieldMetadataInfo,
  ObjectBasicInfo,
  ObjectDescribe,
  ObjectEnrichmentInfo,
} from '../types/schema';
import type {
  DataCloudEntityBasicInfo,
  DataCloudEntityDescribe,
  DataCloudEntityType,
} from '../types/datacloud';
import type { ObjectNodeData } from '../components/flow/ObjectNode';
import type { EdgeRoutingMode } from '../components/flow/SmartEdge';
import { api } from '../api/client';
import { transformToFlowElements } from '../utils/transformers';
import { applyElkLayout } from '../utils/layout';
import { CLOUD_PACKS } from '../data/cloudPacks';

/**
 * Workspace type - determines which view is active
 */
export type Workspace = 'core' | 'datacloud';

/**
 * Object type filter state - controls visibility of system object types.
 * true = show the object type, false = hide it
 */
interface ObjectTypeFilters {
  feed: boolean;           // *Feed objects (Chatter feeds)
  share: boolean;          // *Share objects (sharing rules)
  history: boolean;        // *History objects (field history)
  changeEvent: boolean;    // *ChangeEvent objects (CDC)
  platformEvent: boolean;  // *__e objects (platform events)
  externalObject: boolean; // *__x objects (external objects)
  customMetadata: boolean; // *__mdt objects (custom metadata types)
  bigObject: boolean;      // *__b objects (big objects)
  tag: boolean;            // *Tag objects (tagging)
}

/** Default filter state - all system objects hidden by default */
const DEFAULT_OBJECT_TYPE_FILTERS: ObjectTypeFilters = {
  feed: false,
  share: false,
  history: false,
  changeEvent: false,
  platformEvent: false,
  externalObject: false,
  customMetadata: false,
  bigObject: false,
  tag: false,
};

/**
 * Classification filter state - controls visibility of object classification types.
 * true = show the classification, false = hide it (multi-select)
 */
interface ClassificationFilters {
  standard: boolean;   // Salesforce-provided objects (Account, Contact, etc.)
  custom: boolean;     // Org-created custom objects (without namespace)
  packaged: boolean;   // Managed package objects (with namespace_prefix)
}

/** Default classification - show all object types */
const DEFAULT_CLASSIFICATION_FILTERS: ClassificationFilters = {
  standard: true,
  custom: true,
  packaged: true,
};

/**
 * Release stats for version comparison - shows new object counts per release
 */
interface ReleaseStat {
  version: string;           // e.g., "65.0"
  label: string;             // e.g., "Winter '26"
  newCount: number;          // Number of new objects in this release
  newObjectNames: string[];  // Actual object API names (for popup modal)
}

/**
 * Badge display settings - controls which metadata badges are shown on nodes
 */
export interface BadgeDisplaySettings {
  showInternalSharing: boolean;   // Show internal OWD sharing badge
  showExternalSharing: boolean;   // Show external OWD sharing badge
  showRecordCount: boolean;       // Show record count badge (with [LDV] suffix for large data volumes)
  animateEdges: boolean;          // Animate relationship lines (marching ants effect)
  showEdgeLabels: boolean;        // Show field name labels on relationship lines
  compactMode: boolean;           // Hide field lists on nodes for cleaner overview
  showAllConnections: boolean;    // Show all edges between object pairs (vs single representative)
  showSelfReferences: boolean;    // Show self-referential edges (e.g., Account.ParentId → Account)
}

const DEFAULT_EDGE_ROUTING_MODE: EdgeRoutingMode = 'curved';

/** Default badge settings - show internal sharing, record counts, animation, and edge labels by default */
const DEFAULT_BADGE_SETTINGS: BadgeDisplaySettings = {
  showInternalSharing: true,
  showExternalSharing: false,
  showRecordCount: true,
  animateEdges: true,
  showEdgeLabels: true,
  compactMode: false,
  showAllConnections: false,  // Default: single edge for cleaner diagrams
  showSelfReferences: false,  // Default: hide self-referential edges
};

/**
 * Export settings - controls export format options
 */
export interface ExportSettings {
  resolution: 1 | 2 | 3;                    // Resolution multiplier (1x, 2x, 3x)
  background: 'white' | 'transparent';      // Background color
  includeLegend: boolean;                   // Include legend panel in export
}

/** Default export settings - 2x resolution, white background, include legend */
const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolution: 2,
  background: 'white',
  includeLegend: true,
};

let latestCoreLayoutRequestId = 0;
let latestDcLayoutRequestId = 0;

function normalizeRelationshipType(
  value: string | undefined
): 'lookup' | 'master-detail' {
  return value?.toLowerCase() === 'master-detail' ? 'master-detail' : 'lookup';
}

function buildDataCloudFlowElements(
  selectedEntityNames: string[],
  describedEntities: Map<string, DataCloudEntityDescribe>,
  showSelfReferences: boolean
) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const name of selectedEntityNames) {
    const entity = describedEntities.get(name);
    if (!entity) continue;

    nodes.push({
      id: name,
      type: 'dataCloudNode',
      position: { x: 0, y: 0 },
      data: {
        label: entity.display_name || entity.name,
        apiName: entity.name,
        entityType: entity.entity_type,
        category: entity.category,
        isStandard: entity.is_standard,
        fields: entity.fields,
        primaryKeys: entity.primary_keys,
        collapsed: false,
      },
    });
  }

  for (const name of selectedEntityNames) {
    const entity = describedEntities.get(name);
    if (!entity) continue;

    for (const rel of entity.relationships) {
      if (!selectedEntityNames.includes(rel.to_entity)) {
        continue;
      }

      if (name === rel.to_entity && !showSelfReferences) {
        continue;
      }

      edges.push({
        id: `${name}-${rel.from_field}-${rel.to_entity}`,
        source: name,
        target: rel.to_entity,
        type: 'simpleFloating',
        data: {
          fieldName: rel.from_field,
          relationshipType: normalizeRelationshipType(rel.relationship_type),
          sourceObject: name,
          targetObject: rel.to_entity,
        },
      });
    }
  }

  return { nodes, edges };
}

interface AppState {
  // Auth state
  authStatus: AuthStatus | null;
  isLoadingAuth: boolean;

  // API version state
  apiVersion: string | null;  // Selected version (e.g., "v62.0"), null = use default
  availableApiVersions: ApiVersionInfo[];
  isLoadingApiVersions: boolean;

  // New objects detection state (version comparison)
  newObjectNames: Set<string>;           // Objects new in current version vs previous
  isLoadingNewObjects: boolean;          // Loading state for comparison
  releaseStats: ReleaseStat[];           // New object counts for last 9 releases (~3 years)
  showOnlyNew: boolean;                  // Filter toggle for showing only new objects

  // Schema state
  availableObjects: ObjectBasicInfo[];
  selectedObjectNames: string[];
  describedObjects: Map<string, ObjectDescribe>;
  isLoadingObjects: boolean;
  isLoadingDescribe: boolean;
  isCoreLayouting: boolean;
  objectsLoadTime: number | null;  // Time in seconds for last loadObjects call

  // Flow state
  nodes: Node[];
  edges: Edge[];
  layoutSyncToken: number;

  // UI state
  sidebarOpen: boolean;
  sidebarWidth: number;
  detailPanelWidth: number;
  classificationFilters: ClassificationFilters;  // Multi-select classification (Standard, Custom, Packaged)
  selectedNamespaces: string[];  // For filtering specific package namespaces when packaged is ON
  searchTerm: string;
  objectTypeFilters: ObjectTypeFilters;
  showLegend: boolean;
  focusedObjectName: string | null;  // Object shown in detail panel
  advancedFiltersExpanded: boolean;  // Collapsible advanced filters section

  // Field selection state - which fields to show in ERD for each object
  selectedFieldsByObject: Map<string, Set<string>>;

  // Child relationship selection state - tracks which child relationships were explicitly selected
  // Key: parent object name, Value: Set of "ChildObject.FieldName" relationship keys
  // Used to filter edges when objects are added via child relationships tab
  selectedChildRelsByParent: Map<string, Set<string>>;

  // Relationship type overrides - stores cascade_delete from child relationships
  // Key: "ChildObject.FieldName", Value: cascade_delete boolean (true = master-detail)
  // Used to determine accurate MD/Lookup type in diagram (fixes divergence with panel badge)
  relationshipTypeByKey: Map<string, boolean>;

  // Object enrichment state (OWD, record counts - loaded asynchronously)
  objectEnrichment: Map<string, ObjectEnrichmentInfo>;
  enrichmentLoading: Set<string>;  // Object names currently being enriched

  // Field metadata state (Tier 2 - indexed fields, data classification, etc.)
  // Key format: "ObjectName.FieldName" -> FieldMetadataInfo
  fieldMetadata: Map<string, FieldMetadataInfo>;

  // Badge display settings (controls which metadata badges appear on nodes)
  badgeSettings: BadgeDisplaySettings;
  edgeRoutingMode: EdgeRoutingMode;
  showSettingsDropdown: boolean;

  // Export state
  exportSettings: ExportSettings;
  showExportDropdown: boolean;
  isExporting: boolean;

  // Error state
  error: string | null;

  // ===== WORKSPACE STATE =====
  activeWorkspace: Workspace;

  // ===== DATA CLOUD STATE =====
  // DC status
  dcIsEnabled: boolean | null;  // null = not checked yet
  dcIsCheckingStatus: boolean;

  // DC entities (mirrors Core pattern)
  dcAvailableEntities: DataCloudEntityBasicInfo[];
  dcSelectedEntityNames: string[];
  dcDescribedEntities: Map<string, DataCloudEntityDescribe>;
  dcIsLoadingEntities: boolean;
  dcIsLoadingDescribe: boolean;
  isDcLayouting: boolean;

  // DC flow (separate from Core)
  dcNodes: Node[];
  dcEdges: Edge[];

  // DC UI state
  dcFocusedEntityName: string | null;
  dcSearchTerm: string;
  dcEntityTypeFilter: Set<DataCloudEntityType>;

  // Actions
  checkAuth: () => Promise<void>;
  logout: () => Promise<void>;
  loadApiVersions: () => Promise<void>;
  setApiVersion: (version: string | null) => void;
  loadObjects: () => Promise<void>;
  loadNewObjectsComparison: () => Promise<void>;  // Fetches previous version & computes diff
  setShowOnlyNew: (show: boolean) => void;        // Toggle "show only new" filter
  selectObjects: (names: string[]) => Promise<void>;
  addObject: (name: string) => Promise<void>;
  removeObject: (name: string) => void;
  applyCoreLayout: () => Promise<void>;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setDetailPanelWidth: (width: number) => void;
  toggleClassificationFilter: (filter: keyof ClassificationFilters) => void;
  setSelectedNamespaces: (namespaces: string[]) => void;
  toggleNamespace: (namespace: string) => void;
  setSearchTerm: (term: string) => void;
  toggleObjectTypeFilter: (filter: keyof ObjectTypeFilters) => void;
  showAllObjectTypes: () => void;
  hideAllSystemObjects: () => void;
  toggleLegend: () => void;
  setFocusedObject: (name: string | null) => void;
  toggleAdvancedFilters: () => void;
  // Field selection actions
  describeObject: (name: string) => Promise<void>;  // Fetch-only, doesn't add to ERD
  toggleFieldSelection: (objectName: string, fieldName: string) => void;
  selectAllFields: (objectName: string) => void;
  clearFieldSelection: (objectName: string) => void;
  selectOnlyLookups: (objectName: string) => void;
  refreshNodeFields: (objectName: string) => void;  // Update node fields and re-layout if needed
  toggleNodeCollapse: (nodeId: string) => void;
  // Child relationship selection actions
  addChildRelationship: (parentObject: string, relationshipKey: string, cascadeDelete: boolean) => void;
  removeChildRelationship: (parentObject: string, relationshipKey: string) => void;
  clearChildRelationships: (parentObject: string) => void;
  refreshEdges: () => void;  // Recalculate edges and rerun layout when Core geometry depends on them
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  clearAllSelections: () => void;
  addCloudPack: (packId: string) => Promise<{ added: number; total: number }>;
  // Enrichment actions
  fetchObjectEnrichment: (objectNames: string[]) => Promise<void>;
  // Badge display settings actions
  toggleSettingsDropdown: () => void;
  toggleBadgeSetting: (key: keyof BadgeDisplaySettings) => void;
  setEdgeRoutingMode: (mode: EdgeRoutingMode) => void;
  // Export actions
  toggleExportDropdown: () => void;
  setExportSetting: <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => void;
  setIsExporting: (loading: boolean) => void;

  // ===== WORKSPACE ACTIONS =====
  setActiveWorkspace: (workspace: Workspace) => void;

  // ===== DATA CLOUD ACTIONS =====
  checkDataCloudStatus: () => Promise<void>;
  loadDataCloudEntities: () => Promise<void>;
  selectDataCloudEntities: (names: string[]) => Promise<void>;
  addDataCloudEntity: (name: string) => Promise<void>;
  removeDataCloudEntity: (name: string) => void;
  setDcFocusedEntity: (name: string | null) => void;
  setDcSearchTerm: (term: string) => void;
  toggleDcEntityTypeFilter: (type: DataCloudEntityType) => void;
  applyDcLayout: () => Promise<void>;
  refreshDcEdges: () => void;  // Recalculate DC edges and rerun layout
  clearDataCloudSelections: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  authStatus: null,
  isLoadingAuth: true,
  apiVersion: null,
  availableApiVersions: [],
  isLoadingApiVersions: false,
  newObjectNames: new Set(),
  isLoadingNewObjects: false,
  releaseStats: [],
  showOnlyNew: false,
  availableObjects: [],
  selectedObjectNames: [],
  describedObjects: new Map(),
  isLoadingObjects: false,
  isLoadingDescribe: false,
  isCoreLayouting: false,
  objectsLoadTime: null,
  nodes: [],
  edges: [],
  layoutSyncToken: 0,
  sidebarOpen: true,
  sidebarWidth: 480,
  detailPanelWidth: 480,
  classificationFilters: { ...DEFAULT_CLASSIFICATION_FILTERS },
  selectedNamespaces: [],
  searchTerm: '',
  objectTypeFilters: { ...DEFAULT_OBJECT_TYPE_FILTERS },
  showLegend: false,
  focusedObjectName: null,
  advancedFiltersExpanded: false,  // Default collapsed
  selectedFieldsByObject: new Map(),
  selectedChildRelsByParent: new Map(),  // Tracks child relationships for edge filtering
  relationshipTypeByKey: new Map(),  // Tracks cascade_delete for accurate MD/Lookup rendering
  objectEnrichment: new Map(),  // OWD and record counts for objects
  enrichmentLoading: new Set(),  // Objects currently being enriched
  fieldMetadata: new Map(),  // Field-level metadata (indexed, classification, etc.)
  badgeSettings: { ...DEFAULT_BADGE_SETTINGS },
  edgeRoutingMode: DEFAULT_EDGE_ROUTING_MODE,
  showSettingsDropdown: false,
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  showExportDropdown: false,
  isExporting: false,
  error: null,

  // ===== WORKSPACE INITIAL STATE =====
  activeWorkspace: 'core',

  // ===== DATA CLOUD INITIAL STATE =====
  dcIsEnabled: null,
  dcIsCheckingStatus: false,
  dcAvailableEntities: [],
  dcSelectedEntityNames: [],
  dcDescribedEntities: new Map(),
  dcIsLoadingEntities: false,
  dcIsLoadingDescribe: false,
  isDcLayouting: false,
  dcNodes: [],
  dcEdges: [],
  dcFocusedEntityName: null,
  dcSearchTerm: '',
  dcEntityTypeFilter: new Set(['DataLakeObject', 'DataModelObject'] as DataCloudEntityType[]),

  // Actions
  checkAuth: async () => {
    set({ isLoadingAuth: true });
    try {
      const status = await api.auth.getStatus();
      set({ authStatus: status, isLoadingAuth: false });

      // If authenticated, fetch session info to populate org details in backend cache
      // This triggers SOQL query for org_name, org_type, instance_name, then we
      // re-fetch status to get the cached values for header display
      if (status.is_authenticated) {
        try {
          await api.auth.getSessionInfo();
          // Re-fetch status to get cached org info (org_type, instance_name)
          const updatedStatus = await api.auth.getStatus();
          set({ authStatus: updatedStatus });
        } catch {
          // Non-blocking - org info is nice-to-have for header display
        }
      }
    } catch {
      set({ authStatus: { is_authenticated: false }, isLoadingAuth: false });
    }
  },

  logout: async () => {
    await api.auth.logout();
    set({
      authStatus: { is_authenticated: false },
      apiVersion: null,
      availableApiVersions: [],
      availableObjects: [],
      selectedObjectNames: [],
      describedObjects: new Map(),
      nodes: [],
      edges: [],
    });
  },

  loadApiVersions: async () => {
    set({ isLoadingApiVersions: true });
    try {
      const versions = await api.schema.getApiVersions();
      // Default to a known stable version (v65.0 Winter '26 or fallbacks)
      // Fall back to latest if stable version not found
      const { apiVersion } = get();
      if (!apiVersion && versions.length > 0) {
        const stableVersions = ['65.0', '64.0', '63.0'];
        const stable = versions.find((v) => stableVersions.includes(v.version));
        const defaultVersion = stable ? `v${stable.version}` : `v${versions[0].version}`;
        set({
          availableApiVersions: versions,
          apiVersion: defaultVersion,
          isLoadingApiVersions: false,
        });
      } else {
        set({
          availableApiVersions: versions,
          isLoadingApiVersions: false,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load API versions';
      set({ isLoadingApiVersions: false, error: message });
    }
  },

  setApiVersion: (version: string | null) => {
    const { apiVersion } = get();
    if (version === apiVersion) return; // No change

    // Clear cached data since objects may differ between versions
    // NOTE: releaseStats is NOT cleared - it's cached since release history is always the same
    set({
      apiVersion: version,
      availableObjects: [],
      selectedObjectNames: [],
      describedObjects: new Map(),
      nodes: [],
      edges: [],
      // Clear sparkle icons (they depend on selected version), but keep releaseStats cached
      newObjectNames: new Set(),
      isLoadingNewObjects: false,
    });

    // Reload objects with new version
    get().loadObjects();
  },

  loadObjects: async () => {
    const { apiVersion } = get();
    set({ isLoadingObjects: true, error: null, objectsLoadTime: null });
    const startTime = performance.now();
    try {
      const objects = await api.schema.listObjects(apiVersion ?? undefined);
      const loadTime = (performance.now() - startTime) / 1000;  // Convert to seconds
      set({ availableObjects: objects, isLoadingObjects: false, objectsLoadTime: loadTime });
      // Trigger background comparison to find new objects
      get().loadNewObjectsComparison();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load objects';
      set({ isLoadingObjects: false, error: message, objectsLoadTime: null });
    }
  },

  // Load objects from previous versions and compute diffs for last 9 releases (~3 years)
  // IMPORTANT: Release stats always show top 9 versions (e.g., v65 vs v64, v64 vs v63, etc.)
  // regardless of which version is selected. newObjectNames (for sparkle icons) is computed
  // based on the selected version vs its predecessor.
  // NOTE: releaseStats are CACHED - only fetched once, then reused across version changes.
  loadNewObjectsComparison: async () => {
    const { availableApiVersions, apiVersion, releaseStats } = get();

    // Need at least 2 versions to compute any diff
    if (availableApiVersions.length < 2) {
      set({ newObjectNames: new Set(), isLoadingNewObjects: false, releaseStats: [] });
      return;
    }

    // Only show loading state if we need to fetch release stats (not cached)
    const needsFetch = releaseStats.length === 0;
    if (needsFetch) {
      set({ isLoadingNewObjects: true });
    }

    try {
      // =====================================================
      // Part 1: Release Stats - Only fetch if not cached
      // =====================================================
      let stats = releaseStats;
      let objectLists: ObjectBasicInfo[][] = [];

      if (needsFetch) {
        // First time: fetch all 10 versions to compute 9 diffs (~3 years of releases)
        const versionsToFetch = availableApiVersions.slice(0, 10);
        const fetchPromises = versionsToFetch.map(v =>
          api.schema.listObjects(`v${v.version}`)
        );
        objectLists = await Promise.all(fetchPromises);

        // Compute diffs for top 9 versions
        stats = [];
        for (let i = 0; i < Math.min(9, objectLists.length - 1); i++) {
          const currentNames = new Set(objectLists[i].map(o => o.name));
          const prevNames = new Set(objectLists[i + 1].map(o => o.name));
          const newObjectNames = [...currentNames].filter(name => !prevNames.has(name)).sort();

          stats.push({
            version: versionsToFetch[i].version,
            label: versionsToFetch[i].label,
            newCount: newObjectNames.length,
            newObjectNames,
          });
        }
      }

      // =====================================================
      // Part 2: newObjectNames - Always recompute for selected version
      // =====================================================
      const selectedVersionNum = apiVersion?.replace('v', '') || availableApiVersions[0].version;
      const selectedIndex = availableApiVersions.findIndex(v => v.version === selectedVersionNum);

      let newNames = new Set<string>();
      if (selectedIndex >= 0 && selectedIndex < availableApiVersions.length - 1) {
        // If we have fresh objectLists from above, reuse them
        // Otherwise fetch just the 2 versions needed for sparkle icons
        let selectedObjects: ObjectBasicInfo[];
        let prevObjects: ObjectBasicInfo[];

        if (objectLists.length > 0 && selectedIndex < objectLists.length && (selectedIndex + 1) < objectLists.length) {
          selectedObjects = objectLists[selectedIndex];
          prevObjects = objectLists[selectedIndex + 1];
        } else {
          // Fetch only the 2 versions needed
          const prevVersion = availableApiVersions[selectedIndex + 1];
          [selectedObjects, prevObjects] = await Promise.all([
            api.schema.listObjects(`v${selectedVersionNum}`),
            api.schema.listObjects(`v${prevVersion.version}`),
          ]);
        }

        const currentNames = new Set(selectedObjects.map(o => o.name));
        const prevNames = new Set(prevObjects.map(o => o.name));
        newNames = new Set([...currentNames].filter(name => !prevNames.has(name)));
      }

      set({
        releaseStats: stats,
        newObjectNames: newNames,
        isLoadingNewObjects: false,
      });
    } catch {
      // Fail silently - new object detection is a nice-to-have
      set({ releaseStats: [], newObjectNames: new Set(), isLoadingNewObjects: false });
    }
  },

  setShowOnlyNew: (show: boolean) => {
    set({ showOnlyNew: show });
  },

  selectObjects: async (names: string[]) => {
    const { describedObjects, apiVersion } = get();

    // Find objects that need to be described
    const toDescribe = names.filter((name) => !describedObjects.has(name));

    if (toDescribe.length > 0) {
      set({ isLoadingDescribe: true, error: null });
      try {
        const response = await api.schema.describeObjects(toDescribe, apiVersion ?? undefined);
        const newDescribed = new Map(describedObjects);
        for (const obj of response.objects) {
          newDescribed.set(obj.name, obj);
        }
        set({ describedObjects: newDescribed });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to describe objects';
        set({ error: message });
      }
      set({ isLoadingDescribe: false });
    }

    set({ selectedObjectNames: names });

    // Update flow elements
    await get().applyCoreLayout();
  },

  addObject: async (name: string) => {
    const { selectedObjectNames, describedObjects, apiVersion } = get();

    if (selectedObjectNames.includes(name)) {
      return; // Already selected
    }

    // Describe if not already described
    if (!describedObjects.has(name)) {
      set({ isLoadingDescribe: true, error: null });
      try {
        const describe = await api.schema.describeObject(name, apiVersion ?? undefined);
        const newDescribed = new Map(describedObjects);
        newDescribed.set(name, describe);
        set({ describedObjects: newDescribed });
      } catch (error) {
        const message = error instanceof Error ? error.message : `Failed to describe ${name}`;
        set({ isLoadingDescribe: false, error: message });
        return;
      }
      set({ isLoadingDescribe: false });
    }

    const newSelectedObjects = [...selectedObjectNames, name];
    set({ selectedObjectNames: newSelectedObjects });
    await get().applyCoreLayout();
  },

  removeObject: (name: string) => {
    const { selectedObjectNames, selectedFieldsByObject, selectedChildRelsByParent } = get();

    const newSelectedObjects = selectedObjectNames.filter((n) => n !== name);

    // Clear field selections for the removed object
    const newFieldSelections = new Map(selectedFieldsByObject);
    newFieldSelections.delete(name);

    // Clear child relationship selections for the removed object (if it was a parent)
    const newChildRels = new Map(selectedChildRelsByParent);
    newChildRels.delete(name);

    set({
      selectedObjectNames: newSelectedObjects,
      selectedFieldsByObject: newFieldSelections,
      selectedChildRelsByParent: newChildRels,
    });

    void get().applyCoreLayout();
  },

  applyCoreLayout: async () => {
    const requestId = ++latestCoreLayoutRequestId;
    set({ isCoreLayouting: true, error: null });

    const {
      selectedObjectNames,
      describedObjects,
      selectedFieldsByObject,
      selectedChildRelsByParent,
      relationshipTypeByKey,
      badgeSettings,
    } = get();

    const describes = selectedObjectNames
      .map((name) => describedObjects.get(name))
      .filter((d): d is ObjectDescribe => d !== undefined);

    if (describes.length === 0) {
      if (requestId !== latestCoreLayoutRequestId) return;
      set((state) => ({
        nodes: [],
        edges: [],
        isCoreLayouting: false,
        layoutSyncToken: state.layoutSyncToken + 1,
      }));
      return;
    }

    const flowElements = transformToFlowElements(
      describes,
      selectedObjectNames,
      selectedFieldsByObject,
      selectedChildRelsByParent,
      relationshipTypeByKey,
      badgeSettings.showAllConnections,
      badgeSettings.showSelfReferences
    );

    try {
      const layouted = await applyElkLayout(flowElements.nodes, flowElements.edges);

      if (requestId !== latestCoreLayoutRequestId) return;

      set((state) => ({
        nodes: layouted.nodes,
        edges: layouted.edges,
        isCoreLayouting: false,
        layoutSyncToken: state.layoutSyncToken + 1,
      }));
    } catch (error) {
      if (requestId !== latestCoreLayoutRequestId) return;

      const message = error instanceof Error ? error.message : 'Failed to apply schema layout';
      set({ isCoreLayouting: false, error: message });
    }
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },

  setSidebarWidth: (width: number) => {
    // Clamp width between min and max bounds
    const clampedWidth = Math.min(Math.max(width, 200), 600);
    set({ sidebarWidth: clampedWidth });
  },

  setDetailPanelWidth: (width: number) => {
    // Clamp width between min and max bounds (same as sidebar)
    const clampedWidth = Math.min(Math.max(width, 200), 600);
    set({ detailPanelWidth: clampedWidth });
  },

  toggleClassificationFilter: (filter) => {
    set((state) => {
      const newFilters = {
        ...state.classificationFilters,
        [filter]: !state.classificationFilters[filter],
      };
      // Clear selected namespaces when packaged is turned off
      if (filter === 'packaged' && newFilters.packaged === false) {
        return { classificationFilters: newFilters, selectedNamespaces: [] };
      }
      return { classificationFilters: newFilters };
    });
  },

  setSelectedNamespaces: (namespaces) => {
    set({ selectedNamespaces: namespaces });
  },

  toggleNamespace: (namespace) => {
    set((state) => {
      const current = state.selectedNamespaces;
      if (current.includes(namespace)) {
        return { selectedNamespaces: current.filter((ns) => ns !== namespace) };
      } else {
        return { selectedNamespaces: [...current, namespace] };
      }
    });
  },

  setSearchTerm: (term) => {
    set({ searchTerm: term });
  },

  toggleObjectTypeFilter: (filter) => {
    set((state) => ({
      objectTypeFilters: {
        ...state.objectTypeFilters,
        [filter]: !state.objectTypeFilters[filter],
      },
    }));
  },

  showAllObjectTypes: () => {
    set({
      classificationFilters: { standard: true, custom: true, packaged: true },
      objectTypeFilters: {
        feed: true,
        share: true,
        history: true,
        changeEvent: true,
        platformEvent: true,
        externalObject: true,
        customMetadata: true,
        bigObject: true,
        tag: true,
      },
    });
  },

  hideAllSystemObjects: () => {
    set({
      classificationFilters: { ...DEFAULT_CLASSIFICATION_FILTERS },
      objectTypeFilters: { ...DEFAULT_OBJECT_TYPE_FILTERS },
    });
  },

  toggleLegend: () => {
    set((state) => ({ showLegend: !state.showLegend }));
  },

  toggleAdvancedFilters: () => {
    set((state) => ({ advancedFiltersExpanded: !state.advancedFiltersExpanded }));
  },

  setFocusedObject: (name: string | null) => {
    set({ focusedObjectName: name });
  },

  // Fetch object description without adding to ERD (for detail panel auto-fetch)
  describeObject: async (name: string) => {
    const { describedObjects, apiVersion } = get();

    // Already described, no need to fetch
    if (describedObjects.has(name)) {
      return;
    }

    set({ isLoadingDescribe: true, error: null });
    try {
      const describe = await api.schema.describeObject(name, apiVersion ?? undefined);
      const newDescribed = new Map(describedObjects);
      newDescribed.set(name, describe);
      set({ describedObjects: newDescribed, isLoadingDescribe: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to describe ${name}`;
      set({ isLoadingDescribe: false, error: message });
    }
  },

  toggleFieldSelection: (objectName: string, fieldName: string) => {
    // Use functional update to ensure atomic state change
    set((state) => {
      // Update field selection
      const newFieldsMap = new Map(state.selectedFieldsByObject);
      const currentFields = newFieldsMap.get(objectName) ?? new Set<string>();
      const newFields = new Set(currentFields);

      if (newFields.has(fieldName)) {
        newFields.delete(fieldName);
      } else {
        newFields.add(fieldName);
      }
      newFieldsMap.set(objectName, newFields);

      // If object is in ERD, update node fields in the same atomic operation
      if (state.selectedObjectNames.includes(objectName)) {
        const describe = state.describedObjects.get(objectName);
        if (describe) {
          const filteredFields = newFields.size > 0
            ? describe.fields.filter((f) => newFields.has(f.name))
            : [];

          const updatedNodes = state.nodes.map((node) =>
            node.id === objectName
              ? { ...node, data: { ...(node.data as ObjectNodeData), fields: filteredFields } }
              : node
          );

          return { selectedFieldsByObject: newFieldsMap, nodes: updatedNodes };
        }
      }

      return { selectedFieldsByObject: newFieldsMap };
    });

    if (get().selectedObjectNames.includes(objectName)) {
      void get().applyCoreLayout();
    }
  },

  selectAllFields: (objectName: string) => {
    set((state) => {
      const describe = state.describedObjects.get(objectName);
      if (!describe) return state;

      const allFieldNames = new Set(describe.fields.map((f) => f.name));
      const newFieldsMap = new Map(state.selectedFieldsByObject);
      newFieldsMap.set(objectName, allFieldNames);

      // If object is in ERD, update node fields
      if (state.selectedObjectNames.includes(objectName)) {
        const updatedNodes = state.nodes.map((node) =>
          node.id === objectName
            ? { ...node, data: { ...(node.data as ObjectNodeData), fields: describe.fields } }
            : node
        );
        return { selectedFieldsByObject: newFieldsMap, nodes: updatedNodes };
      }

      return { selectedFieldsByObject: newFieldsMap };
    });

    if (get().selectedObjectNames.includes(objectName)) {
      void get().applyCoreLayout();
    }
  },

  clearFieldSelection: (objectName: string) => {
    set((state) => {
      const newFieldsMap = new Map(state.selectedFieldsByObject);
      newFieldsMap.set(objectName, new Set<string>());

      // If object is in ERD, update node fields to empty
      if (state.selectedObjectNames.includes(objectName)) {
        const updatedNodes = state.nodes.map((node) =>
          node.id === objectName
            ? { ...node, data: { ...(node.data as ObjectNodeData), fields: [] } }
            : node
        );
        return { selectedFieldsByObject: newFieldsMap, nodes: updatedNodes };
      }

      return { selectedFieldsByObject: newFieldsMap };
    });

    if (get().selectedObjectNames.includes(objectName)) {
      void get().applyCoreLayout();
    }
  },

  selectOnlyLookups: (objectName: string) => {
    set((state) => {
      const describe = state.describedObjects.get(objectName);
      if (!describe) return state;

      // Select only reference (lookup) fields
      const lookupFieldNames = new Set(
        describe.fields
          .filter((f) => f.reference_to && f.reference_to.length > 0)
          .map((f) => f.name)
      );
      const newFieldsMap = new Map(state.selectedFieldsByObject);
      newFieldsMap.set(objectName, lookupFieldNames);

      // If object is in ERD, update node fields
      if (state.selectedObjectNames.includes(objectName)) {
        const filteredFields = describe.fields.filter((f) =>
          f.reference_to && f.reference_to.length > 0
        );
        const updatedNodes = state.nodes.map((node) =>
          node.id === objectName
            ? { ...node, data: { ...(node.data as ObjectNodeData), fields: filteredFields } }
            : node
        );
        return { selectedFieldsByObject: newFieldsMap, nodes: updatedNodes };
      }

      return { selectedFieldsByObject: newFieldsMap };
    });

    if (get().selectedObjectNames.includes(objectName)) {
      void get().applyCoreLayout();
    }
  },

  // Update node fields in-place, then rerun auto-layout when the object is on the canvas
  refreshNodeFields: (objectName: string) => {
    set((state) => {
      const describe = state.describedObjects.get(objectName);
      if (!describe) return state;

      const selectedFieldNames = state.selectedFieldsByObject.get(objectName) ?? new Set<string>();
      const filteredFields = selectedFieldNames.size > 0
        ? describe.fields.filter((f) => selectedFieldNames.has(f.name))
        : [];

      const updatedNodes = state.nodes.map((node) =>
        node.id === objectName
          ? { ...node, data: { ...(node.data as ObjectNodeData), fields: filteredFields } }
          : node
      );

      return { nodes: updatedNodes };
    });

    if (get().selectedObjectNames.includes(objectName)) {
      void get().applyCoreLayout();
    }
  },

  toggleNodeCollapse: (nodeId: string) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...(node.data as ObjectNodeData), collapsed: !(node.data as ObjectNodeData).collapsed } }
          : node
      ),
    }));

    if (get().selectedObjectNames.includes(nodeId)) {
      void get().applyCoreLayout();
    }
  },

  // Child relationship selection actions
  // These track which specific relationships were selected to filter edges
  addChildRelationship: (parentObject: string, relationshipKey: string, cascadeDelete: boolean) => {
    set((state) => {
      const newMap = new Map(state.selectedChildRelsByParent);
      const currentSet = newMap.get(parentObject) ?? new Set<string>();
      const newSet = new Set(currentSet);
      newSet.add(relationshipKey);
      newMap.set(parentObject, newSet);

      // Also store the cascade_delete for accurate MD/Lookup type in diagram
      const newTypeMap = new Map(state.relationshipTypeByKey);
      newTypeMap.set(relationshipKey, cascadeDelete);

      return { selectedChildRelsByParent: newMap, relationshipTypeByKey: newTypeMap };
    });
  },

  removeChildRelationship: (parentObject: string, relationshipKey: string) => {
    set((state) => {
      const newMap = new Map(state.selectedChildRelsByParent);
      const currentSet = newMap.get(parentObject);
      if (currentSet) {
        const newSet = new Set(currentSet);
        newSet.delete(relationshipKey);
        if (newSet.size === 0) {
          newMap.delete(parentObject);
        } else {
          newMap.set(parentObject, newSet);
        }
      }

      // Also remove from type override map
      const newTypeMap = new Map(state.relationshipTypeByKey);
      newTypeMap.delete(relationshipKey);

      return { selectedChildRelsByParent: newMap, relationshipTypeByKey: newTypeMap };
    });
  },

  clearChildRelationships: (parentObject: string) => {
    set((state) => {
      const newMap = new Map(state.selectedChildRelsByParent);
      const relKeys = newMap.get(parentObject);
      newMap.delete(parentObject);

      // Also remove type overrides for all relationships of this parent
      const newTypeMap = new Map(state.relationshipTypeByKey);
      if (relKeys) {
        for (const key of relKeys) {
          newTypeMap.delete(key);
        }
      }

      return { selectedChildRelsByParent: newMap, relationshipTypeByKey: newTypeMap };
    });
  },

  // Recalculate edges and refresh layout when the visible relationship set changes
  refreshEdges: () => {
    void get().applyCoreLayout();
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),

  // Clear all selections - objects, fields, child relationships, focused object, and ERD
  clearAllSelections: () => {
    set({
      selectedObjectNames: [],
      selectedFieldsByObject: new Map(),
      selectedChildRelsByParent: new Map(),
      relationshipTypeByKey: new Map(),  // Also clear type overrides
      focusedObjectName: null,
      nodes: [],
      edges: [],
    });
  },

  // Add all objects from a Cloud Pack to the current selection
  // Returns count of objects added vs total in pack (for UI feedback)
  addCloudPack: async (packId: string) => {
    const pack = CLOUD_PACKS.find(p => p.id === packId);
    if (!pack) return { added: 0, total: 0 };

    const { availableObjects, selectedObjectNames, describedObjects, apiVersion } = get();

    // Filter to objects that exist in the org
    const availableNames = new Set(availableObjects.map(o => o.name));
    const packObjectsInOrg = pack.objects.filter(name => availableNames.has(name));

    // Filter out already selected objects
    const toAdd = packObjectsInOrg.filter(name => !selectedObjectNames.includes(name));

    if (toAdd.length === 0) {
      // All pack objects already selected or none available
      return { added: 0, total: pack.objects.length };
    }

    // Describe objects that haven't been described yet
    const toDescribe = toAdd.filter(name => !describedObjects.has(name));
    if (toDescribe.length > 0) {
      set({ isLoadingDescribe: true, error: null });
      try {
        const response = await api.schema.describeObjects(toDescribe, apiVersion ?? undefined);
        const newDescribed = new Map(describedObjects);
        for (const obj of response.objects) {
          newDescribed.set(obj.name, obj);
        }
        set({ describedObjects: newDescribed });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to describe objects';
        set({ isLoadingDescribe: false, error: message });
        return { added: 0, total: pack.objects.length };
      }
      set({ isLoadingDescribe: false });
    }

    // Add to selection (union with existing)
    const newSelectedObjects = [...selectedObjectNames, ...toAdd];
    set({ selectedObjectNames: newSelectedObjects });

    // Get updated describedObjects and transform to flow elements
    const { describedObjects: updatedDescribed, selectedFieldsByObject, selectedChildRelsByParent, relationshipTypeByKey, badgeSettings } = get();
    const describes = newSelectedObjects
      .map(name => updatedDescribed.get(name))
      .filter((d): d is ObjectDescribe => d !== undefined);

    const { nodes: newNodes, edges: newEdges } = transformToFlowElements(
      describes, newSelectedObjects, selectedFieldsByObject, selectedChildRelsByParent, relationshipTypeByKey, badgeSettings.showAllConnections, badgeSettings.showSelfReferences
    );

    // Set nodes/edges then apply the current Core auto-layout for relationship-aware positioning
    set({ nodes: newNodes, edges: newEdges });
    await get().applyCoreLayout();

    return { added: toAdd.length, total: pack.objects.length };
  },

  // Fetch enrichment data (OWD, record counts) for objects asynchronously
  // This is called after objects are added to the ERD for background loading
  fetchObjectEnrichment: async (objectNames: string[]) => {
    if (objectNames.length === 0) return;

    const { apiVersion, objectEnrichment, enrichmentLoading } = get();

    // Filter out objects already enriched or currently loading
    const toFetch = objectNames.filter(
      (name) => !objectEnrichment.has(name) && !enrichmentLoading.has(name)
    );

    if (toFetch.length === 0) return;

    // Mark objects as loading
    const newLoading = new Set(enrichmentLoading);
    toFetch.forEach((name) => newLoading.add(name));
    set({ enrichmentLoading: newLoading });

    try {
      const response = await api.schema.getObjectEnrichment(toFetch, apiVersion ?? undefined);

      // Update enrichment map with results
      const newEnrichment = new Map(get().objectEnrichment);
      for (const [name, info] of Object.entries(response.enrichments)) {
        newEnrichment.set(name, info);
      }

      // Update field metadata map if present (Tier 2 data)
      const newFieldMetadata = new Map(get().fieldMetadata);
      if (response.field_metadata) {
        for (const [key, info] of Object.entries(response.field_metadata)) {
          newFieldMetadata.set(key, info);
        }
      }

      // Clear loading state
      const updatedLoading = new Set(get().enrichmentLoading);
      toFetch.forEach((name) => updatedLoading.delete(name));

      set({
        objectEnrichment: newEnrichment,
        fieldMetadata: newFieldMetadata,
        enrichmentLoading: updatedLoading,
      });
    } catch {
      // Fail silently - enrichment is nice-to-have, not critical
      // Clear loading state on error
      const updatedLoading = new Set(get().enrichmentLoading);
      toFetch.forEach((name) => updatedLoading.delete(name));
      set({ enrichmentLoading: updatedLoading });
    }
  },

  // Badge display settings actions
  toggleSettingsDropdown: () => {
    set((state) => ({ showSettingsDropdown: !state.showSettingsDropdown }));
  },

  toggleBadgeSetting: (key: keyof BadgeDisplaySettings) => {
    set((state) => ({
      badgeSettings: {
        ...state.badgeSettings,
        [key]: !state.badgeSettings[key],
      },
    }));

    const { activeWorkspace, selectedObjectNames, dcSelectedEntityNames } = get();
    if (key === 'compactMode') {
      if (activeWorkspace === 'core' && selectedObjectNames.length > 0) {
        void get().applyCoreLayout();
      } else if (activeWorkspace === 'datacloud' && dcSelectedEntityNames.length > 0) {
        void get().applyDcLayout();
      }
    }
  },

  setEdgeRoutingMode: (mode: EdgeRoutingMode) => {
    set({ edgeRoutingMode: mode });
  },

  // Export actions
  toggleExportDropdown: () => {
    set((state) => ({ showExportDropdown: !state.showExportDropdown }));
  },

  setExportSetting: (key, value) => {
    set((state) => ({
      exportSettings: {
        ...state.exportSettings,
        [key]: value,
      },
    }));
  },

  setIsExporting: (loading: boolean) => {
    set({ isExporting: loading });
  },

  // ===== WORKSPACE ACTIONS =====
  setActiveWorkspace: (workspace: Workspace) => {
    set({ activeWorkspace: workspace });
  },

  // ===== DATA CLOUD ACTIONS =====
  checkDataCloudStatus: async () => {
    set({ dcIsCheckingStatus: true });
    try {
      const status = await api.datacloud.checkStatus();
      set({
        dcIsEnabled: status.is_enabled,
        dcIsCheckingStatus: false,
      });
    } catch {
      set({
        dcIsEnabled: false,
        dcIsCheckingStatus: false,
      });
    }
  },

  loadDataCloudEntities: async () => {
    set({ dcIsLoadingEntities: true, error: null });
    try {
      const entities = await api.datacloud.listEntities();
      set({
        dcAvailableEntities: entities,
        dcIsLoadingEntities: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load Data Cloud entities';
      set({ dcIsLoadingEntities: false, error: message });
    }
  },

  selectDataCloudEntities: async (names: string[]) => {
    const { dcDescribedEntities } = get();

    // Find entities that need to be described
    const toDescribe = names.filter((name) => !dcDescribedEntities.has(name));

    if (toDescribe.length > 0) {
      set({ dcIsLoadingDescribe: true, error: null });
      try {
        const response = await api.datacloud.describeEntities(toDescribe);
        const newDescribed = new Map(dcDescribedEntities);
        for (const entity of response.entities) {
          newDescribed.set(entity.name, entity);
        }
        set({ dcDescribedEntities: newDescribed });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to describe Data Cloud entities';
        set({ error: message });
      }
      set({ dcIsLoadingDescribe: false });
    }

    set({ dcSelectedEntityNames: names });

    // Update flow elements
    await get().applyDcLayout();
  },

  addDataCloudEntity: async (name: string) => {
    const { dcSelectedEntityNames, dcDescribedEntities } = get();

    if (dcSelectedEntityNames.includes(name)) {
      return; // Already selected
    }

    // Describe if not already described
    if (!dcDescribedEntities.has(name)) {
      set({ dcIsLoadingDescribe: true, error: null });
      try {
        const describe = await api.datacloud.describeEntity(name);
        const newDescribed = new Map(dcDescribedEntities);
        newDescribed.set(name, describe);
        set({ dcDescribedEntities: newDescribed });
      } catch (error) {
        const message = error instanceof Error ? error.message : `Failed to describe ${name}`;
        set({ dcIsLoadingDescribe: false, error: message });
        return;
      }
      set({ dcIsLoadingDescribe: false });
    }

    const newSelected = [...dcSelectedEntityNames, name];
    set({ dcSelectedEntityNames: newSelected });
    await get().applyDcLayout();
  },

  removeDataCloudEntity: (name: string) => {
    const { dcSelectedEntityNames } = get();

    const newSelected = dcSelectedEntityNames.filter((n) => n !== name);
    set({ dcSelectedEntityNames: newSelected });

    if (newSelected.length === 0) {
      set((state) => ({
        dcNodes: [],
        dcEdges: [],
        layoutSyncToken: state.layoutSyncToken + 1,
      }));
      return;
    }

    void get().applyDcLayout();
  },

  setDcFocusedEntity: (name: string | null) => {
    set({ dcFocusedEntityName: name });
  },

  setDcSearchTerm: (term: string) => {
    set({ dcSearchTerm: term });
  },

  toggleDcEntityTypeFilter: (type: DataCloudEntityType) => {
    set((state) => {
      const newFilter = new Set(state.dcEntityTypeFilter);
      if (newFilter.has(type)) {
        newFilter.delete(type);
      } else {
        newFilter.add(type);
      }
      return { dcEntityTypeFilter: newFilter };
    });
  },

  applyDcLayout: async () => {
    const requestId = ++latestDcLayoutRequestId;
    set({ isDcLayouting: true, error: null });

    const { dcSelectedEntityNames, dcDescribedEntities, badgeSettings } = get();

    if (dcSelectedEntityNames.length === 0) {
      if (requestId !== latestDcLayoutRequestId) return;
      set((state) => ({
        dcNodes: [],
        dcEdges: [],
        isDcLayouting: false,
        layoutSyncToken: state.layoutSyncToken + 1,
      }));
      return;
    }

    const flowElements = buildDataCloudFlowElements(
      dcSelectedEntityNames,
      dcDescribedEntities,
      badgeSettings.showSelfReferences
    );

    try {
      const layouted = await applyElkLayout(flowElements.nodes, flowElements.edges);

      if (requestId !== latestDcLayoutRequestId) return;

      set((state) => ({
        dcNodes: layouted.nodes,
        dcEdges: layouted.edges,
        isDcLayouting: false,
        layoutSyncToken: state.layoutSyncToken + 1,
      }));
    } catch (error) {
      if (requestId !== latestDcLayoutRequestId) return;

      const message = error instanceof Error ? error.message : 'Failed to apply Data Cloud layout';
      set({ isDcLayouting: false, error: message });
    }
  },

  // Recalculate DC edges only, preserving node positions
  // Used when self-references or connection settings change
  refreshDcEdges: () => {
    void get().applyDcLayout();
  },

  clearDataCloudSelections: () => {
    set({
      dcSelectedEntityNames: [],
      dcFocusedEntityName: null,
      dcNodes: [],
      dcEdges: [],
    });
  },
}));

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import { attach } from '@adobe/uix-guest';
import { useNavigate } from 'react-router-dom';
import {
  View,
  Flex,
  Heading,
  Text,
  Button,
  ActionButton,
  TextField,
  Checkbox,
  Switch,
  Picker,
  Item,
  Tabs,
  TabList,
  TabPanels,
  Divider,
  Well,
  Badge,
  ProgressCircle,
  DialogTrigger,
  AlertDialog
} from '@adobe/react-spectrum';
import { api, resultBanner, describeScanSummary } from '../utils/api';
import { extensionId, STORAGE_KEY_CTX } from './Constants';

const GROUP_PAGE_SIZE = 60;
const GROUP_FACES_PAGE_SIZE = 60;

/**
 * Renders a group option inside a Spectrum <Picker> with a circular face avatar thumbnail.
 */
function renderGroupPickerItem(g, { includeFaceCount = true } = {}) {
  const label = includeFaceCount ? `${g.displayName} (${g.faceCount} faces)` : g.displayName;
  return (
    <Item key={g.groupId} textValue={label}>
      <Text>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {g.coverAvatarDataUrl ? (
            <img
              src={g.coverAvatarDataUrl}
              alt=""
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '1px solid #cbd5e1',
                flexShrink: 0,
                verticalAlign: 'middle'
              }}
            />
          ) : (
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: '#e2e8f0',
                display: 'inline-block',
                flexShrink: 0,
                verticalAlign: 'middle'
              }}
            />
          )}
          <span>{label}</span>
        </span>
      </Text>
    </Item>
  );
}

export default function AdminConsole() {
  const navigate = useNavigate();

  const [guestConnection, setGuestConnection] = useState(null);
  const [hostContext, setHostContext] = useState({
    inAemHost: false,
    hostResolved: false,
    imsToken: null,
    imsOrg: null,
    aemHost: null
  });

  useEffect(() => {
    let mounted = true;
    let storedCtx = {};
    try {
      storedCtx = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
    } catch (e) {
      storedCtx = {};
    }
    if (storedCtx.aemAuthorUrl) {
      setHostContext((prev) => ({ ...prev, aemHost: storedCtx.aemAuthorUrl }));
    }

    (async () => {
      try {
        const gc = await Promise.race([
          attach({ id: extensionId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Host connection timed out')), 10000)
          )
        ]);
        if (!gc || !mounted) return;
        setGuestConnection(gc);

        let imsToken = null;
        let imsOrg = null;
        let aemHost = storedCtx.aemAuthorUrl || null;

        try {
          const imsInfo = await gc.host?.auth?.getIMSInfo?.();
          if (imsInfo) {
            imsToken = imsInfo.accessToken || imsInfo.imsToken || null;
            imsOrg = imsInfo.imsOrg || null;
          }
        } catch (e) {
          // ignore
        }

        if (!aemHost && gc.host?.discovery?.getAemHost) {
          try {
            const discovered = await gc.host.discovery.getAemHost();
            if (discovered) {
              aemHost = String(discovered).startsWith('http')
                ? discovered
                : `https://${discovered}`;
            }
          } catch (e) {
            // ignore
          }
        }

        if (mounted) {
          setHostContext((prev) => ({
            ...prev,
            inAemHost: true,
            imsToken: imsToken || prev.imsToken,
            imsOrg: imsOrg || prev.imsOrg,
            aemHost: aemHost || prev.aemHost
          }));
        }
      } catch (e) {
        // Standalone mode outside AEM host
      } finally {
        if (mounted) {
          setHostContext((prev) => ({ ...prev, hostResolved: true }));
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  // Current page of group summaries (filtered/searched server-side)
  const [groups, setGroups] = useState([]);
  const [groupOffset, setGroupOffset] = useState(0);
  const [stats, setStats] = useState({
    totalGroups: 0,
    namedCount: 0,
    unnamedCount: 0,
    matchedCount: 0,
    hasMore: false,
    totalFaces: 0,
    totalAssets: 0
  });
  // Lightweight list (no images) for the "combine into..." pickers
  const [groupOptions, setGroupOptions] = useState([]);
  // Selected group with a page of its faces
  const [activeGroup, setActiveGroup] = useState(null);
  const [activeGroupHasMoreFaces, setActiveGroupHasMoreFaces] = useState(false);
  const [loadingMoreFaces, setLoadingMoreFaces] = useState(false);
  const [settings, setSettings] = useState({
    awsRegion: 'us-east-1',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    awsSecretKeyMasked: '',
    hasAwsSecretKey: false,
    collectionId: 'aem-assets-faces',
    similarityThreshold: 85,
    metadataProperty: 'xdm:faceNames',
    includeUnnamedInMetadata: true,
    processingProfileName: 'Face Recognition',
    requireProcessingProfile: true,
    enabledFoldersText: '/content/dam/events\n/content/dam/campaigns',
    allowedImageTypesText: '',
    minImageSize: 200
  });

  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'named' | 'unnamed'
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [selectedGroupIdsForMerge, setSelectedGroupIdsForMerge] = useState([]);
  const [mergeTargetGroupId, setMergeTargetGroupId] = useState('');

  // Active Group Detail Drawer state
  const [groupNameInput, setGroupNameInput] = useState('');
  const [selectedFaceIds, setSelectedFaceIds] = useState([]);
  const [splitNewGroupName, setSplitNewGroupName] = useState('');
  const [moveTargetGroupId, setMoveTargetGroupId] = useState('');

  // Visual DAM Browser state (defaults to the current folder in AEM Assets View)
  const [currentFolderPath, setCurrentFolderPath] = useState(() => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const sp = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : window.location.search);
    if (sp.get('folderPath')) return sp.get('folderPath');
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
      if (stored.folderPath) return stored.folderPath;
      if (stored.assetPath && stored.assetPath.startsWith('/content/dam')) {
        return /\.[a-z0-9]+$/i.test(stored.assetPath)
          ? stored.assetPath.slice(0, stored.assetPath.lastIndexOf('/')) || '/content/dam'
          : stored.assetPath;
      }
    } catch (e) {
      // ignore
    }
    return '/content/dam';
  });
  const [folderContents, setFolderContents] = useState({
    folderPath: '/content/dam',
    folderTitle: 'Assets',
    folders: [],
    assets: []
  });
  const [browsingFolder, setBrowsingFolder] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [rescanExisting, setRescanExisting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanningAssetPath, setScanningAssetPath] = useState(null);

  const [banner, setBanner] = useState(null);

  // Guards against out-of-order responses (fast typing / paging / switching groups)
  const groupsRequestRef = useRef(0);
  const selectedGroupIdRef = useRef(selectedGroupId);
  selectedGroupIdRef.current = selectedGroupId;
  const lastLoadedGroupIdRef = useRef(null);

  // Filter or search changes always start from the first page. The page reset happens in the
  // same update so only one request is sent.
  const debouncedQueryRef = useRef('');
  useEffect(() => {
    const next = searchQuery.trim();
    const t = setTimeout(() => {
      if (next === debouncedQueryRef.current) return;
      debouncedQueryRef.current = next;
      unstable_batchedUpdates(() => {
        setDebouncedQuery(next);
        setGroupOffset(0);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const handleFilterChange = (key) => {
    setFilterMode(key);
    setGroupOffset(0);
  };

  const loadGroupsPage = useCallback(async () => {
    if (!hostContext.hostResolved) return;
    const requestId = ++groupsRequestRef.current;
    setLoading(true);
    try {
      const res = await api.listGroups(hostContext, {
        offset: groupOffset,
        limit: GROUP_PAGE_SIZE,
        filter: filterMode,
        query: debouncedQuery
      });
      if (requestId !== groupsRequestRef.current) return;
      const loaded = res.groups || [];
      // Deleting/merging can leave us past the last page
      if (loaded.length === 0 && groupOffset > 0 && res.matchedCount > 0) {
        setGroupOffset(Math.max(0, Math.floor((res.matchedCount - 1) / GROUP_PAGE_SIZE) * GROUP_PAGE_SIZE));
        return;
      }
      setGroups(loaded);
      setStats({
        totalGroups: res.totalGroups || 0,
        namedCount: res.namedCount || 0,
        unnamedCount: res.unnamedCount || 0,
        matchedCount: res.matchedCount ?? loaded.length,
        hasMore: Boolean(res.hasMore),
        totalFaces: res.totalFaces || 0,
        totalAssets: res.totalAssets || 0
      });
    } catch (err) {
      if (requestId === groupsRequestRef.current) {
        setBanner({ type: 'negative', text: err.message });
      }
    } finally {
      if (requestId === groupsRequestRef.current) setLoading(false);
    }
  }, [hostContext, groupOffset, filterMode, debouncedQuery]);

  const loadActiveGroup = useCallback(async () => {
    if (!hostContext.hostResolved) return;
    const requestedId = selectedGroupId;
    if (!requestedId) {
      setActiveGroup(null);
      setActiveGroupHasMoreFaces(false);
      lastLoadedGroupIdRef.current = null;
      return;
    }
    try {
      const res = await api.getGroup(requestedId, hostContext, {
        faceOffset: 0,
        faceLimit: GROUP_FACES_PAGE_SIZE
      });
      if (selectedGroupIdRef.current !== requestedId) return;
      setActiveGroup(res.group);
      setActiveGroupHasMoreFaces(Boolean(res.hasMoreFaces));
      if (lastLoadedGroupIdRef.current !== requestedId) {
        setGroupNameInput(res.group.name || '');
        lastLoadedGroupIdRef.current = requestedId;
      }
    } catch (err) {
      if (err.status === 404) {
        // Group was merged away or emptied; clear the selection only if it is still current
        setSelectedGroupId((cur) => (cur === requestedId ? null : cur));
        if (selectedGroupIdRef.current === requestedId) setActiveGroup(null);
      } else if (selectedGroupIdRef.current === requestedId) {
        setBanner({ type: 'negative', text: err.message });
      }
    }
  }, [hostContext, selectedGroupId]);

  const loadGroupOptions = useCallback(async () => {
    if (!hostContext.hostResolved) return;
    try {
      const res = await api.listGroupOptions(hostContext);
      setGroupOptions(res.options || []);
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  }, [hostContext]);

  const loadSettings = useCallback(async () => {
    if (!hostContext.hostResolved) return;
    try {
      const settingsRes = await api.getSettings(hostContext);
      if (settingsRes.settings) {
        setSettings((prev) => ({
          ...prev,
          ...settingsRes.settings,
          awsSecretAccessKey: '',
          enabledFoldersText: (settingsRes.settings.enabledFolders || ['/content/dam']).join('\n'),
          allowedImageTypesText: (settingsRes.settings.allowedImageTypes || []).join(', ')
        }));
      }
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  }, [hostContext]);

  useEffect(() => {
    loadGroupsPage();
  }, [loadGroupsPage]);

  useEffect(() => {
    loadActiveGroup();
  }, [loadActiveGroup]);

  useEffect(() => {
    loadGroupOptions();
    loadSettings();
  }, [loadGroupOptions, loadSettings]);

  /** Refreshes everything after a change (rename, split, merge, scan, settings). */
  const loadAll = useCallback(
    () => Promise.all([loadGroupsPage(), loadActiveGroup(), loadGroupOptions(), loadSettings()]),
    [loadGroupsPage, loadActiveGroup, loadGroupOptions, loadSettings]
  );

  const handleLoadMoreFaces = async () => {
    if (!activeGroup) return;
    const requestedId = activeGroup.groupId;
    setLoadingMoreFaces(true);
    try {
      const res = await api.getGroup(requestedId, hostContext, {
        faceOffset: activeGroup.faces.length,
        faceLimit: GROUP_FACES_PAGE_SIZE
      });
      if (selectedGroupIdRef.current !== requestedId) return;
      setActiveGroup((prev) =>
        prev && prev.groupId === requestedId
          ? { ...res.group, faces: [...prev.faces, ...(res.group.faces || [])] }
          : prev
      );
      setActiveGroupHasMoreFaces(Boolean(res.hasMoreFaces));
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    } finally {
      setLoadingMoreFaces(false);
    }
  };

  const handleSelectGroupForDetail = (grp) => {
    if (grp.groupId !== selectedGroupId) {
      setActiveGroup(null);
      setActiveGroupHasMoreFaces(false);
    }
    setSelectedGroupId(grp.groupId);
    setGroupNameInput(grp.name || '');
    lastLoadedGroupIdRef.current = grp.groupId;
    setSelectedFaceIds([]);
    setSplitNewGroupName('');
    setMoveTargetGroupId('');
  };

  const handleRenameActiveGroup = async () => {
    if (!activeGroup) return;
    try {
      const res = await api.renameGroup(activeGroup.groupId, groupNameInput, hostContext);
      await loadAll();
      setBanner(resultBanner(`Saved name "${res.group.displayName}" and updated ${settings.metadataProperty} across ${res.syncedAssetCount} asset(s).`, res));
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleSplitSelectedFaces = async () => {
    if (selectedFaceIds.length === 0) return;
    try {
      const res = await api.splitFaces(selectedFaceIds, splitNewGroupName, hostContext);
      setSelectedFaceIds([]);
      setSplitNewGroupName('');
      await loadAll();
      setSelectedGroupId(res.newGroup.groupId);
      setGroupNameInput(res.newGroup.name || '');
      setBanner(resultBanner(`Split ${res.newGroup.faceCount} face(s) into new group "${res.newGroup.displayName}" and updated AEM metadata.`, res));
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleMoveSelectedFaces = async () => {
    if (selectedFaceIds.length === 0 || !moveTargetGroupId) return;
    try {
      const res = await api.moveFaces(selectedFaceIds, moveTargetGroupId, hostContext);
      setSelectedFaceIds([]);
      setMoveTargetGroupId('');
      await loadAll();
      setBanner(resultBanner(`Moved face(s) into "${res.targetGroup.displayName}" and recomputed AEM metadata.`, res));
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleMergeGroups = async (sourceIds, targetId) => {
    if (!targetId || !sourceIds.length) return;
    try {
      const res = await api.mergeGroups(sourceIds, targetId, hostContext);
      setSelectedGroupIdsForMerge([]);
      setMergeTargetGroupId('');
      setSelectedGroupId(targetId);
      await loadAll();
      setBanner(resultBanner(`Combined ${res.movedFaceCount} face(s) into "${res.targetGroup.displayName}" and synced ${res.syncedAssetCount} asset(s).`, res));
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleSaveSettings = async () => {
    try {
      const payload = {
        ...settings,
        allowedImageTypes: settings.allowedImageTypesText
          .split(/[\s,]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        minImageSize: Number(settings.minImageSize),
        enabledFolders: settings.enabledFoldersText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      };
      const res = await api.saveSettings(payload, hostContext);
      let totalResynced = res.resyncedAssets || 0;
      if (res.hasMoreToSync) {
        const rest = await api.resyncAllAssets(hostContext);
        totalResynced += rest.syncedAssetCount || 0;
      }
      await loadAll();
      setBanner({
        type: 'positive',
        text: `Settings saved. ${
          totalResynced
            ? `Re-synced ${settings.metadataProperty} across ${totalResynced} asset(s).`
            : ''
        }`
      });
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleTestAwsConnection = async () => {
    try {
      const res = await api.testConnection(settings, hostContext);
      setBanner({
        type: 'positive',
        text: `AWS Rekognition connected! Collection "${res.collectionId}" is ready (${res.faceCount} indexed faces, ${res.userCount} user groups).`
      });
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleRunFolderScan = async () => {
    setScanning(true);
    setScanProgress(null);
    setScanResult(null);
    try {
      const res = await api.scanFolder(
        currentFolderPath,
        hostContext,
        (prog) => setScanProgress(prog),
        { rescan: rescanExisting }
      );
      setScanResult(res);
      await loadAll();
      const summaryText = res.summary
        ? describeScanSummary(res.summary)
        : `${res.totalAssets} asset(s) processed.`;
      setBanner(resultBanner(`Folder scan complete for ${res.folderPath}. ${summaryText}`, res));
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  };

  const handleClearAllData = async () => {
    try {
      await api.clearAllData(hostContext);
      setSelectedGroupId(null);
      await loadAll();
      setBanner({
        type: 'positive',
        text: 'Cleared all face groups and asset records.'
      });
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  return (
    <View padding="size-300" maxWidth="1280px" marginX="auto">
      <Flex direction="column" gap="size-250">
        {/* Sticky Top Navigation Header (stays visible when scrolling) */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 50,
            background: '#ffffff',
            paddingTop: 8,
            paddingBottom: 12,
            borderBottom: '1px solid #e2e8f0'
          }}
        >
        <Flex justifyContent="space-between" alignItems="center" wrap gap="size-150">
          <View>
            <Heading level={1} margin={0}>
              AEM Facial Recognition & Group Management
            </Heading>
            <Text UNSAFE_style={{ color: '#475569' }}>
              Manage AWS Rekognition Face Groups, split or combine faces, and control{' '}
              <code>{settings.metadataProperty}</code> asset metadata
            </Text>
          </View>
          <Flex gap="size-100">
            <Button
              variant="primary"
              onPress={handleRunFolderScan}
              isDisabled={scanning}
            >
              {scanning
                ? scanProgress
                  ? `Scanning Folder (${scanProgress.completed}/${scanProgress.total})...`
                  : 'Scanning Current Folder...'
                : 'Scan Current Folder'}
            </Button>
            <Checkbox isSelected={rescanExisting} onChange={setRescanExisting} isDisabled={scanning}>
              <span style={{ fontSize: 12 }}>Include already-scanned images</span>
            </Checkbox>
            <DialogTrigger>
              <ActionButton isDisabled={stats.totalGroups === 0 && stats.totalFaces === 0}>
                Clear All Data
              </ActionButton>
              <AlertDialog
                variant="destructive"
                title="Clear All Face Groups & Indexed Data?"
                primaryActionLabel="Clear All Data"
                cancelLabel="Cancel"
                onPrimaryAction={handleClearAllData}
              >
                Are you sure you want to permanently remove all {stats.totalGroups} Face
                Group(s) and {stats.totalFaces} indexed face record(s)? This action cannot
                be undone.
              </AlertDialog>
            </DialogTrigger>
            {guestConnection ? (
              <Button
                variant="secondary"
                onPress={() => guestConnection.host?.modal?.closeDialog?.()}
              >
                Close
              </Button>
            ) : (
              <Button
                variant="secondary"
                onPress={() => navigate('/face-recognition-panel')}
              >
                Open Asset Details Side Panel
              </Button>
            )}
          </Flex>
        </Flex>
        </div>

        {banner && (
          <View
            padding="size-150"
            borderRadius="small"
            UNSAFE_style={{
              background: banner.type === 'negative' ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${banner.type === 'negative' ? '#fecaca' : '#bbf7d0'}`,
              color: banner.type === 'negative' ? '#991b1b' : '#166534',
              fontWeight: 500
            }}
          >
            {banner.text}
          </View>
        )}

        {/* Summary KPI Bar */}
        <Flex gap="size-200" wrap>
          <Well flex="1" minWidth="180px">
            <Text UNSAFE_style={{ fontSize: 12, color: '#64748b' }}>FACE GROUPS (CLUSTERS)</Text>
            <Heading level={2} margin={0}>
              {stats.totalGroups}
            </Heading>
          </Well>
          <Well flex="1" minWidth="180px">
            <Text UNSAFE_style={{ fontSize: 12, color: '#64748b' }}>INDEXED FACE VECTORS</Text>
            <Heading level={2} margin={0}>
              {stats.totalFaces}
            </Heading>
          </Well>
          <Well flex="1" minWidth="180px">
            <Text UNSAFE_style={{ fontSize: 12, color: '#64748b' }}>TAGGED AEM ASSETS</Text>
            <Heading level={2} margin={0}>
              {stats.totalAssets}
            </Heading>
          </Well>
          <Well flex="1" minWidth="240px">
            <Text UNSAFE_style={{ fontSize: 12, color: '#64748b' }}>
              UNNAMED PLACEHOLDERS IN <code>{settings.metadataProperty}</code>
            </Text>
            <Flex alignItems="center" justifyContent="space-between" marginTop="size-50">
              <Badge variant={settings.includeUnnamedInMetadata ? 'info' : 'neutral'}>
                {settings.includeUnnamedInMetadata
                  ? 'Shown (e.g. Person #3)'
                  : 'Hidden until named'}
              </Badge>
            </Flex>
          </Well>
        </Flex>

        {/* Main Workspace Tabs */}
        <Tabs aria-label="Face Recognition Admin Tabs">
          <TabList>
            <Item key="groups">Face Groups & Split / Merge Manager</Item>
            <Item key="settings">BYOK AWS Rekognition & Metadata Settings</Item>
          </TabList>

          <TabPanels marginTop="size-250">
            {/* ============================================================ */}
            {/* TAB 1: FACE GROUPS & SPLIT / MERGE MANAGER                   */}
            {/* ============================================================ */}
            <Item key="groups">
              <Flex gap="size-300" alignItems="start" wrap>
                {/* Left Column: Face Groups Grid */}
                <View flex="3" minWidth="480px">
                  <Flex direction="column" gap="size-200">
                    {/* Filter & Bulk Merge Bar */}
                    <Well>
                      <Flex
                        justifyContent="space-between"
                        alignItems="end"
                        wrap
                        gap="size-150"
                      >
                        <Flex gap="size-100" alignItems="end" wrap>
                          <Picker
                            label="Filter Groups"
                            selectedKey={filterMode}
                            onSelectionChange={handleFilterChange}
                            width="size-2000"
                          >
                            <Item key="all">All Groups ({stats.totalGroups})</Item>
                            <Item key="named">Named People ({stats.namedCount})</Item>
                            <Item key="unnamed">
                              Unnamed Placeholders ({stats.unnamedCount})
                            </Item>
                          </Picker>
                          <TextField
                            label="Search by Name or ID"
                            value={searchQuery}
                            onChange={setSearchQuery}
                            placeholder="Search Sarah, Person #3..."
                            width="size-2400"
                          />
                        </Flex>

                        {/* Bulk Combine / Merge Selected Groups */}
                        {selectedGroupIdsForMerge.length >= 2 && (
                          <Flex gap="size-100" alignItems="end">
                            <Picker
                              label={`Combine ${selectedGroupIdsForMerge.length} checked groups into:`}
                              selectedKey={mergeTargetGroupId}
                              onSelectionChange={setMergeTargetGroupId}
                              width="size-2400"
                            >
                              {groupOptions
                                .filter((g) => selectedGroupIdsForMerge.includes(g.groupId))
                                .map((g) =>
                                  renderGroupPickerItem(g, { includeFaceCount: false })
                                )}
                            </Picker>
                            <Button
                              variant="cta"
                              isDisabled={!mergeTargetGroupId}
                              onPress={() =>
                                handleMergeGroups(
                                  selectedGroupIdsForMerge.filter(
                                    (id) => id !== mergeTargetGroupId
                                  ),
                                  mergeTargetGroupId
                                )
                              }
                            >
                              Merge Groups
                            </Button>
                          </Flex>
                        )}
                      </Flex>
                    </Well>

                    {/* Face Groups Grid */}
                    {loading ? (
                      <Flex justifyContent="center" paddingY="size-400">
                        <ProgressCircle aria-label="Loading groups..." isIndeterminate />
                      </Flex>
                    ) : groups.length === 0 && stats.totalGroups > 0 ? (
                      <Well>
                        <Text UNSAFE_style={{ color: '#475569' }}>
                          No face groups match this filter or search.
                        </Text>
                      </Well>
                    ) : groups.length === 0 ? (
                      <Well>
                        <Flex direction="column" gap="size-150" alignItems="start">
                          <Heading level={3} margin={0}>
                            No Face Groups Indexed Yet
                          </Heading>
                          <Text UNSAFE_style={{ color: '#475569' }}>
                            Select one or more assets in AEM Assets View and click{' '}
                            <strong>Recognize Faces</strong> in the bottom action bar, upload
                            images to a folder with the <strong>Face Recognition</strong>{' '}
                            Processing Profile enabled, or click{' '}
                            <strong>Scan Current Folder</strong> above.
                          </Text>
                        </Flex>
                      </Well>
                    ) : (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                          gap: 16
                        }}
                      >
                        {groups.map((grp) => {
                          const isSelected = grp.groupId === selectedGroupId;
                          const isCheckedForMerge = selectedGroupIdsForMerge.includes(
                            grp.groupId
                          );
                          return (
                            <div
                              key={grp.groupId}
                              onClick={() => handleSelectGroupForDetail(grp)}
                              style={{
                                border: isSelected
                                  ? '2px solid #0284c7'
                                  : '1px solid #cbd5e1',
                                borderRadius: 12,
                                padding: 14,
                                background: isSelected ? '#f0f9ff' : '#ffffff',
                                cursor: 'pointer',
                                boxShadow: '0 1px 2px rgba(0,0,0,0.04)'
                              }}
                            >
                              <Flex justifyContent="space-between" alignItems="start">
                                <Checkbox
                                  isSelected={isCheckedForMerge}
                                  onChange={(checked) => {
                                    setSelectedGroupIdsForMerge((prev) =>
                                      checked
                                        ? [...prev, grp.groupId]
                                        : prev.filter((id) => id !== grp.groupId)
                                    );
                                  }}
                                >
                                  <span style={{ fontSize: 11, color: '#64748b' }}>
                                    Select to Merge
                                  </span>
                                </Checkbox>
                                <span
                                  style={{
                                    fontSize: 10,
                                    padding: '2px 7px',
                                    borderRadius: 999,
                                    fontWeight: 600,
                                    background: grp.isNamed ? '#dcfce7' : '#fef3c7',
                                    color: grp.isNamed ? '#166534' : '#92400e'
                                  }}
                                >
                                  {grp.isNamed ? 'Named' : 'Placeholder'}
                                </span>
                              </Flex>

                              <Flex
                                direction="column"
                                alignItems="center"
                                gap="size-100"
                                marginTop="size-100"
                              >
                                <img
                                  src={grp.coverAvatarDataUrl}
                                  alt={grp.displayName}
                                  style={{
                                    width: 88,
                                    height: 88,
                                    borderRadius: '50%',
                                    objectFit: 'cover',
                                    border: '3px solid #e2e8f0'
                                  }}
                                />
                                <Text
                                  UNSAFE_style={{
                                    fontWeight: 700,
                                    fontSize: 15,
                                    color: '#0f172a',
                                    textAlign: 'center'
                                  }}
                                >
                                  {grp.displayName}
                                </Text>
                                <Text UNSAFE_style={{ fontSize: 12, color: '#475569' }}>
                                  {grp.faceCount} face(s) • {grp.assetCount} asset(s)
                                </Text>
                              </Flex>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Pagination */}
                    {!loading && stats.matchedCount > GROUP_PAGE_SIZE && (
                      <Flex justifyContent="space-between" alignItems="center">
                        <Text UNSAFE_style={{ fontSize: 12, color: '#475569' }}>
                          Showing {groupOffset + 1}–{groupOffset + groups.length} of{' '}
                          {stats.matchedCount} group(s)
                        </Text>
                        <Flex gap="size-100">
                          <Button
                            variant="secondary"
                            isDisabled={groupOffset === 0}
                            onPress={() => setGroupOffset(Math.max(0, groupOffset - GROUP_PAGE_SIZE))}
                          >
                            Previous
                          </Button>
                          <Button
                            variant="secondary"
                            isDisabled={!stats.hasMore}
                            onPress={() => setGroupOffset(groupOffset + GROUP_PAGE_SIZE)}
                          >
                            Next
                          </Button>
                        </Flex>
                      </Flex>
                    )}
                  </Flex>
                </View>

                {/* Right Column: Selected Group Inspector (Rename, Split Face, Merge Group) */}
                <View flex="2" minWidth="380px">
                  <Well>
                    {!activeGroup && selectedGroupId ? (
                      <Flex justifyContent="center" paddingY="size-400">
                        <ProgressCircle aria-label="Loading group..." isIndeterminate />
                      </Flex>
                    ) : !activeGroup ? (
                      <Flex direction="column" gap="size-100" paddingY="size-300">
                        <Heading level={3} margin={0}>
                          Select a Face Group
                        </Heading>
                        <Text UNSAFE_style={{ color: '#475569' }}>
                          Click any Face Group card on the left to name the person, inspect
                          all individual face avatars inside that group, remove/split a
                          misgrouped face into its own group, or combine groups.
                        </Text>
                      </Flex>
                    ) : (
                      <Flex direction="column" gap="size-200">
                        <Flex justifyContent="space-between" alignItems="center">
                          <Heading level={3} margin={0}>
                            Manage Group: {activeGroup.displayName}
                          </Heading>
                          <Text UNSAFE_style={{ fontSize: 11, color: '#64748b' }}>
                            ID: <code>{activeGroup.groupId}</code>
                          </Text>
                        </Flex>

                        {/* 1. Name / Rename Group */}
                        <Flex gap="size-100" alignItems="end">
                          <TextField
                            label={`Person Name (synced to ${settings.metadataProperty} on ${activeGroup.assetCount} asset(s))`}
                            value={groupNameInput}
                            onChange={setGroupNameInput}
                            placeholder={`Leave blank to use placeholder (${activeGroup.autoLabel})`}
                            width="100%"
                          />
                          <Button variant="cta" onPress={handleRenameActiveGroup}>
                            Save Name
                          </Button>
                        </Flex>

                        {/* 2. Combine Entire Group Into Another Group */}
                        {groupOptions.length > 1 && (
                          <Flex gap="size-100" alignItems="end">
                            <Picker
                              label="Combine this entire group into another group:"
                              width="100%"
                              onSelectionChange={(targetId) =>
                                handleMergeGroups([activeGroup.groupId], targetId)
                              }
                            >
                              {groupOptions
                                .filter((g) => g.groupId !== activeGroup.groupId)
                                .map((g) => renderGroupPickerItem(g))}
                            </Picker>
                          </Flex>
                        )}

                        <Divider size="S" />

                        {/* 3. Individual Faces in Group (Select to Split or Reassign) */}
                        <Flex justifyContent="space-between" alignItems="center">
                          <Text UNSAFE_style={{ fontWeight: 700, fontSize: 13 }}>
                            Faces in this Group ({activeGroup.faceCount})
                          </Text>
                          <Text UNSAFE_style={{ fontSize: 11, color: '#64748b' }}>
                            Check face(s) below to remove/split or move
                          </Text>
                        </Flex>

                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(145px, 1fr))',
                            gap: 12
                          }}
                        >
                          {activeGroup.faces.map((face) => {
                            const isFaceSelected = selectedFaceIds.includes(face.faceId);
                            return (
                              <div
                                key={face.faceId}
                                onClick={() =>
                                  setSelectedFaceIds((prev) =>
                                    prev.includes(face.faceId)
                                      ? prev.filter((id) => id !== face.faceId)
                                      : [...prev, face.faceId]
                                  )
                                }
                                style={{
                                  border: isFaceSelected
                                    ? '2px solid #0284c7'
                                    : '1px solid #cbd5e1',
                                  borderRadius: 10,
                                  padding: 10,
                                  background: isFaceSelected ? '#e0f2fe' : '#ffffff',
                                  cursor: 'pointer'
                                }}
                              >
                                <Flex direction="column" alignItems="center" gap="size-75">
                                  <img
                                    src={face.avatarDataUrl}
                                    alt={face.faceId}
                                    style={{
                                      width: 72,
                                      height: 72,
                                      borderRadius: 10,
                                      objectFit: 'cover'
                                    }}
                                  />
                                  <Text
                                    UNSAFE_style={{
                                      fontSize: 11,
                                      fontWeight: 600,
                                      color: '#1e293b',
                                      textAlign: 'center',
                                      wordBreak: 'break-all'
                                    }}
                                  >
                                    {face.assetTitle}
                                  </Text>
                                  <Text UNSAFE_style={{ fontSize: 10, color: '#64748b' }}>
                                    {face.confidence}% conf
                                  </Text>
                                  <Checkbox isSelected={isFaceSelected}>
                                    <span style={{ fontSize: 11 }}>Select</span>
                                  </Checkbox>
                                </Flex>
                              </div>
                            );
                          })}
                        </div>

                        {activeGroupHasMoreFaces && (
                          <Flex justifyContent="center">
                            <Button
                              variant="secondary"
                              isDisabled={loadingMoreFaces}
                              onPress={handleLoadMoreFaces}
                            >
                              {loadingMoreFaces
                                ? 'Loading...'
                                : `Load more faces (${activeGroup.faces.length} of ${activeGroup.faceCount})`}
                            </Button>
                          </Flex>
                        )}

                        {/* Actions when 1 or more faces are checked */}
                        {selectedFaceIds.length > 0 && (
                          <View
                            backgroundColor="gray-100"
                            padding="size-150"
                            borderRadius="small"
                          >
                            <Flex direction="column" gap="size-150">
                              <Text UNSAFE_style={{ fontWeight: 700, fontSize: 13 }}>
                                Actions for {selectedFaceIds.length} Selected Face(s):
                              </Text>

                              {/* Option A: Remove from group & make its own group */}
                              <Flex gap="size-100" alignItems="end">
                                <TextField
                                  label="Split into a New Standalone Group (optional name):"
                                  value={splitNewGroupName}
                                  onChange={setSplitNewGroupName}
                                  placeholder="Leave blank for Person #N"
                                  width="100%"
                                />
                                <Button
                                  variant="primary"
                                  onPress={handleSplitSelectedFaces}
                                >
                                  Split to New Group
                                </Button>
                              </Flex>

                              {/* Option B: Move selected face(s) to another existing group */}
                              {groupOptions.length > 1 && (
                                <Flex gap="size-100" alignItems="end">
                                  <Picker
                                    label="Or combine selected face(s) into existing group:"
                                    selectedKey={moveTargetGroupId}
                                    onSelectionChange={setMoveTargetGroupId}
                                    width="100%"
                                  >
                                    {groupOptions
                                      .filter((g) => g.groupId !== activeGroup.groupId)
                                      .map((g) => renderGroupPickerItem(g))}
                                  </Picker>
                                  <Button
                                    variant="secondary"
                                    isDisabled={!moveTargetGroupId}
                                    onPress={handleMoveSelectedFaces}
                                  >
                                    Move Faces
                                  </Button>
                                </Flex>
                              )}
                            </Flex>
                          </View>
                        )}
                      </Flex>
                    )}
                  </Well>
                </View>
              </Flex>
            </Item>

            {/* ============================================================ */}
            {/* TAB 2: BYOK AWS REKOGNITION & METADATA SETTINGS              */}
            {/* ============================================================ */}
            <Item key="settings">
              <Flex direction="column" gap="size-300">
                <Flex gap="size-300" wrap>
                  {/* Customer BYOK AWS Rekognition Credentials */}
                  <Well flex="1" minWidth="400px">
                    <Flex direction="column" gap="size-200">
                      <Heading level={3} margin={0}>
                        Customer AWS Rekognition Credentials (BYOK)
                      </Heading>
                      <Text UNSAFE_style={{ color: '#475569', fontSize: 13 }}>
                        Supply your AWS account credentials for Rekognition Collections. The
                        Secret Access Key is encrypted with AES-256-GCM at rest in App Builder
                        storage and never returned in plaintext.
                      </Text>

                      <TextField
                        label="AWS Region"
                        value={settings.awsRegion}
                        onChange={(v) => setSettings((s) => ({ ...s, awsRegion: v }))}
                        placeholder="us-east-1"
                        width="100%"
                      />

                      <TextField
                        label="AWS Access Key ID"
                        value={settings.awsAccessKeyId}
                        onChange={(v) => setSettings((s) => ({ ...s, awsAccessKeyId: v }))}
                        placeholder="AKIA..."
                        width="100%"
                      />

                      <TextField
                        label={`AWS Secret Access Key ${
                          settings.hasAwsSecretKey
                            ? `(Stored: ${settings.awsSecretKeyMasked})`
                            : '(Not set)'
                        }`}
                        type="password"
                        value={settings.awsSecretAccessKey}
                        onChange={(v) =>
                          setSettings((s) => ({ ...s, awsSecretAccessKey: v }))
                        }
                        placeholder={
                          settings.hasAwsSecretKey
                            ? 'Leave blank to keep existing secret key'
                            : 'Enter AWS Secret Access Key'
                        }
                        width="100%"
                      />

                      <TextField
                        label="Rekognition Collection ID"
                        value={settings.collectionId}
                        onChange={(v) => setSettings((s) => ({ ...s, collectionId: v }))}
                        placeholder="aem-assets-faces"
                        width="100%"
                      />

                      <TextField
                        label="Face Matching Similarity Threshold (%)"
                        value={String(settings.similarityThreshold)}
                        onChange={(v) =>
                          setSettings((s) => ({
                            ...s,
                            similarityThreshold: Number(v) || 85
                          }))
                        }
                        width="100%"
                      />

                      <View>
                        <ActionButton onPress={handleTestAwsConnection}>
                          Test AWS Connection & Verify Collection
                        </ActionButton>
                      </View>
                    </Flex>
                  </Well>

                  {/* AEM Metadata & Processing Profile Rules */}
                  <Well flex="1" minWidth="400px">
                    <Flex direction="column" gap="size-200">
                      <Heading level={3} margin={0}>
                        AEM Metadata & Processing Profile Scope
                      </Heading>

                      <TextField
                        label="Target AEM Asset Metadata Property (multi-value String[])"
                        value={settings.metadataProperty}
                        onChange={(v) =>
                          setSettings((s) => ({ ...s, metadataProperty: v }))
                        }
                        placeholder="xdm:faceNames"
                        width="100%"
                      />

                      <Switch
                        isSelected={settings.includeUnnamedInMetadata}
                        onChange={(val) =>
                          setSettings((s) => ({ ...s, includeUnnamedInMetadata: val }))
                        }
                      >
                        Include unnamed placeholder labels (e.g. &quot;Person #3&quot;) in{' '}
                        <code>{settings.metadataProperty}</code>
                      </Switch>
                      <Text UNSAFE_style={{ fontSize: 12, color: '#64748b' }}>
                        When enabled, newly clustered groups appear as placeholder names (e.g.{' '}
                        <code>Person #3</code>) on the asset&apos;s{' '}
                        <code>{settings.metadataProperty}</code> property immediately. Turn off
                        to only write names to <code>{settings.metadataProperty}</code> after an
                        admin names the group.
                      </Text>

                      <Divider size="S" />

                      <Switch
                        isSelected={settings.requireProcessingProfile}
                        onChange={(val) =>
                          setSettings((s) => ({ ...s, requireProcessingProfile: val }))
                        }
                      >
                        Only auto-process uploads in folders with Face Recognition Processing
                        Profile enabled
                      </Switch>

                      <TextField
                        label="AEM Processing Profile Name"
                        value={settings.processingProfileName}
                        onChange={(v) =>
                          setSettings((s) => ({ ...s, processingProfileName: v }))
                        }
                        placeholder="Face Recognition"
                        width="100%"
                      />

                      <Divider size="S" />

                      <Heading level={4} margin={0}>
                        AWS cost controls
                      </Heading>
                      <TextField
                        label="Image types to analyze (comma-separated)"
                        value={settings.allowedImageTypesText}
                        onChange={(v) => setSettings((s) => ({ ...s, allowedImageTypesText: v }))}
                        width="100%"
                      />
                      <TextField
                        label="Skip images smaller than (pixels, shorter side)"
                        value={String(settings.minImageSize ?? '')}
                        onChange={(v) => setSettings((s) => ({ ...s, minImageSize: v }))}
                        inputMode="numeric"
                        width="size-3000"
                      />
                      <Text UNSAFE_style={{ fontSize: 12, color: '#64748b' }}>
                        Other file types (PDFs, videos, SVGs, GIFs...) and small images such as
                        logos and icons are never sent to AWS. Folder scans also skip images that
                        were already scanned unless &quot;Include already-scanned images&quot; is
                        checked.
                      </Text>
                    </Flex>
                  </Well>
                </Flex>

                <Flex justifyContent="end">
                  <Button variant="cta" onPress={handleSaveSettings}>
                    Save Settings & Sync Asset Metadata
                  </Button>
                </Flex>
              </Flex>
            </Item>
          </TabPanels>
        </Tabs>
      </Flex>
    </View>
  );
}

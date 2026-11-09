import React, { useEffect, useState, useCallback } from 'react';
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
  ProgressCircle
} from '@adobe/react-spectrum';
import { api } from '../utils/api';
import { extensionId, STORAGE_KEY_CTX } from './Constants';

export default function AdminConsole() {
  const navigate = useNavigate();

  const [guestConnection, setGuestConnection] = useState(null);
  const [hostContext, setHostContext] = useState({
    inAemHost: false,
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
        const gc = await attach({ id: extensionId });
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
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const [groups, setGroups] = useState([]);
  const [stats, setStats] = useState({ totalGroups: 0, totalFaces: 0, totalAssets: 0 });
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
    enabledFoldersText: '/content/dam/events\n/content/dam/campaigns'
  });

  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'named' | 'unnamed'
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [selectedGroupIdsForMerge, setSelectedGroupIdsForMerge] = useState([]);
  const [mergeTargetGroupId, setMergeTargetGroupId] = useState('');

  // Active Group Detail Drawer state
  const [groupNameInput, setGroupNameInput] = useState('');
  const [selectedFaceIds, setSelectedFaceIds] = useState([]);
  const [splitNewGroupName, setSplitNewGroupName] = useState('');
  const [moveTargetGroupId, setMoveTargetGroupId] = useState('');

  // Scan Folder / Asset tab state
  const [scanFolderPath, setScanFolderPath] = useState('/content/dam/events/2026-summit');
  const [scanAssetPath, setScanAssetPath] = useState(
    '/content/dam/events/2026-summit/keynote-panel.jpg'
  );
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);

  const [banner, setBanner] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [groupsRes, settingsRes] = await Promise.all([
        api.listGroups(hostContext),
        api.getSettings(hostContext)
      ]);
      const loadedGroups = groupsRes.groups || [];
      setGroups(loadedGroups);
      setStats({
        totalGroups: groupsRes.totalGroups || loadedGroups.length,
        totalFaces: groupsRes.totalFaces || 0,
        totalAssets: groupsRes.totalAssets || 0
      });

      if (settingsRes.settings) {
        setSettings((prev) => ({
          ...prev,
          ...settingsRes.settings,
          awsSecretAccessKey: '',
          enabledFoldersText: (settingsRes.settings.enabledFolders || ['/content/dam']).join('\n')
        }));
      }

      if (selectedGroupId) {
        const updatedActive = loadedGroups.find((g) => g.groupId === selectedGroupId);
        if (updatedActive) {
          setGroupNameInput(updatedActive.name || '');
        } else {
          setSelectedGroupId(null);
        }
      }
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId, hostContext]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const activeGroup = groups.find((g) => g.groupId === selectedGroupId) || null;

  const handleSelectGroupForDetail = (grp) => {
    setSelectedGroupId(grp.groupId);
    setGroupNameInput(grp.name || '');
    setSelectedFaceIds([]);
    setSplitNewGroupName('');
    setMoveTargetGroupId('');
  };

  const handleRenameActiveGroup = async () => {
    if (!activeGroup) return;
    try {
      const res = await api.renameGroup(activeGroup.groupId, groupNameInput, hostContext);
      await loadAll();
      setBanner({
        type: 'positive',
        text: `Saved name "${res.group.displayName}" and updated ${settings.metadataProperty} across ${res.syncedAssetCount} asset(s).`
      });
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
      setBanner({
        type: 'positive',
        text: `Split ${res.newGroup.faceCount} face(s) into new group "${res.newGroup.displayName}" and updated AEM metadata.`
      });
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
      setBanner({
        type: 'positive',
        text: `Moved face(s) into "${res.targetGroup.displayName}" and recomputed AEM metadata.`
      });
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
      setBanner({
        type: 'positive',
        text: `Combined ${res.movedFaceCount} face(s) into "${res.targetGroup.displayName}" and synced ${res.syncedAssetCount} asset(s).`
      });
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    }
  };

  const handleSaveSettings = async () => {
    try {
      const payload = {
        ...settings,
        enabledFolders: settings.enabledFoldersText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      };
      const res = await api.saveSettings(payload, hostContext);
      await loadAll();
      setBanner({
        type: 'positive',
        text: `Settings saved. ${
          res.resyncedAssets
            ? `Re-synced ${settings.metadataProperty} across ${res.resyncedAssets} asset(s).`
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
    setScanResult(null);
    try {
      const res = await api.scanFolder(scanFolderPath, hostContext);
      setScanResult(res);
      await loadAll();
      setBanner({
        type: 'positive',
        text: `Folder scan complete for ${res.folderPath} (${res.totalAssets} assets processed).`
      });
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    } finally {
      setScanning(false);
    }
  };

  const handleRunSingleAssetScan = async () => {
    setScanning(true);
    try {
      const res = await api.ingestAsset({ assetPath: scanAssetPath, force: true }, hostContext);
      await loadAll();
      setBanner({
        type: 'positive',
        text: `Scanned ${scanAssetPath}: detected ${res.faceCount || 0} face(s).`
      });
    } catch (err) {
      setBanner({ type: 'negative', text: err.message });
    } finally {
      setScanning(false);
    }
  };

  const handleResetDemoData = async () => {
    await api.seedDemoData(hostContext);
    setSelectedGroupId(null);
    await loadAll();
    setBanner({
      type: 'positive',
      text: 'Reset sample Face Groups and multi-face AEM assets.'
    });
  };

  const filteredGroups = groups.filter((g) => {
    if (filterMode === 'named' && !g.isNamed) return false;
    if (filterMode === 'unnamed' && g.isNamed) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        g.displayName.toLowerCase().includes(q) ||
        g.groupId.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <View padding="size-300" maxWidth="1280px" marginX="auto">
      <Flex direction="column" gap="size-250">
        {/* Top Navigation Header */}
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
            <ActionButton onPress={handleResetDemoData}>Reset Sample Data</ActionButton>
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
            <Item key="groups">1. Face Groups & Split / Merge Manager</Item>
            <Item key="scan">2. Scan Folder / On-Demand Ingest</Item>
            <Item key="settings">3. BYOK AWS Rekognition & Metadata Settings</Item>
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
                            onSelectionChange={setFilterMode}
                            width="size-2000"
                          >
                            <Item key="all">All Groups ({groups.length})</Item>
                            <Item key="named">
                              Named People ({groups.filter((g) => g.isNamed).length})
                            </Item>
                            <Item key="unnamed">
                              Unnamed Placeholders ({groups.filter((g) => !g.isNamed).length})
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
                              {groups
                                .filter((g) => selectedGroupIdsForMerge.includes(g.groupId))
                                .map((g) => (
                                  <Item key={g.groupId}>{g.displayName}</Item>
                                ))}
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
                    ) : (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                          gap: 16
                        }}
                      >
                        {filteredGroups.map((grp) => {
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
                  </Flex>
                </View>

                {/* Right Column: Selected Group Inspector (Rename, Split Face, Merge Group) */}
                <View flex="2" minWidth="380px">
                  <Well>
                    {!activeGroup ? (
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
                        {groups.length > 1 && (
                          <Flex gap="size-100" alignItems="end">
                            <Picker
                              label="Combine this entire group into another group:"
                              width="100%"
                              onSelectionChange={(targetId) =>
                                handleMergeGroups([activeGroup.groupId], targetId)
                              }
                            >
                              {groups
                                .filter((g) => g.groupId !== activeGroup.groupId)
                                .map((g) => (
                                  <Item key={g.groupId}>
                                    {`${g.displayName} (${g.faceCount} faces)`}
                                  </Item>
                                ))}
                            </Picker>
                          </Flex>
                        )}

                        <Divider size="S" />

                        {/* 3. Individual Faces in Group (Select to Split or Reassign) */}
                        <Flex justifyContent="space-between" alignItems="center">
                          <Text UNSAFE_style={{ fontWeight: 700, fontSize: 13 }}>
                            Faces in this Group ({activeGroup.faces.length})
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
                              {groups.length > 1 && (
                                <Flex gap="size-100" alignItems="end">
                                  <Picker
                                    label="Or combine selected face(s) into existing group:"
                                    selectedKey={moveTargetGroupId}
                                    onSelectionChange={setMoveTargetGroupId}
                                    width="100%"
                                  >
                                    {groups
                                      .filter((g) => g.groupId !== activeGroup.groupId)
                                      .map((g) => (
                                        <Item key={g.groupId}>
                                          {`${g.displayName} (${g.faceCount} faces)`}
                                        </Item>
                                      ))}
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
            {/* TAB 2: SCAN FOLDER / ON-DEMAND INGEST                        */}
            {/* ============================================================ */}
            <Item key="scan">
              <Flex gap="size-300" wrap>
                <Well flex="1" minWidth="360px">
                  <Flex direction="column" gap="size-200">
                    <Heading level={3} margin={0}>
                      Scan Entire DAM Folder
                    </Heading>
                    <Text>
                      Indexes all image assets in the specified AEM DAM folder through AWS
                      Rekognition, crops 160×160 face avatars, clusters matching faces, and
                      writes <code>{settings.metadataProperty}</code> metadata to each asset.
                    </Text>
                    <TextField
                      label="AEM DAM Folder Path"
                      value={scanFolderPath}
                      onChange={setScanFolderPath}
                      width="100%"
                    />
                    <View>
                      <Button
                        variant="cta"
                        onPress={handleRunFolderScan}
                        isDisabled={scanning}
                      >
                        {scanning ? 'Scanning Folder...' : 'Scan DAM Folder'}
                      </Button>
                    </View>
                    {scanResult && (
                      <View marginTop="size-100">
                        <Text UNSAFE_style={{ fontWeight: 700 }}>
                          Processed {scanResult.totalAssets} asset(s) in {scanResult.folderPath}
                        </Text>
                      </View>
                    )}
                  </Flex>
                </Well>

                <Well flex="1" minWidth="360px">
                  <Flex direction="column" gap="size-200">
                    <Heading level={3} margin={0}>
                      Scan Single AEM Asset
                    </Heading>
                    <Text>
                      Run or re-run facial recognition on a single AEM asset path immediately.
                    </Text>
                    <TextField
                      label="AEM Asset DAM Path"
                      value={scanAssetPath}
                      onChange={setScanAssetPath}
                      width="100%"
                    />
                    <View>
                      <Button
                        variant="primary"
                        onPress={handleRunSingleAssetScan}
                        isDisabled={scanning}
                      >
                        {scanning ? 'Scanning Asset...' : 'Scan Single Asset'}
                      </Button>
                    </View>
                  </Flex>
                </Well>
              </Flex>
            </Item>

            {/* ============================================================ */}
            {/* TAB 3: BYOK AWS REKOGNITION & METADATA SETTINGS              */}
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

                      <TextField
                        label="Enabled DAM Folder Prefixes (one path per line)"
                        value={settings.enabledFoldersText}
                        onChange={(v) =>
                          setSettings((s) => ({ ...s, enabledFoldersText: v }))
                        }
                        width="100%"
                      />
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

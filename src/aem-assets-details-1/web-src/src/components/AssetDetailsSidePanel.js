import React, { useEffect, useState, useCallback } from 'react';
import { attach } from '@adobe/uix-sdk';
import { useNavigate } from 'react-router-dom';
import {
  View,
  Flex,
  Heading,
  Text,
  Button,
  ActionButton,
  TextField,
  Picker,
  Item,
  Divider,
  ProgressCircle,
  StatusLight,
  Badge,
  Well
} from '@adobe/react-spectrum';
import { api } from '../utils/api';

const EXTENSION_ID = 'aem-assets-face-recognition';

const DEMO_ASSETS = [
  {
    assetId: 'urn:aaid:aem:demo-keynote-panel',
    assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
    label: 'keynote-panel.jpg (3 faces)'
  },
  {
    assetId: 'urn:aaid:aem:demo-backstage-chat',
    assetPath: '/content/dam/events/2026-summit/backstage-chat.jpg',
    label: 'backstage-chat.jpg (2 faces)'
  },
  {
    assetId: 'urn:aaid:aem:demo-executive-portrait',
    assetPath: '/content/dam/events/2026-summit/executive-portrait.jpg',
    label: 'executive-portrait.jpg (1 face)'
  },
  {
    assetId: 'urn:aaid:aem:demo-workshop-session',
    assetPath: '/content/dam/events/2026-summit/workshop-session.jpg',
    label: 'workshop-session.jpg (1 unnamed face)'
  }
];

export default function AssetDetailsSidePanel() {
  const navigate = useNavigate();

  const [hostContext, setHostContext] = useState({
    inAemHost: false,
    imsToken: null,
    imsOrg: null,
    aemHost: null,
    assetId: DEMO_ASSETS[0].assetId,
    assetPath: DEMO_ASSETS[0].assetPath
  });

  const [assetData, setAssetData] = useState(null);
  const [allGroups, setAllGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [hoveredFaceId, setHoveredFaceId] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [movingFaceId, setMovingFaceId] = useState(null);
  const [statusBanner, setStatusBanner] = useState(null);

  // Attach to AEM Assets View guest connection if running inside AEM iframe
  useEffect(() => {
    let mounted = true;
    const connectToHost = async () => {
      try {
        const guestConnection = await attach({ id: EXTENSION_ID });
        const sharedContext = guestConnection?.sharedContext;
        if (sharedContext && mounted) {
          const auth = sharedContext.get('auth') || {};
          const asset = sharedContext.get('asset') || {};
          const aemHost = sharedContext.get('aemHost') || auth.aemHost || null;
          setHostContext((prev) => ({
            ...prev,
            inAemHost: true,
            imsToken: auth.imsToken || null,
            imsOrg: auth.imsOrg || null,
            aemHost,
            assetId: asset.assetId || asset.id || prev.assetId,
            assetPath: asset.path || asset.assetPath || prev.assetPath
          }));
        }
      } catch (e) {
        // Standalone mode outside AEM iframe
      }
    };
    connectToHost();
    return () => {
      mounted = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [facesRes, groupsRes] = await Promise.all([
        api.getAssetFaces(
          { assetId: hostContext.assetId, assetPath: hostContext.assetPath },
          hostContext
        ),
        api.listGroups(hostContext)
      ]);
      setAssetData(facesRes);
      setAllGroups(groupsRes.groups || []);
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [hostContext]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRescanAsset = async () => {
    setScanning(true);
    setStatusBanner(null);
    try {
      const res = await api.ingestAsset(
        { assetId: hostContext.assetId, assetPath: hostContext.assetPath },
        hostContext
      );
      setAssetData(res);
      const groupsRes = await api.listGroups(hostContext);
      setAllGroups(groupsRes.groups || []);
      setStatusBanner({
        type: 'positive',
        text: `Scanned ${res.faceCount || 0} face(s) and synced ${res.metadataProperty || 'xdm:faceNames'}.`
      });
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    } finally {
      setScanning(false);
    }
  };

  const handleSaveGroupName = async (groupId) => {
    try {
      const res = await api.renameGroup(groupId, editingNameValue, hostContext);
      setEditingGroupId(null);
      setEditingNameValue('');
      await loadData();
      setStatusBanner({
        type: 'positive',
        text: `Updated group name to "${res.group.displayName}" across ${res.syncedAssetCount} asset(s).`
      });
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const handleSplitFaceToOwnGroup = async (face) => {
    try {
      const res = await api.splitFaces([face.faceId], null, hostContext);
      await loadData();
      setStatusBanner({
        type: 'positive',
        text: `Removed face from "${face.groupDisplayName}" into new group "${res.newGroup.displayName}". Updated asset metadata.`
      });
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const handleMoveFaceToGroup = async (faceId, targetGroupId) => {
    if (!targetGroupId) return;
    try {
      const res = await api.moveFaces([faceId], targetGroupId, hostContext);
      setMovingFaceId(null);
      await loadData();
      setStatusBanner({
        type: 'positive',
        text: `Combined face into "${res.targetGroup.displayName}" and updated asset metadata.`
      });
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const faces = assetData?.faces || [];
  const faceNames = assetData?.faceNames || [];
  const metadataProp = assetData?.metadataProperty || 'xdm:faceNames';

  return (
    <View
      padding="size-200"
      UNSAFE_style={{
        maxWidth: 420,
        margin: '0 auto',
        background: '#ffffff',
        minHeight: '100vh',
        borderLeft: '1px solid #e2e8f0',
        borderRight: '1px solid #e2e8f0'
      }}
    >
      <Flex direction="column" gap="size-200">
        {/* Top Header */}
        <Flex justifyContent="space-between" alignItems="center">
          <Flex alignItems="center" gap="size-100">
            <Heading level={3} margin={0}>
              Recognized Faces
            </Heading>
            <Badge variant="info">{faces.length}</Badge>
          </Flex>
          <Flex gap="size-100">
            <ActionButton isQuiet onPress={() => navigate('/admin')}>
              Manage All Groups
            </ActionButton>
            <Button
              variant="secondary"
              onPress={handleRescanAsset}
              isDisabled={scanning}
            >
              {scanning ? 'Scanning...' : 'Re-scan'}
            </Button>
          </Flex>
        </Flex>

        {/* Demo Asset Switcher when previewing outside AEM iframe */}
        {!hostContext.inAemHost && (
          <View
            backgroundColor="gray-100"
            padding="size-125"
            borderRadius="small"
          >
            <Picker
              label="Previewing AEM Asset (Side Panel Simulator)"
              width="100%"
              selectedKey={hostContext.assetId}
              onSelectionChange={(key) => {
                const found = DEMO_ASSETS.find((a) => a.assetId === key);
                if (found) {
                  setHostContext((prev) => ({
                    ...prev,
                    assetId: found.assetId,
                    assetPath: found.assetPath
                  }));
                }
              }}
            >
              {DEMO_ASSETS.map((item) => (
                <Item key={item.assetId}>{item.label}</Item>
              ))}
            </Picker>
          </View>
        )}

        {statusBanner && (
          <View
            padding="size-125"
            borderRadius="small"
            UNSAFE_style={{
              background: statusBanner.type === 'negative' ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${statusBanner.type === 'negative' ? '#fecaca' : '#bbf7d0'}`,
              color: statusBanner.type === 'negative' ? '#991b1b' : '#166534',
              fontSize: 12
            }}
          >
            {statusBanner.text}
          </View>
        )}

        {/* Interactive Bounding Box Locator */}
        {faces.length > 0 && (
          <View>
            <Text UNSAFE_style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 6 }}>
              FACE LOCATIONS IN ASSET (HOVER AVATAR TO HIGHLIGHT)
            </Text>
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: 150,
                borderRadius: 8,
                background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
                overflow: 'hidden',
                border: '1px solid #cbd5e1'
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  bottom: 6,
                  left: 10,
                  fontSize: 11,
                  color: '#94a3b8'
                }}
              >
                {assetData?.assetTitle || hostContext.assetPath?.split('/').pop()}
              </div>
              {faces.map((face, idx) => {
                const box = face.boundingBox || { left: 0.2, top: 0.2, width: 0.15, height: 0.25 };
                const isHovered = hoveredFaceId === face.faceId;
                const isNamed = Boolean(face.groupName);
                return (
                  <div
                    key={face.faceId}
                    onMouseEnter={() => setHoveredFaceId(face.faceId)}
                    onMouseLeave={() => setHoveredFaceId(null)}
                    title={`${face.groupDisplayName} (${face.confidence}%)`}
                    style={{
                      position: 'absolute',
                      left: `${box.left * 100}%`,
                      top: `${box.top * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                      border: isHovered
                        ? '2.5px solid #38bdf8'
                        : isNamed
                        ? '2px solid #4ade80'
                        : '2px dashed #fbbf24',
                      borderRadius: 6,
                      background: isHovered ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255,255,255,0.06)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      display: 'flex',
                      alignItems: 'flex-end',
                      justifyContent: 'center'
                    }}
                  >
                    <span
                      style={{
                        background: 'rgba(15, 23, 42, 0.85)',
                        color: '#fff',
                        fontSize: 10,
                        padding: '1px 5px',
                        borderRadius: 4,
                        whiteSpace: 'nowrap',
                        transform: 'translateY(110%)'
                      }}
                    >
                      #{idx + 1} {face.groupDisplayName}
                    </span>
                  </div>
                );
              })}
            </div>
          </View>
        )}

        {/* AEM Asset Metadata (`xdm:faceNames`) Live Section */}
        <Well>
          <Flex direction="column" gap="size-75">
            <Flex justifyContent="space-between" alignItems="center">
              <Text UNSAFE_style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>
                AEM Asset Metadata (<code>{metadataProp}</code>)
              </Text>
              <Text UNSAFE_style={{ fontSize: 11, color: '#64748b' }}>
                Multi-value String[]
              </Text>
            </Flex>
            {faceNames.length === 0 ? (
              <Text UNSAFE_style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>
                No face group names written to metadata yet.
              </Text>
            ) : (
              <Flex gap="size-75" wrap marginTop="size-50">
                {faceNames.map((name) => (
                  <span
                    key={name}
                    style={{
                      background: name.startsWith('Person #') ? '#fef3c7' : '#dcfce7',
                      color: name.startsWith('Person #') ? '#92400e' : '#166534',
                      border: `1px solid ${name.startsWith('Person #') ? '#fde68a' : '#86efac'}`,
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600
                    }}
                  >
                    {name}
                  </span>
                ))}
              </Flex>
            )}
          </Flex>
        </Well>

        <Divider size="S" />

        {/* Detected Face Avatar Cards */}
        {loading ? (
          <Flex justifyContent="center" paddingY="size-400">
            <ProgressCircle aria-label="Loading faces..." isIndeterminate />
          </Flex>
        ) : faces.length === 0 ? (
          <Well>
            <Text>No faces detected on this asset yet. Click "Re-scan" to run AWS Rekognition.</Text>
          </Well>
        ) : (
          <Flex direction="column" gap="size-150">
            {faces.map((face, index) => {
              const isEditing = editingGroupId === face.groupId;
              const isMoving = movingFaceId === face.faceId;
              const otherGroups = allGroups.filter((g) => g.groupId !== face.groupId);

              return (
                <div
                  key={face.faceId}
                  onMouseEnter={() => setHoveredFaceId(face.faceId)}
                  onMouseLeave={() => setHoveredFaceId(null)}
                  style={{
                    border:
                      hoveredFaceId === face.faceId
                        ? '1.5px solid #0284c7'
                        : '1px solid #e2e8f0',
                    borderRadius: 10,
                    padding: 12,
                    background: hoveredFaceId === face.faceId ? '#f8fafc' : '#ffffff',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Flex gap="size-150" alignItems="start">
                    {/* 160x160 Cropped Face Avatar */}
                    <img
                      src={face.avatarDataUrl}
                      alt={face.groupDisplayName}
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 12,
                        objectFit: 'cover',
                        border: '2px solid #cbd5e1',
                        flexShrink: 0
                      }}
                    />

                    <Flex direction="column" gap="size-75" flex="1">
                      <Flex justifyContent="space-between" alignItems="center">
                        <Flex alignItems="center" gap="size-75">
                          <Text UNSAFE_style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>
                            {face.groupDisplayName}
                          </Text>
                          {!face.groupName && (
                            <span
                              style={{
                                fontSize: 10,
                                background: '#fef3c7',
                                color: '#92400e',
                                padding: '1px 6px',
                                borderRadius: 4,
                                fontWeight: 600
                              }}
                            >
                              Placeholder
                            </span>
                          )}
                        </Flex>
                        <Text UNSAFE_style={{ fontSize: 11, color: '#64748b' }}>
                          {face.confidence}% conf
                        </Text>
                      </Flex>

                      <Text UNSAFE_style={{ fontSize: 12, color: '#475569' }}>
                        Group ID: <code>{face.groupId}</code> • {face.groupFaceCount} face(s) in group
                      </Text>

                      {/* Inline Rename Group Input */}
                      {isEditing ? (
                        <Flex gap="size-75" alignItems="end" marginTop="size-50">
                          <TextField
                            label="Person Name (updates xdm:faceNames)"
                            value={editingNameValue}
                            onChange={setEditingNameValue}
                            placeholder="e.g. Sarah Jenkins"
                            width="100%"
                          />
                          <Button
                            variant="cta"
                            onPress={() => handleSaveGroupName(face.groupId)}
                          >
                            Save
                          </Button>
                          <ActionButton onPress={() => setEditingGroupId(null)}>
                            Cancel
                          </ActionButton>
                        </Flex>
                      ) : (
                        <Flex gap="size-75" wrap marginTop="size-50">
                          <ActionButton
                            onPress={() => {
                              setEditingGroupId(face.groupId);
                              setEditingNameValue(face.groupName || '');
                            }}
                          >
                            {face.groupName ? 'Rename' : 'Name Person'}
                          </ActionButton>

                          <ActionButton
                            onPress={() => handleSplitFaceToOwnGroup(face)}
                          >
                            Split to New Group
                          </ActionButton>

                          {otherGroups.length > 0 && (
                            <ActionButton
                              onPress={() =>
                                setMovingFaceId(isMoving ? null : face.faceId)
                              }
                            >
                              {isMoving ? 'Close Move' : 'Combine Into...'}
                            </ActionButton>
                          )}
                        </Flex>
                      )}

                      {/* Move / Combine this face into another existing group */}
                      {isMoving && otherGroups.length > 0 && (
                        <View marginTop="size-75">
                          <Picker
                            label="Combine this face into existing group:"
                            width="100%"
                            onSelectionChange={(targetGroupId) =>
                              handleMoveFaceToGroup(face.faceId, targetGroupId)
                            }
                          >
                            {otherGroups.map((g) => (
                              <Item key={g.groupId}>
                                {`${g.displayName} (${g.faceCount} faces)`}
                              </Item>
                            ))}
                          </Picker>
                        </View>
                      )}
                    </Flex>
                  </Flex>
                </div>
              );
            })}
          </Flex>
        )}

        <Divider size="S" />
        <StatusLight variant="positive">
          AWS Rekognition Collection synced with AEM <code>{metadataProp}</code>
        </StatusLight>
      </Flex>
    </View>
  );
}

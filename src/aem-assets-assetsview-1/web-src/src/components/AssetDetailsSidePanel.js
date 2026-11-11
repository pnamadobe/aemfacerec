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
  Picker,
  Item,
  Divider,
  ProgressCircle,
  StatusLight,
  Badge,
  Well
} from '@adobe/react-spectrum';
import { api, resultBanner } from '../utils/api';
import { extensionId, STORAGE_KEY_CTX } from './Constants';

function readInitialHostContext() {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  const sp = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : window.location.search);
  let storedCtx = {};
  try {
    storedCtx = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
  } catch (e) {
    storedCtx = {};
  }
  const tokenFresh =
    Boolean(storedCtx.imsToken) &&
    Number(storedCtx.tokenSavedAt) > 0 &&
    Date.now() - Number(storedCtx.tokenSavedAt) < 5 * 60 * 1000;
  const cachedToken = tokenFresh ? storedCtx.imsToken : null;
  const assetId = sp.get('assetId') || storedCtx.assetId || '';
  const assetPath = sp.get('assetPath') || storedCtx.assetPath || '';
  const assetName = sp.get('assetName') || storedCtx.assetName || '';
  return {
    inAemHost: Boolean(cachedToken),
    hostResolved: Boolean(cachedToken && (assetId || assetPath || assetName)),
    imsToken: cachedToken,
    imsOrg: tokenFresh ? storedCtx.imsOrg || null : null,
    aemHost: sp.get('aemAuthorUrl') || storedCtx.aemAuthorUrl || null,
    assetId,
    assetPath,
    assetName
  };
}

export default function AssetDetailsSidePanel() {
  const navigate = useNavigate();

  const [guestConnection, setGuestConnection] = useState(null);
  const [hostContext, setHostContext] = useState(readInitialHostContext);

  const [assetData, setAssetData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [hoveredFaceId, setHoveredFaceId] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [movingFaceId, setMovingFaceId] = useState(null);
  const [groupOptions, setGroupOptions] = useState(null);
  const [statusBanner, setStatusBanner] = useState(null);

  // Attach to AEM Assets View guest connection if running inside AEM iframe
  useEffect(() => {
    let mounted = true;
    const initial = readInitialHostContext();

    const applyNextCtx = (next) => {
      if (!next || !mounted) return;
      setHostContext((prev) => ({
        ...prev,
        assetId: next.assetId || prev.assetId,
        assetPath: next.assetPath || prev.assetPath,
        assetName: next.assetName || prev.assetName,
        aemHost: next.aemAuthorUrl || prev.aemHost
      }));
    };

    const onStorageChange = (e) => {
      if (e.key === STORAGE_KEY_CTX && e.newValue) {
        try {
          applyNextCtx(JSON.parse(e.newValue));
        } catch (err) {
          // ignore
        }
      }
    };
    window.addEventListener('storage', onStorageChange);

    let bc = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        bc = new BroadcastChannel(STORAGE_KEY_CTX);
        bc.onmessage = (ev) => applyNextCtx(ev?.data);
      } catch (e) {
        bc = null;
      }
    }

    const connectToHost = async () => {
      let imsToken = null;
      let imsOrg = null;
      let aemHost = initial.aemHost;
      let nextAssetId = initial.assetId;
      let nextAssetPath = initial.assetPath;
      let nextAssetName = initial.assetName;
      let inAemHost = false;

      try {
        const gc = await Promise.race([
          attach({ id: extensionId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Host connection timed out')), 3000)
          )
        ]);
        if (!gc || !mounted) return;
        inAemHost = true;
        setGuestConnection(gc);

        try {
          const imsInfo = await gc.host?.auth?.getIMSInfo?.();
          if (imsInfo) {
            imsToken = imsInfo.accessToken || imsInfo.imsToken || null;
            imsOrg = imsInfo.imsOrg || null;
          }
        } catch (e) {
          // fallback to sharedContext
        }

        const sharedContext = gc.sharedContext;
        if (sharedContext && typeof sharedContext.get === 'function') {
          const auth = sharedContext.get('auth') || {};
          const asset =
            sharedContext.get('asset') ||
            sharedContext.get('resource') ||
            {};
          imsToken =
            imsToken ||
            auth.imsToken ||
            auth.accessToken ||
            auth.token ||
            auth.authInfo?.accessToken ||
            null;
          imsOrg = imsOrg || auth.imsOrg || auth.imsOrgId || null;
          aemHost = aemHost || sharedContext.get('aemHost') || auth.aemHost || null;
          nextAssetId =
            nextAssetId ||
            asset.assetId ||
            asset.id ||
            asset['repo:id'] ||
            asset.repositoryMetadata?.['repo:id'] ||
            '';
          nextAssetPath =
            nextAssetPath ||
            asset.path ||
            asset.assetPath ||
            asset.repositoryPath ||
            asset['repo:path'] ||
            asset.repositoryMetadata?.['repo:path'] ||
            '';
          nextAssetName =
            nextAssetName ||
            asset.name ||
            asset['repo:name'] ||
            asset.assetName ||
            asset.repositoryMetadata?.['repo:name'] ||
            '';
        }

        if (imsToken) {
          try {
            const prev = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
            localStorage.setItem(
              STORAGE_KEY_CTX,
              JSON.stringify({
                ...prev,
                imsToken,
                imsOrg: imsOrg || prev.imsOrg || null,
                tokenSavedAt: Date.now(),
                aemAuthorUrl: aemHost || prev.aemAuthorUrl || ''
              })
            );
          } catch (e) {
            // ignore
          }
        }
      } catch (e) {
        // Standalone mode outside AEM iframe
      } finally {
        // Only load data once we know whether an IMS token is available, so the first
        // requests are not sent unauthenticated (they would be rejected with 401).
        if (mounted) {
          setHostContext((prev) => ({
            ...prev,
            inAemHost: inAemHost || prev.inAemHost,
            hostResolved: true,
            imsToken: imsToken || prev.imsToken,
            imsOrg: imsOrg || prev.imsOrg,
            aemHost: aemHost || prev.aemHost,
            assetId: nextAssetId || prev.assetId,
            assetPath: nextAssetPath || prev.assetPath,
            assetName: nextAssetName || prev.assetName
          }));
        }
      }
    };
    connectToHost();
    return () => {
      mounted = false;
      window.removeEventListener('storage', onStorageChange);
      if (bc) {
        try {
          bc.close();
        } catch (e) {
          // ignore
        }
      }
    };
  }, []);

  const {
    hostResolved,
    assetId,
    assetPath,
    assetName,
    aemHost,
    imsToken,
    imsOrg
  } = hostContext;

  const loadData = useCallback(async () => {
    if (!hostResolved) return;
    setLoading(true);
    try {
      const facesRes = await api.getAssetFaces(
        {
          assetId,
          assetPath,
          assetName
        },
        { aemHost, imsToken, imsOrg }
      );
      setAssetData(facesRes);
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [hostResolved, assetId, assetPath, assetName, aemHost, imsToken, imsOrg]);

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
      setStatusBanner(resultBanner(`Scanned ${res.faceCount || 0} face(s) and synced ${res.metadataProperty || 'xdm:faceNames'}.`, res));
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
      setStatusBanner(resultBanner(`Updated group name to "${res.group.displayName}" across ${res.syncedAssetCount} asset(s).`, res));
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const handleSplitFaceToOwnGroup = async (face) => {
    try {
      const res = await api.splitFaces([face.faceId], null, hostContext);
      await loadData();
      setStatusBanner(resultBanner(`Removed face from "${face.groupDisplayName}" into new group "${res.newGroup.displayName}". Updated asset metadata.`, res));
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const handleMoveFaceToGroup = async (faceId, targetGroupId) => {
    if (!targetGroupId) return;
    try {
      const res = await api.moveFaces([faceId], targetGroupId, hostContext);
      setMovingFaceId(null);
      setGroupOptions(null);
      await loadData();
      setStatusBanner(resultBanner(`Combined face into "${res.targetGroup.displayName}" and updated asset metadata.`, res));
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const handleOpenMoveFacePicker = async (faceId) => {
    setMovingFaceId(faceId);
    if (!groupOptions) {
      try {
        const res = await api.listGroupOptions(hostContext);
        setGroupOptions(res.options || []);
      } catch (e) {
        setGroupOptions([]);
      }
    }
  };

  const faces = assetData?.faces || [];
  const faceNames = assetData?.faceNames || [];
  const metadataProp = assetData?.metadataProperty || 'xdm:faceNames';
  const canManageGroups = assetData?.canManageGroups !== false;

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
            <ActionButton
              isQuiet
              onPress={() => {
                if (guestConnection?.host?.modal?.openDialog) {
                  guestConnection.host.modal.openDialog({
                    title: 'Facial Recognition & Group Management',
                    contentUrl: `/index.html?cb=${Date.now()}#modal-face-management`,
                    type: 'fullscreen',
                    size: 'XL'
                  });
                } else {
                  navigate('/modal-face-management');
                }
              }}
            >
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
            <Flex direction="column" gap="size-150">
              <Text>
                No faces indexed for this asset yet.
              </Text>
              <Flex gap="size-100" wrap>
                <Button
                  variant="cta"
                  onPress={handleRescanAsset}
                  isDisabled={scanning}
                >
                  {scanning ? 'Scanning...' : 'Scan Asset with AWS Rekognition'}
                </Button>
              </Flex>
            </Flex>
          </Well>
        ) : (
          <Flex direction="column" gap="size-150">
            {faces.map((face, index) => {
              const isEditing = editingGroupId === face.groupId;
              const isMoving = movingFaceId === face.faceId;

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
                    {/* Cropped Face Avatar */}
                    <img
                      src={face.avatarDataUrl}
                      alt={face.groupDisplayName}
                      title={`Group ID: ${face.groupId} • Detection confidence: ${face.confidence}%`}
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
                            <span title={`Group ID: ${face.groupId}`}>
                              {face.groupDisplayName}
                            </span>
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
                      </Flex>

                      <Text UNSAFE_style={{ fontSize: 12, color: '#475569' }}>
                        Appears in {face.groupFaceCount} detected face(s)
                      </Text>

                      {/* Inline Rename / Split / Move Controls (shown only when user has curator/admin permission) */}
                      {canManageGroups && (
                        isEditing ? (
                          <Flex gap="size-75" alignItems="end" marginTop="size-50">
                            <TextField
                              label="Person Name (updates xdm:faceNames)"
                              value={editingNameValue}
                              onChange={setEditingNameValue}
                              placeholder="Enter person's name..."
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
                        ) : isMoving ? (
                          <Flex gap="size-75" alignItems="end" marginTop="size-50">
                            <Picker
                              label="Combine into existing group:"
                              width="100%"
                              onSelectionChange={(targetId) =>
                                handleMoveFaceToGroup(face.faceId, String(targetId))
                              }
                            >
                              {(groupOptions || [])
                                .filter((g) => g.groupId !== face.groupId)
                                .map((g) => {
                                  const label = `${g.displayName} (${g.faceCount} faces)`;
                                  return (
                                    <Item key={g.groupId} textValue={label}>
                                      <Text>
                                        <span
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6
                                          }}
                                        >
                                          {g.coverAvatarDataUrl && (
                                            <img
                                              src={g.coverAvatarDataUrl}
                                              alt=""
                                              style={{
                                                width: 18,
                                                height: 18,
                                                borderRadius: '50%',
                                                objectFit: 'cover'
                                              }}
                                            />
                                          )}
                                          <span>{label}</span>
                                        </span>
                                      </Text>
                                    </Item>
                                  );
                                })}
                            </Picker>
                            <ActionButton onPress={() => setMovingFaceId(null)}>
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
                            {face.groupFaceCount > 1 && (
                              <ActionButton
                                onPress={() => handleSplitFaceToOwnGroup(face)}
                              >
                                Split Face
                              </ActionButton>
                            )}
                            <ActionButton
                              onPress={() => handleOpenMoveFacePicker(face.faceId)}
                            >
                              Combine Into...
                            </ActionButton>
                          </Flex>
                        )
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

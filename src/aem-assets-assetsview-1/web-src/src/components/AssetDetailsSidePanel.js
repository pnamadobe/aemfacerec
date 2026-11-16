import React, { useEffect, useState, useCallback, useRef } from 'react';
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
import {
  isVideoPathOrMime,
  formatVideoTimestamp,
  extractSceneFramesInBrowser
} from '../utils/video-frame-extractor';
import { extensionId, STORAGE_KEY_CTX } from './Constants';

function readInitialSeekTimestamp() {
  try {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const sp = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : window.location.search);
    const tParam = sp.get('t') || sp.get('timestamp');
    if (tParam !== null && tParam !== '' && Number.isFinite(Number(tParam))) {
      return Math.max(0, Number(tParam));
    }
    const storedCtx = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
    if (
      storedCtx.pendingSeekTimestamp !== undefined &&
      storedCtx.pendingSeekTimestamp !== null &&
      Number.isFinite(Number(storedCtx.pendingSeekTimestamp)) &&
      Date.now() - Number(storedCtx.pendingSeekSavedAt || 0) < 2 * 60 * 1000
    ) {
      return Math.max(0, Number(storedCtx.pendingSeekTimestamp));
    }
  } catch (e) {
    // ignore
  }
  return null;
}

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
  const [scanProgressText, setScanProgressText] = useState('');
  const [hoveredFaceId, setHoveredFaceId] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [movingFaceId, setMovingFaceId] = useState(null);
  const [groupOptions, setGroupOptions] = useState(null);
  const [statusBanner, setStatusBanner] = useState(null);

  // Video playback & timestamp scrubbing state
  const videoRef = useRef(null);
  const [videoStreamInfo, setVideoStreamInfo] = useState(null);
  const [videoDimensions, setVideoDimensions] = useState(null);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [pendingSeekTime, setPendingSeekTime] = useState(readInitialSeekTimestamp);
  const [selectedAppearance, setSelectedAppearance] = useState(null);

  // Attach to AEM Assets View guest connection if running inside AEM iframe
  useEffect(() => {
    let mounted = true;
    const initial = readInitialHostContext();

    const applyNextCtx = (next) => {
      if (!next || !mounted) return;
      if (
        next.pendingSeekTimestamp !== undefined &&
        next.pendingSeekTimestamp !== null &&
        Number.isFinite(Number(next.pendingSeekTimestamp))
      ) {
        const targetSec = Math.max(0, Number(next.pendingSeekTimestamp));
        setPendingSeekTime(targetSec);
        if (videoRef.current && videoRef.current.readyState >= 1) {
          try {
            videoRef.current.currentTime = targetSec;
            setCurrentVideoTime(targetSec);
          } catch (e) {
            // ignore
          }
        }
      }
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
    setVideoDimensions(null);
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

      const effectivePath = facesRes?.assetPath || assetPath || '';
      const effectiveName = facesRes?.assetTitle || assetName || '';
      if (
        facesRes?.mediaType === 'video' ||
        isVideoPathOrMime(effectivePath || effectiveName, facesRes?.mimeType)
      ) {
        try {
          const streamRes = await api.getVideoStreamUrl(
            { assetId: facesRes?.assetId || assetId, assetPath: effectivePath },
            { aemHost, imsToken, imsOrg }
          );
          setVideoStreamInfo(streamRes);
        } catch (e) {
          setVideoStreamInfo(null);
        }
      } else {
        setVideoStreamInfo(null);
      }
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [hostResolved, assetId, assetPath, assetName, aemHost, imsToken, imsOrg]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSeekToTimestamp = useCallback((timestampSec, face = null, appearance = null) => {
    const targetSec = Math.max(0, Number(timestampSec) || 0);
    setCurrentVideoTime(targetSec);
    setPendingSeekTime(targetSec);
    if (face) {
      setHoveredFaceId(face.faceId);
      setSelectedAppearance({
        cardFaceId: face.faceId,
        shotFaceId: appearance?.faceId || face.faceId,
        timestampSec: targetSec,
        shotRangeSec: appearance?.shotRangeSec || face.shotRangeSec || [targetSec, targetSec],
        boundingBox: appearance?.boundingBox || face.boundingBox,
        avatarDataUrl: appearance?.avatarDataUrl || face.avatarDataUrl
      });
    }
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = targetSec;
        if (!videoRef.current.paused && typeof videoRef.current.pause === 'function') {
          videoRef.current.pause();
        }
      } catch (e) {
        // ignore if metadata not yet loaded; onLoadedMetadata will apply pendingSeekTime
      }
    }
  }, []);

  const handleRescanAsset = async () => {
    setScanning(true);
    setScanProgressText('');
    setStatusBanner(null);
    try {
      const effectivePath = assetData?.assetPath || hostContext.assetPath || '';
      const effectiveName = assetData?.assetTitle || hostContext.assetName || '';
      const isVideo =
        assetData?.mediaType === 'video' ||
        isVideoPathOrMime(effectivePath || effectiveName, assetData?.mimeType);

      if (isVideo) {
        let streamRes = videoStreamInfo;
        if (!streamRes?.streamUrl && (effectivePath || hostContext.assetId)) {
          try {
            streamRes = await api.getVideoStreamUrl(
              { assetId: hostContext.assetId, assetPath: effectivePath },
              hostContext
            );
            setVideoStreamInfo(streamRes);
          } catch (e) {
            streamRes = null;
          }
        }
        const resolvedVideoPath = streamRes?.assetPath || effectivePath;

        const vSettings = streamRes?.videoSettings || {};
        const extracted = streamRes?.streamUrl
          ? await extractSceneFramesInBrowser(streamRes.streamUrl, {
              sceneThreshold: vSettings.videoSceneThreshold ?? 0.28,
              shotOffsetSec: vSettings.videoShotOffsetSec ?? 0.6,
              maxSampleIntervalSec: vSettings.videoMaxSampleIntervalSec ?? 4.0,
              maxFramesPerAsset: vSettings.videoMaxFramesPerAsset ?? 24,
              onProgress: (p) => {
                if (p.phase === 'detecting-scenes') {
                  setScanProgressText(
                    `Detecting scene cuts (${formatVideoTimestamp(p.currentTimeSec)})...`
                  );
                } else if (p.phase === 'extracting-frames') {
                  setScanProgressText(
                    `Extracting scene ${p.completedFrames + 1}/${p.totalFrames} (${formatVideoTimestamp(p.timestampSec)})...`
                  );
                }
              }
            })
          : null;

        if (extracted && Array.isArray(extracted.frames) && extracted.frames.length > 0) {
          const res = await api.ingestVideoFramesChunked(
            {
              assetId: hostContext.assetId,
              assetPath: resolvedVideoPath,
              assetTitle: effectiveName || resolvedVideoPath.split('/').pop(),
              mimeType: assetData?.mimeType || 'video/mp4',
              frames: extracted.frames,
              durationSec: extracted.durationSec,
              extractionMode: extracted.extractionMode
            },
            hostContext,
            (p) => {
              setScanProgressText(
                `Analyzing scene ${Math.min(p.completedFrames + 1, p.totalFrames)}/${p.totalFrames} in AWS Rekognition...`
              );
            }
          );
          setAssetData(res);
          setStatusBanner(
            resultBanner(
              `Analyzed ${extracted.frames.length} video scene(s), consolidated ${res.faceCount || 0} unique person(s), and synced ${res.metadataProperty || 'xdm:faceNames'} + xdm:faceTimestamps.`,
              res
            )
          );
          return;
        }
      }

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
      setScanProgressText('');
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

  const handleSplitFaceToOwnGroup = async (face, specificShotFaceId = null) => {
    try {
      const targetFaceId = specificShotFaceId || face.faceId;
      const res = await api.splitFaces([targetFaceId], null, hostContext);
      setSelectedAppearance(null);
      await loadData();
      setStatusBanner(resultBanner(`Removed face from "${face.groupDisplayName}" into new group "${res.newGroup.displayName}". Updated asset metadata.`, res));
    } catch (err) {
      setStatusBanner({ type: 'negative', text: err.message });
    }
  };

  const handleMoveFaceToGroup = async (faceIdOrIds, targetGroupId) => {
    if (!targetGroupId) return;
    try {
      const ids = Array.isArray(faceIdOrIds) ? faceIdOrIds : [faceIdOrIds];
      const res = await api.moveFaces(ids, targetGroupId, hostContext);
      setMovingFaceId(null);
      setGroupOptions(null);
      setSelectedAppearance(null);
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
  const effectivePath = assetData?.assetPath || hostContext.assetPath || '';
  const isVideoAssetView =
    assetData?.mediaType === 'video' ||
    isVideoPathOrMime(effectivePath, assetData?.mimeType) ||
    faces.some(
      (f) =>
        f.mediaType === 'video' ||
        Number.isFinite(Number(f.timestampSec)) ||
        (Array.isArray(f.appearances) && f.appearances.length > 0)
    );

  // Determine which face bounding boxes are active at `currentVideoTime` (for video assets)
  const visibleVideoBoxes = [];
  if (isVideoAssetView) {
    faces.forEach((face, idx) => {
      const apps =
        Array.isArray(face.appearances) && face.appearances.length > 0
          ? face.appearances
          : Number.isFinite(Number(face.timestampSec))
          ? [
              {
                timestampSec: Number(face.timestampSec),
                shotRangeSec: face.shotRangeSec || [
                  Number(face.timestampSec),
                  Number(face.timestampSec)
                ],
                boundingBox: face.boundingBox
              }
            ]
          : [];

      const matchingApp =
        (selectedAppearance &&
          selectedAppearance.cardFaceId === face.faceId &&
          Math.abs(currentVideoTime - selectedAppearance.timestampSec) <= 0.75 &&
          selectedAppearance) ||
        apps.find((a) => {
          const ts = Number(a.timestampSec || 0);
          // Match within ±0.90s of the actual sampled timestamp where the bounding box was detected,
          // or within a narrow (< 4.5s) single-sample shot window so faces from t=4.6s never show at t=0.6s
          if (Math.abs(currentVideoTime - ts) <= 0.9) return true;
          const [start, end] = Array.isArray(a.shotRangeSec) ? a.shotRangeSec : [ts, ts];
          const span = Number(end) - Number(start);
          return span > 0 && span <= 4.5 && currentVideoTime >= start && currentVideoTime <= end;
        }) ||
        (hoveredFaceId === face.faceId ? apps[0] || { boundingBox: face.boundingBox } : null);

      if (matchingApp && matchingApp.boundingBox) {
        visibleVideoBoxes.push({
          face,
          index: idx,
          box: matchingApp.boundingBox,
          timestampSec: matchingApp.timestampSec
        });
      }
    });
  }

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
          <Button
            variant="secondary"
            onPress={handleRescanAsset}
            isDisabled={scanning}
          >
            {scanning ? scanProgressText || 'Scanning...' : 'Re-scan'}
          </Button>
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

        {/* Interactive Video Scrubber + Bounding Box Stage (for Video Assets) */}
        {isVideoAssetView && (faces.length > 0 || videoStreamInfo?.streamUrl) && (
          <View>
            <div
              style={{
                width: '100%',
                borderRadius: 8,
                background: '#0f172a',
                overflow: 'hidden',
                border: '1px solid #cbd5e1',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center'
              }}
            >
              {/* Inner aspect-ratio-locked stage so bounding boxes (0..1) align with any video aspect ratio (16:9, 9:16 vertical, 1:1, 4:5) */}
              <div
                style={{
                  position: 'relative',
                  ...(videoDimensions && videoDimensions.w > 0 && videoDimensions.h > 0
                    ? {
                        aspectRatio: `${videoDimensions.w} / ${videoDimensions.h}`,
                        maxHeight: 360,
                        maxWidth: '100%',
                        width:
                          videoDimensions.h > videoDimensions.w
                            ? `${Math.round((360 * videoDimensions.w) / videoDimensions.h)}px`
                            : '100%'
                      }
                    : { width: '100%', minHeight: 165 })
                }}
              >
                {videoStreamInfo?.streamUrl ? (
                  <video
                    ref={videoRef}
                    src={videoStreamInfo.streamUrl}
                    poster={videoStreamInfo.posterUrl || undefined}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(e) => {
                      const vw = Number(e.currentTarget.videoWidth) || 0;
                      const vh = Number(e.currentTarget.videoHeight) || 0;
                      if (vw > 0 && vh > 0) {
                        setVideoDimensions({ w: vw, h: vh });
                      }
                      if (pendingSeekTime !== null && Number.isFinite(Number(pendingSeekTime))) {
                        try {
                          e.currentTarget.currentTime = Number(pendingSeekTime);
                          setCurrentVideoTime(Number(pendingSeekTime));
                        } catch (err) {
                          // ignore
                        }
                      }
                    }}
                    onTimeUpdate={(e) => {
                      setCurrentVideoTime(Number(e.currentTarget.currentTime || 0));
                    }}
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'block',
                      objectFit: 'contain'
                    }}
                  />
                ) : (
                  <div
                    style={{
                      height: 165,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#94a3b8',
                      fontSize: 12,
                      padding: 12,
                      textAlign: 'center'
                    }}
                  >
                    Video preview At {formatVideoTimestamp(currentVideoTime)} • Click any timestamp pill below to inspect shot
                  </div>
                )}

                {/* Synchronized Face Bounding Boxes for Current Video Timestamp */}
                {visibleVideoBoxes.map(({ face, index: idx, box }) => {
                  const isHovered = hoveredFaceId === face.faceId;
                  const isNamed = Boolean(face.groupName);
                  return (
                    <div
                      key={`${face.faceId}-${idx}`}
                      onMouseEnter={() => setHoveredFaceId(face.faceId)}
                      onMouseLeave={() => setHoveredFaceId(null)}
                      title={`${face.groupDisplayName} @ ${formatVideoTimestamp(currentVideoTime)}`}
                      style={{
                        position: 'absolute',
                        left: `${(Number(box.left ?? box.Left ?? 0.2) || 0) * 100}%`,
                        top: `${(Number(box.top ?? box.Top ?? 0.2) || 0) * 100}%`,
                        width: `${(Number(box.width ?? box.Width ?? 0.18) || 0.18) * 100}%`,
                        height: `${(Number(box.height ?? box.Height ?? 0.28) || 0.28) * 100}%`,
                        border: isHovered
                          ? '2.5px solid #38bdf8'
                          : isNamed
                          ? '2px solid #4ade80'
                          : '2px dashed #fbbf24',
                        borderRadius: 6,
                        background: isHovered ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255,255,255,0.06)',
                        pointerEvents: 'none',
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
            </div>
          </View>
        )}

        {/* Interactive Bounding Box Locator (for Static Images) */}
        {!isVideoAssetView && faces.length > 0 && (
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
          <Flex direction="column" gap="size-100">
            {faces.map((face) => {
              const isEditing = editingGroupId === face.groupId;

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
                    padding: '8px 10px',
                    background: hoveredFaceId === face.faceId ? '#f8fafc' : '#ffffff',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Flex gap="size-125" alignItems="center">
                    {/* Cropped Face Avatar (switches to the active shot's crop when a timestamp pill is clicked) */}
                    <img
                      src={
                        selectedAppearance &&
                        selectedAppearance.cardFaceId === face.faceId &&
                        selectedAppearance.avatarDataUrl
                          ? selectedAppearance.avatarDataUrl
                          : face.avatarDataUrl
                      }
                      alt={face.groupDisplayName}
                      title={`Group ID: ${face.groupId} • Detection confidence: ${face.confidence}%`}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 10,
                        objectFit: 'cover',
                        border: '1.5px solid #cbd5e1',
                        flexShrink: 0
                      }}
                    />

                    <Flex direction="column" gap="size-25" flex="1">
                      <Flex justifyContent="space-between" alignItems="center">
                        <Flex alignItems="center" gap="size-75" wrap>
                          {canManageGroups ? (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={() => {
                                setEditingGroupId(face.groupId);
                                setEditingNameValue(face.groupName || '');
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setEditingGroupId(face.groupId);
                                  setEditingNameValue(face.groupName || '');
                                }
                              }}
                              title={`Click to ${face.groupName ? 'rename' : 'name'} (${face.groupId})`}
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                color: '#0f172a',
                                cursor: 'pointer',
                                borderBottom: '1px dashed #94a3b8',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4
                              }}
                            >
                              <span>{face.groupDisplayName}</span>
                              <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400 }}>
                                ✎
                              </span>
                            </span>
                          ) : (
                            <Text UNSAFE_style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>
                              <span title={`Group ID: ${face.groupId}`}>
                                {face.groupDisplayName}
                              </span>
                            </Text>
                          )}
                          {!face.groupName && (
                            <span
                              style={{
                                fontSize: 10,
                                background: '#fef3c7',
                                color: '#92400e',
                                padding: '1px 5px',
                                borderRadius: 4,
                                fontWeight: 600
                              }}
                            >
                              Placeholder
                            </span>
                          )}
                        </Flex>
                        <Text UNSAFE_style={{ fontSize: 11, color: '#64748b' }}>
                          {(() => {
                            const findCount =
                              Array.isArray(face.appearances) && face.appearances.length > 0
                                ? face.appearances.length
                                : face.groupFaceCount || 1;
                            return `${findCount} ${findCount === 1 ? 'find' : 'finds'}`;
                          })()}
                        </Text>
                      </Flex>

                      {/* Clickable Video Scene Timestamp Pills */}
                      {(() => {
                        const rawApps =
                          Array.isArray(face.appearances) && face.appearances.length > 0
                            ? face.appearances
                            : Number.isFinite(Number(face.timestampSec))
                            ? [
                                {
                                  timestampSec: Number(face.timestampSec),
                                  shotRangeSec: face.shotRangeSec,
                                  boundingBox: face.boundingBox
                                }
                              ]
                            : [];
                        if (rawApps.length === 0) return null;
                        return (
                          <Flex gap="size-50" wrap alignItems="center" marginTop="size-25">
                            {rawApps.map((app, aIdx) => {
                              const ts = Number(app.timestampSec || 0);
                              const isCurrentShot = Math.abs(currentVideoTime - ts) <= 0.65;
                              return (
                                <button
                                  key={`${face.faceId}-ts-${aIdx}-${ts}`}
                                  type="button"
                                  onClick={() => handleSeekToTimestamp(ts, face, app)}
                                  title={`Scrub video to ${formatVideoTimestamp(ts)}`}
                                  style={{
                                    border: isCurrentShot
                                      ? '1.5px solid #0284c7'
                                      : '1px solid #cbd5e1',
                                    background: isCurrentShot ? '#e0f2fe' : '#f1f5f9',
                                    color: isCurrentShot ? '#0369a1' : '#334155',
                                    borderRadius: 999,
                                    padding: '1px 7px',
                                    fontSize: 10.5,
                                    fontWeight: 600,
                                    cursor: 'pointer'
                                  }}
                                >
                                  ▶ {formatVideoTimestamp(ts)}
                                </button>
                              );
                            })}
                          </Flex>
                        );
                      })()}

                      {/* Inline Rename Input (opened when clicking the person's name) */}
                      {canManageGroups && isEditing && (
                        <Flex gap="size-75" alignItems="end" marginTop="size-50">
                          <TextField
                            aria-label="Person Name"
                            placeholder="Enter person name..."
                            value={editingNameValue}
                            onChange={setEditingNameValue}
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

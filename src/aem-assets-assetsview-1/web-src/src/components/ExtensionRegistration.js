import React, { useEffect, useState } from 'react';
import { register } from '@adobe/uix-guest';
import { useNavigate } from 'react-router-dom';
import {
  View,
  Flex,
  Heading,
  Text,
  Button,
  Divider,
  Well
} from '@adobe/react-spectrum';
import { extensionId, STORAGE_KEY_CTX } from './Constants';
import { api, summarizeScanResults, describeScanSummary } from '../utils/api';

function findAemAuthorUrl(...sources) {
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return '';
    if (typeof value === 'string') {
      const match = value.match(/https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com/i);
      return match ? match[0].replace(/\/+$/, '') : '';
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      const result = visit(item, depth + 1);
      if (result) return result;
    }
    return '';
  };
  return sources.map(visit).find(Boolean) || '';
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|tiff?|bmp|avif|heic)$/i;

function extractAssetContext(resourceOrWrapper, context) {
  const resource =
    resourceOrWrapper &&
    typeof resourceOrWrapper === 'object' &&
    resourceOrWrapper.resource
      ? resourceOrWrapper.resource
      : resourceOrWrapper;

  const ctxObj =
    resourceOrWrapper &&
    typeof resourceOrWrapper === 'object' &&
    resourceOrWrapper.context
      ? resourceOrWrapper.context
      : context;

  // Deep-search for any /content/dam/... path in resource or wrapper
  function findDamPath(obj, depth = 0) {
    if (depth > 4 || !obj) return '';
    if (typeof obj === 'string') {
      const idx = obj.indexOf('/content/dam');
      if (idx >= 0) {
        try {
          return decodeURIComponent(obj.slice(idx));
        } catch (e) {
          return obj.slice(idx);
        }
      }
      return '';
    }
    if (typeof obj !== 'object') return '';
    const priorityKeys = [
      'path',
      'repositoryPath',
      'repo:path',
      'assetPath',
      'folderPath',
      'repositoryMetadata'
    ];
    for (const k of priorityKeys) {
      if (obj[k]) {
        const hit = findDamPath(obj[k], depth + 1);
        if (hit) return hit;
      }
    }
    for (const val of Object.values(obj)) {
      const hit = findDamPath(val, depth + 1);
      if (hit) return hit;
    }
    return '';
  }

  let cleanPath = findDamPath(resource) || findDamPath(resourceOrWrapper) || findDamPath(ctxObj);
  cleanPath = String(cleanPath).trim().replace(/\/+$/, '');

  const isAssetFile = IMAGE_EXT_RE.test(cleanPath);
  const folderPath = isAssetFile
    ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) || '/content/dam'
    : cleanPath.startsWith('/content/dam')
    ? cleanPath
    : '/content/dam';

  const assetPath = isAssetFile ? cleanPath : '';

  const assetName =
    (resource &&
      (resource.name ||
        resource['repo:name'] ||
        resource.assetName ||
        resource.title ||
        resource.repositoryMetadata?.['repo:name'])) ||
    (assetPath ? assetPath.split('/').pop() : '') ||
    '';

  const assetId =
    (resource &&
      (resource.id ||
        resource.assetId ||
        resource['repo:id'] ||
        resource.repositoryMetadata?.['repo:id'] ||
        resource.repositoryMetadata?.id)) ||
    '';

  const aemAuthorUrl = findAemAuthorUrl(resource, resourceOrWrapper, ctxObj);
  let imsTenant = '';
  let experienceOrigin = '';
  try {
    const ref = document.referrer || '';
    const m = ref.match(/(https:\/\/experience(?:-stage)?\.adobe\.com)/i);
    if (m) experienceOrigin = m[1];
    const tenantFromRef = ref.match(/\/@([a-zA-Z0-9_-]+)\//);
    if (tenantFromRef) imsTenant = tenantFromRef[1];
  } catch (e) {
    // ignore
  }
  try {
    const searchStr = JSON.stringify({ resource, ctxObj });
    const tenantMatch = searchStr.match(/\/@([a-zA-Z0-9_-]+)\/assets/);
    if (tenantMatch) imsTenant = imsTenant || tenantMatch[1];
  } catch (e) {
    // ignore circular references on host proxy objects
  }

  return { folderPath, assetPath, assetName, assetId, aemAuthorUrl, imsTenant, experienceOrigin };
}

export default function ExtensionRegistration() {
  const navigate = useNavigate();
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        const guestConnection = await register({
          id: extensionId,
          methods: {
            actionBar: {
              async getActions(params = {}) {
                const { context, resourceSelection } = params || {};
                const resources = Array.isArray(resourceSelection?.resources)
                  ? resourceSelection.resources
                  : Array.isArray(resourceSelection)
                  ? resourceSelection
                  : resourceSelection
                  ? [resourceSelection]
                  : [];

                if (resources.length === 0) return [];

                return [
                  {
                    id: 'scan-faces-action',
                    icon: 'UserGroup',
                    label: 'Recognize Faces',
                    onClick: async () => {
                      let imsToken = null;
                      let imsOrg = null;
                      try {
                        const imsInfo = await guestConnection.host?.auth?.getIMSInfo?.();
                        if (imsInfo) {
                          imsToken = imsInfo.accessToken || imsInfo.imsToken || null;
                          imsOrg = imsInfo.imsOrg || null;
                        }
                      } catch (e) {
                        // ignore
                      }

                      let aemAuthorUrl = findAemAuthorUrl(resources, context);
                      if (!aemAuthorUrl && guestConnection.host?.discovery?.getAemHost) {
                        try {
                          const discovered = await guestConnection.host.discovery.getAemHost();
                          if (discovered) {
                            aemAuthorUrl = String(discovered).startsWith('http')
                              ? discovered
                              : `https://${discovered}`;
                          }
                        } catch (e) {
                          // ignore
                        }
                      }

                      const authContext = { imsToken, imsOrg, aemHost: aemAuthorUrl };

                      try {
                        guestConnection.host?.toast?.display?.({
                          variant: 'neutral',
                          message: `Running AWS Rekognition on ${resources.length} selected item(s)...`
                        });
                      } catch (e) {
                        // ignore toast error
                      }

                      // Already-scanned images are skipped (no AWS cost); use the side panel's
                      // Re-scan button to analyze a single image again.
                      const results = [];
                      let excludedAssetCount = 0;

                      try {
                        for (const item of resources) {
                          const extracted = extractAssetContext(item, context);
                          if (extracted.assetPath) {
                            const res = await api.ingestAsset(
                              {
                                assetPath: extracted.assetPath,
                                assetId: extracted.assetId,
                                force: true,
                                rescan: false
                              },
                              authContext
                            );
                            results.push(
                              res.skipped
                                ? { status: 'skipped', reasonCode: res.reasonCode }
                                : { status: 'processed', faceCount: res.faceCount || 0 }
                            );
                          } else if (extracted.folderPath) {
                            const res = await api.scanFolder(extracted.folderPath, authContext);
                            results.push(...(res.results || []));
                            excludedAssetCount += res.excludedAssetCount || 0;
                          }
                        }

                        const summary = summarizeScanResults(results, excludedAssetCount);
                        guestConnection.host?.toast?.display?.({
                          variant: summary.failed > 0 ? 'negative' : 'positive',
                          message: `Face recognition: ${describeScanSummary(summary)}${
                            summary.failed > 0 ? ` ${summary.failed} failed.` : ''
                          }`
                        });
                      } catch (err) {
                        guestConnection.host?.toast?.display?.({
                          variant: 'negative',
                          message: `Face recognition error: ${err.message}`
                        });
                      }
                    }
                  }
                ];
              },
              async getHiddenBuiltInActions() {
                return [];
              },
              async overrideBuiltInAction() {
                return false;
              }
            },
            quickActions: {
              async getHiddenBuiltInActions() {
                return [];
              },
              async overrideBuiltInAction() {
                return false;
              }
            },
            detailSidePanel: {
              getPanels(resource) {
                const extracted = extractAssetContext(resource);
                try {
                  if (extracted.assetPath || extracted.assetId) {
                    localStorage.setItem(STORAGE_KEY_CTX, JSON.stringify(extracted));
                  }
                } catch (e) {
                  // ignore
                }
                return [
                  {
                    id: 'face-recognition-panel',
                    tooltip: 'Recognized Faces & People',
                    icon: 'UserGroup',
                    title: 'Recognized Faces',
                    contentUrl: '/#face-recognition-panel',
                    reloadOnThemeChange: true
                  }
                ];
              },
              async getHiddenBuiltInPanels() {
                return [];
              },
              async overrideBuiltInPanel() {
                return null;
              }
            },
            headerMenu: {
              async getButtons(params = {}) {
                const { context, resource } = params || {};
                return [
                  {
                    id: 'face-management',
                    icon: 'UserGroup',
                    label: 'Face Groups',
                    onClick: async () => {
                      const extracted = extractAssetContext(resource, context);
                      if (!extracted.aemAuthorUrl && guestConnection.host?.discovery?.getAemHost) {
                        try {
                          const discovered = await guestConnection.host.discovery.getAemHost();
                          if (discovered) {
                            extracted.aemAuthorUrl = String(discovered).startsWith('http')
                              ? discovered
                              : `https://${discovered}`;
                          }
                        } catch (e) {
                          // ignore
                        }
                      }
                      try {
                        localStorage.setItem(STORAGE_KEY_CTX, JSON.stringify(extracted));
                      } catch (e) {
                        // ignore
                      }
                      const qs = new URLSearchParams(extracted).toString();
                      guestConnection.host.modal.openDialog({
                        title: 'Facial Recognition & Group Management',
                        contentUrl: `/#modal-face-management?${qs}`,
                        type: 'fullscreen',
                        size: 'XL',
                        payload: extracted
                      });
                    }
                  }
                ];
              },
              async getHiddenButtonIds() {
                return [];
              },
              async overrideButton() {
                return false;
              }
            }
          }
        });

        if (guestConnection) {
          setRegistered(true);
        }
      } catch (e) {
        // Standalone browser preview mode outside AEM Assets View iframe
      }
    };
    init();
  }, []);

  return (
    <View padding="size-400" maxWidth="840px" marginX="auto">
      <Flex direction="column" gap="size-300">
        <Flex justifyContent="space-between" alignItems="center">
          <View>
            <Heading level={1} marginBottom="size-50">
              AEM Assets — Facial Recognition & Grouping
            </Heading>
            <Text UNSAFE_style={{ color: '#475569' }}>
              Adobe Developer App Builder Extension (<code>aem/assets/assetsview/1</code>) powered by Customer BYOK AWS Rekognition
            </Text>
          </View>
          <View
            backgroundColor={registered ? 'positive' : 'informative'}
            paddingX="size-150"
            paddingY="size-75"
            borderRadius="small"
          >
            <Text UNSAFE_style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>
              {registered ? 'Connected to AEM Assets View' : 'Standalone Preview Mode'}
            </Text>
          </View>
        </Flex>

        <Divider size="S" />

        <Flex gap="size-300" wrap>
          <Well flex="1" minWidth="320px">
            <Flex direction="column" gap="size-150">
              <Heading level={3} margin={0}>
                1. Asset Details Side Panel
              </Heading>
              <Text>
                The contextual side panel inside <strong>AEM Assets View</strong>. Displays 160×160
                cropped face avatars for the open asset, highlights face bounding boxes, shows
                computed <code>xdm:faceNames</code> metadata, and lets users name, split, or
                reassign faces on the spot.
              </Text>
              <View marginTop="size-100">
                <Button variant="cta" onPress={() => navigate('/face-recognition-panel')}>
                  Open Asset Details Side Panel
                </Button>
              </View>
            </Flex>
          </Well>

          <Well flex="1" minWidth="320px">
            <Flex direction="column" gap="size-150">
              <Heading level={3} margin={0}>
                2. Face Management & BYOK Settings Console
              </Heading>
              <Text>
                The full-page admin console to manage all recognized Face Groups, split misgrouped
                faces into new groups, combine/merge groups, scan DAM folders, and configure
                customer AWS Rekognition API keys and the <code>xdm:faceNames</code> placeholder toggle.
              </Text>
              <View marginTop="size-100">
                <Button variant="primary" onPress={() => navigate('/modal-face-management')}>
                  Open Face Management Console
                </Button>
              </View>
            </Flex>
          </Well>
        </Flex>
      </Flex>
    </View>
  );
}

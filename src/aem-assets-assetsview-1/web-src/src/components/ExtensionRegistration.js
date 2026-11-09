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

function extractAssetContext(resource, context) {
  const rawPath =
    (resource &&
      (resource.path ||
        resource.repositoryPath ||
        resource['repo:path'] ||
        resource.repositoryMetadata?.['repo:path'] ||
        resource.repositoryMetadata?.path)) ||
    '';

  let assetPath = String(rawPath).trim();
  const damIdx = assetPath.indexOf('/content/dam');
  if (damIdx > 0) assetPath = assetPath.slice(damIdx);

  const assetId =
    (resource &&
      (resource.id ||
        resource.assetId ||
        resource['repo:id'] ||
        resource.repositoryMetadata?.['repo:id'])) ||
    '';

  const aemAuthorUrl = findAemAuthorUrl(resource, context);

  return { assetPath, assetId, aemAuthorUrl };
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
              async getActions({ context, resourceSelection }) {
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
                      const first = resources[0];
                      const extracted = extractAssetContext(first, context);
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
                        contentUrl: `/index.html?cb=${Date.now()}#modal-face-management?${qs}`,
                        type: 'fullscreen',
                        size: 'XL',
                        payload: extracted
                      });
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
                const qs = new URLSearchParams(extracted).toString();
                return [
                  {
                    id: 'face-recognition-panel',
                    tooltip: 'Recognized Faces & People',
                    icon: 'UserGroup',
                    title: 'Recognized Faces',
                    contentUrl: `/index.html?cb=${Date.now()}#face-recognition-panel?${qs}`,
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
              async getButtons({ context, resource }) {
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
                        contentUrl: `/index.html?cb=${Date.now()}#modal-face-management?${qs}`,
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

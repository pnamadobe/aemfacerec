import React, { useEffect, useState } from 'react';
import { register } from '@adobe/uix-sdk';
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

const EXTENSION_ID = 'aem-assets-face-recognition';

export default function ExtensionRegistration() {
  const navigate = useNavigate();
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        await register({
          id: EXTENSION_ID,
          methods: {
            detailSidePanel: {
              getSidePanels() {
                return [
                  {
                    id: 'face-recognition-panel',
                    tooltip: 'Recognized Faces & People',
                    icon: 'UserGroup',
                    title: 'Recognized Faces',
                    contentUrl: '/#/side-panel',
                    reloadOnThemeChange: true
                  }
                ];
              }
            }
          }
        });
        setRegistered(true);
      } catch (e) {
        // Running standalone outside AEM Assets View iframe host
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
              Adobe Developer App Builder Extension (`aem/assets/details/1`) powered by Customer BYOK AWS Rekognition
            </Text>
          </View>
          <View
            backgroundColor={registered ? 'positive' : 'informative'}
            paddingX="size-150"
            paddingY="size-75"
            borderRadius="small"
          >
            <Text UNSAFE_style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>
              {registered ? 'Connected to AEM Host' : 'Standalone Preview Mode'}
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
                <Button variant="cta" onPress={() => navigate('/side-panel')}>
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
                <Button variant="primary" onPress={() => navigate('/admin')}>
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

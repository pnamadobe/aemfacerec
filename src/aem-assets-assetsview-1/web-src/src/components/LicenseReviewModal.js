import React, { useEffect, useState } from 'react';
import { attach } from '@adobe/uix-guest';
import {
  Flex,
  View,
  Text,
  Heading,
  Content,
  Button,
  ButtonGroup,
  ProgressCircle,
  InlineAlert,
  StatusLight,
  Tabs,
  TabList,
  TabPanels,
  Item
} from '@adobe/react-spectrum';
import { api, fetchLicenseDocument } from '../utils/api';
import PdfPagesView from './PdfPagesView';
import { extensionId, STORAGE_KEY_CTX, LICENSE_APPLIED_CHANNEL, LICENSE_REVIEW_KEY } from './Constants';
import LicensePropertiesView from './LicensePropertiesView';

function readParams() {
  const hash = window.location.hash || '';
  const q = hash.indexOf('?');
  const sp = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
  return {
    licenseId: sp.get('licenseId') || '',
    licenseName: sp.get('licenseName') || 'License',
    assetPath: sp.get('assetPath') || '',
    personName: sp.get('personName') || '',
    similarity: Number(sp.get('similarity')) || null,
    aemHost: sp.get('aemHost') || ''
  };
}

function readCachedAuth() {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
    return { imsToken: c.imsToken || null, imsOrg: c.imsOrg || null, aemHost: c.aemAuthorUrl || '' };
  } catch (e) {
    return { imsToken: null, imsOrg: null, aemHost: '' };
  }
}

/**
 * Lets the user read the actual contract PDF and confirm it is the right one before the
 * suggested license is assigned. The PDF is served straight from a short-lived pre-signed URL.
 */
function readLicense(licenseId) {
  try {
    return JSON.parse(localStorage.getItem(LICENSE_REVIEW_KEY) || '{}')[licenseId] || null;
  } catch (e) {
    return null;
  }
}

const subtle = {
  color: 'var(--spectrum-global-color-gray-700)',
  fontSize: 'var(--spectrum-global-dimension-font-size-75)'
};

export default function LicenseReviewModal() {
  const params = readParams();
  const license = readLicense(params.licenseId);
  const [tab, setTab] = useState('contract');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [ctx, setCtx] = useState({ ...readCachedAuth(), aemHost: params.aemHost || readCachedAuth().aemHost });
  const [guest, setGuest] = useState(null);
  const [pdfData, setPdfData] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [applyError, setApplyError] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const gc = await Promise.race([
          attach({ id: extensionId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Host connection timed out')), 8000))
        ]);
        if (!mounted || !gc) return;
        setGuest(gc);
        const info = (await gc.host?.auth?.getIMSInfo?.().catch(() => null)) || {};
        const token = info.accessToken || info.imsToken || null;
        if (token) setCtx((c) => ({ ...c, imsToken: token, imsOrg: info.imsOrg || c.imsOrg }));
      } catch (e) {
        // fall back to the token cached by the side panel
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!ctx.imsToken || !params.licenseId) return undefined;
    let cancelled = false;
    fetchLicenseDocument(params.licenseId, ctx, { onProgress: (p) => !cancelled && setProgress(p) })
      .then((bytes) => !cancelled && setPdfData(bytes))
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || 'Could not load the contract.');
        setPreviewFailed(true);
        setTab('properties');
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.imsToken]);

  const close = () => guest?.host?.modal?.closeDialog?.();

  const confirm = async () => {
    setApplying(true);
    setApplyError('');
    try {
      await api.applyLicense({ assetPath: params.assetPath, licenseId: params.licenseId }, ctx);
      setApplied(true);
      try {
        const bc = new BroadcastChannel(LICENSE_APPLIED_CHANNEL);
        bc.postMessage({ assetPath: params.assetPath, licenseId: params.licenseId });
        bc.close();
      } catch (e) {
        // the panel re-reads the asset's license state on its own
      }
    } catch (e) {
      setApplyError(e.message || 'Could not assign the license.');
    }
    setApplying(false);
  };

  const viewerHeight = 'calc(100vh - 260px)';

  return (
    <Flex direction="column" height="100vh" gap="size-150" UNSAFE_style={{ padding: 'var(--spectrum-global-dimension-size-200)', boxSizing: 'border-box', fontFamily: 'var(--spectrum-alias-body-text-font-family, var(--spectrum-global-font-family-base, adobe-clean, sans-serif))' }}>
      <View>
        <Heading level={3} margin={0}>
          {params.licenseName}
        </Heading>
        <Text UNSAFE_style={subtle}>
          Suggested for {params.personName || 'this person'}
          {params.similarity ? ` · Face match ${Math.round(params.similarity)}%` : ''}
        </Text>
        <Text UNSAFE_style={{ ...subtle, display: 'block' }}>
          Check that the photo and terms in the contract are for the person in this image.
        </Text>
      </View>

      {previewFailed && (
        <InlineAlert variant="notice">
          <Heading>Contract preview unavailable</Heading>
          <Content>The contract couldn&apos;t be displayed here, so the terms AEM extracted are shown instead.</Content>
        </InlineAlert>
      )}

      <Tabs aria-label="Contract review" selectedKey={tab} onSelectionChange={setTab} flex>
        <TabList>
          <Item key="contract">Contract</Item>
          <Item key="properties">Extracted properties</Item>
        </TabList>
        <TabPanels>
          <Item key="contract">
            <div style={{ height: viewerHeight, minHeight: 420, border: '1px solid var(--spectrum-global-color-gray-300)', borderRadius: 'var(--spectrum-global-dimension-size-50)', overflow: 'hidden' }}>
              {pdfData ? (
                <PdfPagesView data={pdfData} onError={() => { setPreviewFailed(true); setTab('properties'); }} />
              ) : error ? (
                <InlineAlert variant="negative">
                  <Heading>Couldn&apos;t load the contract</Heading>
                  <Content>{error}</Content>
                </InlineAlert>
              ) : (
                <Flex alignItems="center" justifyContent="center" height="100%" direction="column" gap="size-100">
                  <ProgressCircle aria-label="Loading contract" value={Math.round(progress * 100)} />
                  <Text UNSAFE_style={subtle}>Loading contract…</Text>
                </Flex>
              )}
            </div>
          </Item>
          <Item key="properties">
            <div style={{ height: viewerHeight, minHeight: 420, overflow: 'auto' }}>
              <View paddingTop="size-150">
                <LicensePropertiesView license={license} />
              </View>
            </div>
          </Item>
        </TabPanels>
      </Tabs>

      {applyError && (
        <InlineAlert variant="negative">
          <Heading>Couldn&apos;t assign the license</Heading>
          <Content>{applyError}</Content>
        </InlineAlert>
      )}

      <Flex justifyContent="end" alignItems="center" gap="size-200">
        {applied ? (
          <>
            <StatusLight variant="positive">License assigned to this asset</StatusLight>
            <Button variant="secondary" onPress={close}>
              Close
            </Button>
          </>
        ) : (
          <ButtonGroup>
            <Button variant="secondary" isDisabled={applying} onPress={close}>
              Cancel
            </Button>
            <Button variant="accent" isDisabled={applying || (!pdfData && !previewFailed)} onPress={confirm}>
              Apply license
            </Button>
          </ButtonGroup>
        )}
      </Flex>
    </Flex>
  );
}

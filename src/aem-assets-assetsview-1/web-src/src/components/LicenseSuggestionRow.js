import React, { useState } from 'react';
import {
  View,
  Flex,
  Text,
  Button,
  Badge,
  StatusLight,
  InlineAlert,
  Heading,
  Content,
  ActionButton
} from '@adobe/react-spectrum';
import ChevronRight from '@spectrum-icons/workflow/ChevronRight';
import ChevronDown from '@spectrum-icons/workflow/ChevronDown';

// Secondary text uses Spectrum's gray scale and type-size tokens (no hard-coded colors)
const subtle = {
  color: 'var(--spectrum-global-color-gray-700)',
  fontSize: 'var(--spectrum-global-dimension-font-size-75)'
};
// Spectrum components inherit their font from the page; set it explicitly so nested text never
// falls back to the browser's serif default inside the host iframe.
const font = { fontFamily: 'var(--spectrum-alias-body-text-font-family, var(--spectrum-global-font-family-base, adobe-clean, sans-serif))' };
const list = { margin: 0, paddingInlineStart: 'var(--spectrum-global-dimension-size-250)' };

function describeWindow(w) {
  const regions = (w.regions || []).join('/') || 'any region';
  const channels = (w.channels || []).join(', ') || 'any channel';
  const to = w.perpetual ? 'perpetual' : w.expiresAt || 'open-ended';
  return `${regions} · ${channels} · ${w.effectiveAt || '…'} → ${to}`;
}

export function isExpired(license, today = new Date().toISOString().slice(0, 10)) {
  const windows = license.windows || [];
  return windows.length > 0 && windows.every((w) => !w.perpetual && w.expiresAt && w.expiresAt < today);
}

/**
 * "Suggested license" for one recognized person. Suggestions come from matching the face in the
 * contract's headshot, never from names. Nothing is assigned until the user confirms.
 */
export default function LicenseSuggestionRow({ person, state, onApply, onReview, appliedIds = [] }) {
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState({});
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});

  if (state?.loading) {
    return (
      <View marginTop="size-75" UNSAFE_style={font}>
        <Text UNSAFE_style={subtle}>Checking licenses…</Text>
      </View>
    );
  }
  if (!person || person.suggestions.length === 0) return null;

  const apply = async (license) => {
    setBusy(true);
    setError('');
    try {
      await onApply(license);
      setDone((d) => ({ ...d, [license.licenseId]: true }));
      setConfirming(null);
    } catch (e) {
      setError(e.message || 'Could not assign the license.');
    }
    setBusy(false);
  };

  return (
    <Flex direction="column" gap="size-100" marginTop="size-100" UNSAFE_style={font}>
      {person.suggestions.map((s) => {
        const assigned = done[s.licenseId] || s.assigned || appliedIds.includes(s.licenseId);
        return (
          <View
            key={s.licenseId}
            borderWidth="thin"
            borderColor="dark"
            borderRadius="medium"
            backgroundColor="gray-75"
            padding="size-150"
          >
            <Flex justifyContent="space-between" alignItems="center" gap="size-100" wrap>
              <Heading level={5} margin={0}>
                Suggested license
              </Heading>
              <span title="Matched by the face in the contract headshot, not by name">
                <Badge variant={s.strong ? 'positive' : 'yellow'}>
                  {s.strong ? 'Strong' : 'Possible'} match · {Math.round(s.similarity)}%
                </Badge>
              </span>
            </Flex>

            <View marginTop="size-50">
              <Text>{s.name}</Text>
            </View>
            {s.licenser && (
              <View marginTop="size-25">
                <Text UNSAFE_style={subtle}>Licenser: {s.licenser}</Text>
              </View>
            )}
            {isExpired(s) && (
              <View marginTop="size-75">
                <Badge variant="negative">Expired license</Badge>
              </View>
            )}

            <ul style={{ ...list, marginTop: 'var(--spectrum-global-dimension-size-100)', ...subtle }}>
              {s.windows.map((w, i) => (
                <li key={i}>{describeWindow(w)}</li>
              ))}
            </ul>

            {s.restrictions.length > 0 && (
              <View marginTop="size-50">
                <ActionButton
                  isQuiet
                  aria-expanded={Boolean(open[s.licenseId])}
                  onPress={() => setOpen((o) => ({ ...o, [s.licenseId]: !o[s.licenseId] }))}
                >
                  {open[s.licenseId] ? <ChevronDown /> : <ChevronRight />}
                  <Text>Restrictions ({s.restrictions.length})</Text>
                </ActionButton>
                {open[s.licenseId] && (
                  <ul style={{ ...list, ...subtle }}>
                    {s.restrictions.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </View>
            )}

            <View marginTop="size-100">
              {assigned ? (
                <StatusLight variant="positive">License assigned to this asset</StatusLight>
              ) : confirming === s.licenseId ? (
                <Flex gap="size-100" alignItems="center" wrap>
                  <Text>Assign this license to this asset?</Text>
                  <Button variant="accent" isDisabled={busy} onPress={() => apply(s)}>
                    Assign license
                  </Button>
                  <Button variant="secondary" isDisabled={busy} onPress={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </Flex>
              ) : (
                <Flex gap="size-100" wrap>
                  {onReview && (
                    <Button variant="primary" onPress={() => onReview(s, person)}>
                      Review contract
                    </Button>
                  )}
                  <Button variant={onReview ? 'secondary' : 'primary'} onPress={() => setConfirming(s.licenseId)}>
                    Apply license
                  </Button>
                </Flex>
              )}
            </View>

            {error && confirming === s.licenseId && (
              <InlineAlert variant="negative" marginTop="size-100">
                <Heading>Couldn&apos;t assign the license</Heading>
                <Content>{error}</Content>
              </InlineAlert>
            )}
          </View>
        );
      })}
    </Flex>
  );
}

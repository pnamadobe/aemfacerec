import React, { useState } from 'react';
import {
  View,
  Flex,
  Grid,
  Heading,
  Text,
  TextField,
  Badge,
  Tabs,
  TabList,
  TabPanels,
  Item,
  TagGroup
} from '@adobe/react-spectrum';
import CheckmarkCircle from '@spectrum-icons/workflow/CheckmarkCircle';
import Alert from '@spectrum-icons/workflow/Alert';

const font = { fontFamily: 'var(--spectrum-alias-body-text-font-family, var(--spectrum-global-font-family-base, adobe-clean, sans-serif))' };
const subtle = {
  color: 'var(--spectrum-global-color-gray-700)',
  fontSize: 'var(--spectrum-global-dimension-font-size-75)'
};

// One labelled row: fixed label column + flexible value column, so every field lines up
function Field({ label, children }) {
  return (
    <Grid columns={['size-1700', '1fr']} gap="size-200" alignItems="center">
      <Text UNSAFE_style={subtle}>{label}</Text>
      <View>{children}</View>
    </Grid>
  );
}

function ReadOnly({ label, value }) {
  return (
    <Field label={label}>
      <TextField aria-label={label} value={value} isReadOnly width="100%" />
    </Field>
  );
}

function Tags({ label, items }) {
  if (!items || items.length === 0) return <Text UNSAFE_style={subtle}>None specified</Text>;
  return (
    <TagGroup aria-label={label}>
      {items.map((i) => (
        <Item key={i}>{i}</Item>
      ))}
    </TagGroup>
  );
}

function Panel({ title, children }) {
  return (
    <View borderWidth="thin" borderColor="dark" borderRadius="medium" padding="size-200" backgroundColor="gray-50">
      {title && (
        <Heading level={4} marginTop={0}>
          {title}
        </Heading>
      )}
      {children}
    </View>
  );
}

/**
 * Read-only view of the terms AEM extracted from a contract, laid out like the product's own
 * "Property list" dialog: confidence, parties, one tab per usage window, and restrictions.
 */
export default function LicensePropertiesView({ license }) {
  const [windowKey, setWindowKey] = useState('window-0');
  if (!license) return <Text UNSAFE_style={subtle}>No extracted properties are available.</Text>;
  const windows = license.windows || [];
  const confident = license.confidence != null && license.confidence >= 80;

  return (
    <Flex direction="column" gap="size-200" UNSAFE_style={font}>
      {license.confidence != null && (
        <span title="How confident AEM is in the values extracted from the contract">
          <Badge variant={confident ? 'positive' : 'yellow'}>
            {confident ? <CheckmarkCircle /> : <Alert />}
            <Text>{license.confidence}% confidence score</Text>
          </Badge>
        </span>
      )}

      <Panel title="Extracted metadata">
        <Flex direction="column" gap="size-150">
          <ReadOnly label="Name" value={license.name || ''} />
          <ReadOnly label="Licensee" value={license.licensee || ''} />
          <ReadOnly label="Licenser or owner" value={license.licenser || ''} />
        </Flex>
      </Panel>

      {windows.length > 0 && (
        <Panel>
          <Tabs aria-label="Usage windows" selectedKey={windowKey} onSelectionChange={setWindowKey} density="compact">
            <TabList>
              {windows.map((_, i) => (
                <Item key={`window-${i}`}>Usage window {i + 1}</Item>
              ))}
            </TabList>
            <TabPanels>
              {windows.map((w, i) => (
                <Item key={`window-${i}`}>
                  <Flex direction="column" gap="size-150" marginTop="size-150">
                    <ReadOnly label="Effective date" value={w.effectiveAt || ''} />
                    <ReadOnly label="Expiration date" value={w.perpetual ? 'Perpetual' : w.expiresAt || 'Open-ended'} />
                    <Field label="Regions">
                      <Tags label="Regions" items={w.regions} />
                    </Field>
                    <Field label="Channels">
                      <Tags label="Channels" items={w.channels} />
                    </Field>
                  </Flex>
                </Item>
              ))}
            </TabPanels>
          </Tabs>
        </Panel>
      )}

      {(license.restrictions || []).length > 0 && (
        <Panel title="Restrictions">
          <ul style={{ margin: 0, paddingInlineStart: 'var(--spectrum-global-dimension-size-250)' }}>
            {license.restrictions.map((r, i) => (
              <li key={i}>
                <Text>{r}</Text>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Flex>
  );
}

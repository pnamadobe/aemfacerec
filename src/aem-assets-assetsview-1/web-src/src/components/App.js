import React from 'react';
import ErrorBoundary from 'react-error-boundary';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { Provider, defaultTheme } from '@adobe/react-spectrum';
import ExtensionRegistration from './ExtensionRegistration';
import AssetDetailsSidePanel from './AssetDetailsSidePanel';
import AdminConsole from './AdminConsole';

export default function App() {
  return (
    <Provider theme={defaultTheme} colorScheme="light" height="100%">
      <Router>
        <ErrorBoundary onError={onError} FallbackComponent={fallbackComponent}>
          <Routes>
            <Route index element={<ExtensionRegistration />} />
            <Route exact path="index.html" element={<ExtensionRegistration />} />
            <Route path="face-recognition-panel" element={<AssetDetailsSidePanel />} />
            <Route path="side-panel" element={<AssetDetailsSidePanel />} />
            <Route path="modal-face-management" element={<AdminConsole />} />
            <Route path="admin" element={<AdminConsole />} />
          </Routes>
        </ErrorBoundary>
      </Router>
    </Provider>
  );

  function onError(e, componentStack) {
    console.error('[AEM Face Recognition] UI render error:', e, componentStack);
  }

  function fallbackComponent({ componentStack, error }) {
    return (
      <div style={{ padding: 24 }}>
        <h2>AEM Face Recognition Extension Error</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>
          {(error && error.message) + '\n' + componentStack}
        </pre>
      </div>
    );
  }
}

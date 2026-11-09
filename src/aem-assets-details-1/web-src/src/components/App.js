import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Provider, defaultTheme } from '@adobe/react-spectrum';
import ExtensionRegistration from './ExtensionRegistration';
import AssetDetailsSidePanel from './AssetDetailsSidePanel';
import AdminConsole from './AdminConsole';

export default function App() {
  return (
    <Provider theme={defaultTheme} colorScheme="light" height="100%">
      <HashRouter>
        <Routes>
          <Route path="/" element={<ExtensionRegistration />} />
          <Route path="/side-panel" element={<AssetDetailsSidePanel />} />
          <Route path="/admin" element={<AdminConsole />} />
        </Routes>
      </HashRouter>
    </Provider>
  );
}

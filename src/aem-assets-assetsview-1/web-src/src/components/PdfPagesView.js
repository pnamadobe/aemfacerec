import React, { useEffect, useRef, useState } from 'react';
// PDF.js is shipped as raw text assets (see hooks/pre-build.js) because the bundler cannot parse
// its Node-only branches. It is turned into blob: URLs at runtime, only when a contract is shown.
import pdfLibUrl from 'url:../vendor/pdf.min.js.txt';
import workerUrl from 'url:../vendor/pdf.worker.min.js.txt';

let pdfLibPromise = null;
async function toBlobUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('PDF viewer failed to load.');
  return URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
}

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfLibPromise) {
    pdfLibPromise = Promise.all([toBlobUrl(pdfLibUrl), toBlobUrl(workerUrl)]).then(
      ([libBlobUrl, workerBlobUrl]) =>
        new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = libBlobUrl;
          script.onload = () => {
            if (!window.pdfjsLib) return reject(new Error('PDF viewer failed to initialize.'));
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
            return resolve(window.pdfjsLib);
          };
          script.onerror = () => reject(new Error('PDF viewer failed to load.'));
          document.head.appendChild(script);
        })
    );
    pdfLibPromise.catch(() => {
      pdfLibPromise = null;
    });
  }
  return pdfLibPromise;
}

const MAX_PAGES = 12;

/**
 * Renders PDF pages to canvases ourselves. The host sandboxes extension iframes, and Chrome will
 * not show its built-in PDF viewer inside a sandboxed frame.
 */
export default function PdfPagesView({ data, onError }) {
  const containerRef = useRef(null);
  const [state, setState] = useState({ status: 'loading', pages: 0, error: '' });

  useEffect(() => {
    if (!data) return undefined;
    let cancelled = false;
    let doc = null;
    (async () => {
      try {
        const pdfjsLib = await loadPdfJs();
        doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
        if (cancelled) return;
        const host = containerRef.current;
        host.innerHTML = '';
        const pages = Math.min(doc.numPages, MAX_PAGES);
        const width = Math.max(320, host.clientWidth - 24);
        for (let n = 1; n <= pages; n++) {
          // eslint-disable-next-line no-await-in-loop
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2.5, width / base.width);
          const viewport = page.getViewport({ scale });
          const ratio = window.devicePixelRatio || 1;
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Contract page ${n} of ${doc.numPages}`);
          canvas.style.cssText = `width:${Math.floor(viewport.width)}px;height:${Math.floor(viewport.height)}px;display:block;margin:0 auto var(--spectrum-global-dimension-size-150);background:var(--spectrum-global-color-static-white, white);border:1px solid var(--spectrum-global-color-gray-300)`;
          host.appendChild(canvas);
          // eslint-disable-next-line no-await-in-loop
          await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
            transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null
          }).promise;
        }
        setState({ status: 'ready', pages: doc.numPages, error: '' });
      } catch (e) {
        if (!cancelled) {
          setState({ status: 'error', pages: 0, error: e.message || 'Could not display the contract.' });
          if (onError) onError(e);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (doc) doc.destroy();
    };
  }, [data]);

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: 'var(--spectrum-global-dimension-size-150)',
        boxSizing: 'border-box',
        background: 'var(--spectrum-global-color-gray-200)'
      }}
    >
      <div ref={containerRef} />
      {state.status === 'error' && (
        <div role="alert" style={{ color: 'var(--spectrum-global-color-red-600)' }}>
          {state.error}
        </div>
      )}
      {state.status === 'ready' && state.pages > MAX_PAGES && (
        <div style={{ textAlign: 'center', color: 'var(--spectrum-global-color-gray-700)' }}>
          Showing the first {MAX_PAGES} of {state.pages} pages.
        </div>
      )}
    </div>
  );
}

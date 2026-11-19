const fs = require('fs');
const path = require('path');

// Copies the PDF.js build into web-src as plain `.txt` files. The bundler would otherwise try to
// parse PDF.js (it has Node-only branches); as raw assets they are just copied, and the viewer
// turns them into blob: URLs at runtime.
const FILES = ['pdf.min.js', 'pdf.worker.min.js'];

module.exports = (config) => {
  const rootDir = (config && config.root) || process.cwd();
  const from = path.join(rootDir, 'node_modules', 'pdfjs-dist', 'build');
  const to = path.join(rootDir, 'src', 'aem-assets-assetsview-1', 'web-src', 'src', 'vendor');
  fs.mkdirSync(to, { recursive: true });
  for (const f of FILES) {
    fs.copyFileSync(path.join(from, f), path.join(to, `${f}.txt`));
  }
};

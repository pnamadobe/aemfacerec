const fs = require('fs');
const path = require('path');

// Create a stable `/web-src.bundle.js` alias and rewrite index.html to load it
// so a cached index.html in the browser or CDN edge POP never 404s when a new build is deployed.
const STABLE_BUNDLE_NAME = 'web-src.bundle.js';

module.exports = (config) => {
  try {
    const rootDir = (config && config.root) || process.cwd();
    const webProdDir = path.join(rootDir, 'dist', 'aem-assets-assetsview-1', 'web-prod');
    if (!fs.existsSync(webProdDir)) return;

    const files = fs.readdirSync(webProdDir);
    const indexHtmlPath = path.join(webProdDir, 'index.html');
    let currentBundle = null;
    if (fs.existsSync(indexHtmlPath)) {
      const html = fs.readFileSync(indexHtmlPath, 'utf8');
      const m = html.match(/src="\/?(web-src\.[a-f0-9]+\.js)"/i);
      if (m && files.includes(m[1])) {
        currentBundle = m[1];
      }
    }
    if (!currentBundle) {
      currentBundle = files.find((f) => /^web-src\.[a-f0-9]+\.js$/i.test(f));
    }
    if (!currentBundle) return;

    const srcPath = path.join(webProdDir, currentBundle);
    if (currentBundle !== STABLE_BUNDLE_NAME) {
      fs.copyFileSync(srcPath, path.join(webProdDir, STABLE_BUNDLE_NAME));
    }

    if (fs.existsSync(indexHtmlPath)) {
      const html = fs.readFileSync(indexHtmlPath, 'utf8');
      const updatedHtml = html.replace(
        /src="\/?web-src\.[a-f0-9]+\.js"/i,
        `src="/${STABLE_BUNDLE_NAME}"`
      );
      fs.writeFileSync(indexHtmlPath, updatedHtml, 'utf8');
    }
  } catch (e) {
    // ignore post-build alias errors
  }
};

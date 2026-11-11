const fs = require('fs');
const path = require('path');

// Keep alias copies for previous Parcel bundle hashes in web-prod AND rewrite index.html
// to load `/web-src.bundle.js` so a cached index.html in the browser or CloudFront edge POP
// never 404s when a new build is deployed.
const LEGACY_BUNDLE_NAMES = [
  'web-src.bundle.js',
  'web-src.351216b0.js',
  'web-src.9872f83d.js',
  'web-src.df9243c6.js',
  'web-src.3766d1ab.js',
  'web-src.0cd1de06.js',
  'web-src.a2a264e8.js',
  'web-src.bfe0a6a0.js'
];

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
    for (const alias of LEGACY_BUNDLE_NAMES) {
      if (alias !== currentBundle) {
        fs.copyFileSync(srcPath, path.join(webProdDir, alias));
      }
    }

    if (fs.existsSync(indexHtmlPath)) {
      const html = fs.readFileSync(indexHtmlPath, 'utf8');
      const updatedHtml = html.replace(
        /src="\/?web-src\.[a-f0-9]+\.js"/i,
        'src="/web-src.bundle.js"'
      );
      fs.writeFileSync(indexHtmlPath, updatedHtml, 'utf8');
    }
  } catch (e) {
    // ignore post-build alias errors
  }
};

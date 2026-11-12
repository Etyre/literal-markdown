// Renders build/icon.svg to build/icon.icns, which electron-builder picks up automatically.
// Run with: npm run icon   (Electron does the SVG rendering, so no extra tools are needed.)
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'icon.svg'));
  await new Promise((r) => setTimeout(r, 300));
  const full = (await win.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  const set = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'literal-icon-')), 'icon.iconset');
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      fs.writeFileSync(path.join(set, name), full.resize({ width: px, height: px, quality: 'best' }).toPNG());
    }
  }
  fs.writeFileSync(path.join(__dirname, 'icon.png'), full.toPNG());
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'icon.icns')]);
  console.log('wrote build/icon.icns and build/icon.png');
  app.quit();
});

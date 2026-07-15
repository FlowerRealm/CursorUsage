const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

async function copyAssets() {
  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const webviewSrc = path.join(__dirname, 'src', 'webview', 'dashboard.html');
  fs.copyFileSync(webviewSrc, path.join(distDir, 'dashboard.html'));

  // Hot-reloadable capture assets (synced to ~/.cursor-usage-tracker by patcher)
  for (const name of ['hook.mjs', 'preload-intercept.cjs']) {
    const src = path.join(__dirname, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing asset for package: ${src}`);
    }
    fs.copyFileSync(src, path.join(distDir, name));
  }
}

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false
};

async function main() {
  await copyAssets();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('Build complete.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

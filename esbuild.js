const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

async function copyAssets() {
  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const webviewSrc = path.join(__dirname, 'src', 'webview', 'dashboard.html');
  fs.copyFileSync(webviewSrc, path.join(distDir, 'dashboard.html'));
}

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production
};

async function main() {
  await copyAssets();

  if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log('[cursor-usage] watching…');
  } else {
    await esbuild.build(buildOptions);
    console.log(`[cursor-usage] build complete${production ? ' (production)' : ''}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

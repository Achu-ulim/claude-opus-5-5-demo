import * as esbuild from 'esbuild';
import fs from 'fs';
import crypto from 'crypto';

const res = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: process.argv.includes('--dev') ? false : true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync('src/index.html', 'utf8').replace('<!--APP_SCRIPT-->', () => `<script>${js}</script>`);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);

// PWA files: copy public/ as-is, then stamp the service worker with a hash of this build so each deploy busts the offline cache
fs.cpSync('public', 'dist', { recursive: true });
const hash = crypto.createHash('sha1').update(html).update(fs.readFileSync('public/manifest.webmanifest')).digest('hex').slice(0, 10);
fs.writeFileSync('dist/sw.js', fs.readFileSync('public/sw.js', 'utf8').replaceAll('__VERSION__', hash));
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB', '· sw', hash);

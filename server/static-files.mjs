import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const staticFileAllowlist = new Set([
  '/index.html',
  '/pos.html',
  '/pos-runtime.js',
  '/pos.css',
  '/pos-fonts.css',
  '/vendor/phosphor-duotone.css',
  '/vendor/phosphor-bold.css',
  '/vendor/phosphor-regular.css',
  '/vendor/phosphor-fill.css',
  '/vendor/Phosphor-Duotone.woff2',
  '/vendor/Phosphor-Bold.woff2',
  '/vendor/Phosphor.woff2',
  '/vendor/Phosphor-Fill.woff2',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icon.svg',
  '/fastq-mark.png',
  '/fastq-icon-192.png',
  '/fastq-icon-512.png',
  '/fastq-cart.png',
  '/sw.js',
  '/pos-utils.mjs',
  '/pos-storage.mjs',
  '/cart-utils.mjs',
  '/sale-policy.mjs',
  '/shift-utils.mjs',
  '/sync-policy.js',
  '/sync-role-policy.mjs',
  '/product-icons.mjs',
  '/landing.css',
  '/shell-theme.css',
  '/typography.css',
  '/shell-layout.css',
]);
const staticAssetPath =
  /^\/(?:assets|vendor)\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.(?:js|css|svg|ico|png|jpe?g|webp|woff2?)$/i;

export async function serveStaticFile(
  res,
  url,
  { staticRoot, staticBuildAvailable, securityHeaders, json },
) {
  if (!staticBuildAvailable)
    return json(res, 503, {
      error: 'Build web tidak tersedia. Jalankan proses build sebelum menyajikan aplikasi.',
    });
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return res.writeHead(400, securityHeaders()).end('Bad Request');
  }
  if (pathname.split('/').some((part) => part.startsWith('.')) || pathname.includes('\\'))
    return res.writeHead(404, securityHeaders()).end('Not Found');
  const appRoute =
    !['/api', '/assets', '/legacy'].includes(pathname) &&
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/assets/') &&
    !pathname.startsWith('/legacy/') &&
    !extname(pathname);
  if (!appRoute && !staticFileAllowlist.has(pathname) && !staticAssetPath.test(pathname))
    return res.writeHead(404, securityHeaders()).end('Not Found');
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = resolve(staticRoot, `.${requested}`);
  try {
    await access(file);
  } catch {
    if (!extname(pathname)) file = resolve(staticRoot, 'index.html');
    else
      return res
        .writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        .end('Not Found');
  }
  const relativePath = relative(staticRoot, file);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    return res.writeHead(403).end('Forbidden');
  let body = await readFile(file);
  const nonce = extname(file) === '.html' ? randomBytes(18).toString('base64') : '';
  if (nonce)
    body = Buffer.from(
      body.toString('utf8').replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`),
    );
  const isUnversionedAppAsset =
    /\.(?:js|mjs|css)$/.test(pathname) && !pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    ...securityHeaders(nonce),
    'Cache-Control':
      file.endsWith('index.html') ||
      file.endsWith('pos.html') ||
      file.endsWith('sw.js') ||
      isUnversionedAppAsset
        ? 'no-cache'
        : 'public, max-age=3600',
  });
  res.end(body);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStaticFile } from '../server/static-files.mjs';

async function getCacheControl(staticRoot, pathname) {
  const response = {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end() {
      return this;
    },
  };
  await serveStaticFile(response, new URL(`http://localhost${pathname}`), {
    staticRoot,
    staticBuildAvailable: true,
    securityHeaders: () => ({}),
    json() {},
  });
  assert.equal(response.status, 200);
  return response.headers['Cache-Control'];
}

test('unversioned app modules are revalidated while hashed bundles remain cacheable', async () => {
  const staticRoot = await mkdtemp(join(tmpdir(), 'fastq-static-files-'));
  try {
    await mkdir(join(staticRoot, 'assets'));
    await writeFile(join(staticRoot, 'pos-runtime.js'), 'export {};');
    await writeFile(join(staticRoot, 'assets', 'index-deadbeef.js'), 'export {};');

    assert.equal(await getCacheControl(staticRoot, '/pos-runtime.js'), 'no-cache');
    assert.equal(
      await getCacheControl(staticRoot, '/assets/index-deadbeef.js'),
      'public, max-age=3600',
    );
  } finally {
    await rm(staticRoot, { recursive: true, force: true });
  }
});

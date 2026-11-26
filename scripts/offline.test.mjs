import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  collectPendingStockProductIds,
  isServerReachable,
  mergeShiftEvent,
  mergeStockBalances,
  mergeStockSnapshot,
  prepareSyncOutbox,
} from '../shared/sync-policy.js';
import { roleEventTypes } from '../shared/sync-role-policy.mjs';
import { PRODUCT_ICONS, isProductIcon } from '../shared/product-icons.mjs';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../app/pos/runtime.js', import.meta.url), 'utf8');
const posPageSource = await readFile(new URL('../app/pos/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const nativeStorageSource = await readFile(
  new URL('../app/src/nativeStorage.ts', import.meta.url),
  'utf8',
);
const designSystemSource = await readFile(
  new URL('../styles/design-system.css', import.meta.url),
  'utf8',
);
const productXlsxSource = await readFile(
  new URL('../app/pos/product-xlsx.js', import.meta.url),
  'utf8',
);
const executableRuntimeSource = runtimeSource
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
  .replace('export async function createPosRuntime', 'async function createPosRuntime')
  .concat('\nglobalThis.createPosRuntime = createPosRuntime;');
function loadPosRuntime(context) {
  if (!context.structuredClone) context.structuredClone = structuredClone;
  if (!context.URLSearchParams) context.URLSearchParams = URLSearchParams;
  context.PRODUCT_ICONS ||= PRODUCT_ICONS;
  context.isProductIcon ||= isProductIcon;
  if (!context.collectPendingStockProductIds)
    context.collectPendingStockProductIds = collectPendingStockProductIds;
  runInNewContext(executableRuntimeSource, context);
  return context.createPosRuntime;
}
async function createClearRuntime(savedState, { online = false, fetchImpl } = {}) {
  const operations = [];
  const storedValues = new Map();
  let uuid = 0;
  const context = {
    AbortController,
    AbortSignal,
    TextEncoder,
    setTimeout: () => 1,
    clearTimeout() {},
    prepareSyncOutbox,
    isServerReachable,
    mergeShiftEvent,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
      clear: async () => operations.push('clear'),
    }),
    createUuid: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    fetch: async (...args) => {
      operations.push(args[0]);
      if (fetchImpl) return fetchImpl(...args);
      throw new Error('Unexpected network request.');
    },
    localStorage: {
      getItem: (key) => storedValues.get(key) || null,
      setItem: (key, value) => storedValues.set(key, value),
      removeItem: (key) => storedValues.delete(key),
    },
    navigator: { onLine: online },
    window: { addEventListener() {} },
    roleEventTypes,
  };
  loadPosRuntime(context);
  return { runtime: await context.createPosRuntime(), operations };
}
function pendingClearState(syncOutbox = []) {
  return {
    activeOutlet: 'outlet-a',
    catalogInitialized: true,
    syncInitialized: true,
    stockSnapshotVersion: 1,
    syncOutbox,
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
    },
  };
}
test('POS status strings do not contain common UTF-8 mojibake markers', () => {
  assert.doesNotMatch(runtimeSource, /[ÂÃ]/);
});
test('product cards never render image and icon fallback at the same time', () => {
  assert.match(posPageSource, /if \(!imageId\)[\s\S]*return `<span[\s\S]*>[\s\S]*<\/span>`/);
  assert.doesNotMatch(posPageSource, /<img[\s\S]*nextElementSibling[\s\S]*hidden/);
});
test('cashier confirmations use custom dialogs instead of browser prompts', () => {
  assert.doesNotMatch(
    `${posPageSource}\n${appSource}`,
    /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/,
  );
  assert.match(posPageSource, /id="posConfirmDialog"/);
  assert.match(appSource, /role="alertdialog"/);
});
test('long product categories wrap within their table cell and render as text', () => {
  assert.match(
    posPageSource,
    /class="px-4 py-3 text-xs text-slate-600 whitespace-normal break-words" title="\$\{escapeHtml\(p\.category\)\}">\$\{escapeHtml\(p\.category\)\}<\/td>/,
  );
});
test('POS startup does not request the server session before login', async () => {
  const { runtime, operations } = await createClearRuntime({}, { online: true });

  await runtime.init();

  assert.deepEqual(operations, []);
});

test('legacy outlet upserts are removed from active and saved outlet queues', async () => {
  const legacyEvent = (id, outletId) => ({
    id,
    type: 'outlet.upsert',
    outletId,
    payload: { id: outletId, name: 'Outlet' },
  });
  const productEvent = {
    id: 'product-event',
    type: 'product.upsert',
    outletId: 'outlet-a',
    payload: { id: 'product-a' },
  };
  const savedState = {
    ...pendingClearState([legacyEvent('event-active', 'outlet-a'), productEvent]),
    localOutletPartitions: {
      'outlet-b': {
        syncOutbox: [
          legacyEvent('event-saved', 'outlet-b'),
          { ...productEvent, outletId: 'outlet-b' },
        ],
      },
    },
  };

  const { runtime } = await createClearRuntime(savedState);

  assert.deepEqual(runtime.state.syncOutbox, [productEvent]);
  assert.deepEqual(runtime.state.localOutletPartitions['outlet-b'].syncOutbox, [
    { ...productEvent, outletId: 'outlet-b' },
  ]);
  assert.equal(runtime.getLocalPendingCount(), 2);
});

test('Admin transaction export fetches every page for the selected date range', async () => {
  const savedState = {
    settings: {
      serverSession: {
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'Admin',
          outletId: '00000000-0000-4000-8000-000000000002',
        },
      },
    },
  };
  const requests = [];
  const pages = [
    {
      sales: [{ id: 'sale-one' }],
      hasMore: true,
      next: {
        before: '2026-11-20T08:00:00.000Z',
        beforeId: '00000000-0000-4000-8000-000000000003',
      },
    },
    { sales: [{ id: 'sale-two' }], hasMore: false, next: null },
  ];
  const { runtime } = await createClearRuntime(savedState, {
    online: true,
    fetchImpl: async (url) => {
      requests.push(new URL(url, 'https://pos.local'));
      return { ok: true, json: async () => pages.shift() };
    },
  });

  const sales = await runtime.exportSalesHistory('2026-11-01', '2026-11-28');

  assert.equal(sales.length, 2);
  assert.equal(sales[0].id, 'sale-one');
  assert.equal(sales[1].id, 'sale-two');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('from'), '2026-11-01');
  assert.equal(requests[0].searchParams.get('to'), '2026-11-28');
  assert.equal(requests[0].searchParams.get('limit'), '100');
  assert.equal(requests[1].searchParams.get('beforeId'), '00000000-0000-4000-8000-000000000003');
});
test('transaction export is restricted to Admin accounts', async () => {
  const savedState = {
    settings: {
      serverSession: {
        user: { id: 'cashier-a', role: 'Kasir', outletId: 'outlet-a' },
      },
    },
  };
  const { runtime, operations } = await createClearRuntime(savedState, { online: true });

  await assert.rejects(
    runtime.exportSalesHistory('2026-11-01', '2026-11-28'),
    /hanya tersedia untuk Admin/,
  );
  assert.deepEqual(operations, []);
});
test('users load and cache their server-authorized outlets for switching', async () => {
  const savedState = {
    settings: {
      serverSession: {
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'Kasir',
          outletId: '00000000-0000-4000-8000-000000000002',
        },
      },
    },
  };
  const { runtime, operations } = await createClearRuntime(savedState, {
    online: true,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        outlets: [
          { id: '00000000-0000-4000-8000-000000000002', name: 'Toko Utama' },
          { id: '00000000-0000-4000-8000-000000000003', name: 'Cabang' },
        ],
      }),
    }),
  });

  const outlets = await runtime.getAccessibleOutlets();

  assert.equal(operations[0], '/api/auth/outlets');
  assert.equal(outlets.length, 2);
  assert.equal(runtime.getStateSnapshot().outlets[1].name, 'Cabang');
});
test('registration dialog stacks above the required login overlay', () => {
  const startupZIndex = Number(
    designSystemSource.match(
      /#designStartupOverlay:not\(\[hidden\]\)\s*\{[^}]*z-index:\s*(\d+)/,
    )?.[1],
  );
  const actionZIndex = Number(
    designSystemSource.match(
      /body\.design-auth-required\s*>\s*#designActionDialog\s*\{[^}]*z-index:\s*(\d+)/,
    )?.[1],
  );
  assert.ok(actionZIndex > startupZIndex);
});
test('action dialogs report missing required fields inline', () => {
  assert.match(posPageSource, /<form class="space-y-3" novalidate>/);
  assert.match(posPageSource, /const missingField = fields\.find/);
  assert.match(posPageSource, /wajib diisi\./);
});
test('action dialog submissions show a busy state and restore the button after failure', () => {
  assert.match(posPageSource, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(posPageSource, /animate-spin/);
  assert.match(posPageSource, /Menyimpan…/);
  assert.match(posPageSource, /button\.removeAttribute\('aria-busy'\)/);
});
test('only Owners or Admins viewing Kasir accounts can open outlet access settings', () => {
  assert.match(posPageSource, /function canManageUserOutletAccess\(user/);
  assert.match(posPageSource, /snapshot\.role === 'Admin' && user\.role === 'Kasir'/);
  assert.match(posPageSource, /userOutletAccessButton'\)\.hidden = !canEditOutletAccess/);
});
test('transaction export filter and product modal scrolling stay within their cards', () => {
  assert.match(posPageSource, /id="exportTransactionHistoryButton"/);
  assert.match(posPageSource, /function openTransactionExportDialog\(\)/);
  assert.match(posPageSource, /PosRuntime\.exportSalesHistory\(startDate, endDate\)/);
  assert.match(posPageSource, /PosRuntime\.getAccessibleOutlets\(\)/);
  assert.match(posPageSource, /max-h-\[calc\(100dvh-2rem\)\].*overflow-y-auto/);
  assert.match(posPageSource, /id="prodFormIconGrid"[\s\S]*?max-h-48[\s\S]*?overflow-y-auto/);
  assert.match(posPageSource, /name: 'outlet',[\s\S]{0,180}customDropdown: true/);
});
test('product visual tabs clear inactive styles and expose their active state', () => {
  assert.match(posPageSource, /button\.classList\.toggle\('border-slate-200', !active\)/);
  assert.match(posPageSource, /button\.classList\.toggle\('bg-white', !active\)/);
  assert.match(posPageSource, /button\.setAttribute\('aria-pressed', String\(active\)\)/);
  assert.match(posPageSource, /focus-visible:ring-2 focus-visible:ring-blue-200/);
});
test('shift, attendance, and held-order controls derive their labels from runtime state', () => {
  assert.match(posPageSource, /id="activeShiftStatusText"/);
  assert.match(posPageSource, /activeShift\.shiftName \|\| 'Shift'/);
  assert.match(posPageSource, /activeShift \? 'Tutup shift' : 'Buka shift'/);
  assert.match(posPageSource, /id="attendanceInButton"/);
  assert.match(posPageSource, /id="attendanceOutButton"/);
  assert.match(posPageSource, /Mengambil lokasi/);
  assert.match(posPageSource, /id="attendanceActionStatusMobile"/);
  assert.match(posPageSource, /lg:hidden mt-0\.5/);
  assert.doesNotMatch(posPageSource, /id="attendanceActionStatus"/);
  assert.match(posPageSource, /id="resumeHeldOrdersButton"/);
  assert.match(posPageSource, /Pulihkan \(\$\{holds\.length\}\)/);
  assert.match(posPageSource, /function scheduleRuntimeRefresh\(data\)/);
  assert.match(posPageSource, /if \(currentPage === 'produk'\) renderProductsTable\(\)/);
});
test('attendance controls do not include hard-coded sample staff or outlet data', () => {
  assert.doesNotMatch(posPageSource, /data-dd-option="(?:Admin Uji|Kasir Uji|Manajer Uji)"/);
  assert.doesNotMatch(posPageSource, /const todayDate = '22 Nov 2026'/);
  assert.match(posPageSource, /window\.PosRuntime\?\.getStateSnapshot\?\.\(\)\.outlet/);
});
test('mobile product header keeps actions compact without text overlap', () => {
  assert.match(posPageSource, /id="btnStockHistory"/);
  assert.match(posPageSource, /aria-label="Impor Excel"/);
  assert.match(posPageSource, /aria-label="Tambah produk"/);
  assert.match(designSystemSource, /#page-produk > \.tab-fixed-header/);
  assert.match(designSystemSource, /#page-produk > \.tab-fixed-header button/);
  assert.match(designSystemSource, /width: 36px;/);
});
test('product Excel template contains the expected spreadsheet columns', () => {
  const context = { window: { fflate: { strToU8, zipSync } } };
  runInNewContext(productXlsxSource, context);

  const files = unzipSync(context.window.ProductXlsx.createTemplate());
  const worksheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  for (const header of ['SKU', 'Nama Produk', 'Kategori', 'Harga Jual', 'Modal', 'Stok'])
    assert.ok(worksheet.includes(`<t>${header}</t>`));
  for (const unsupportedField of ['Barcode', 'Satuan', 'Stok Minimum'])
    assert.ok(!worksheet.includes(`<t>${unsupportedField}</t>`));
});
test('attendance events include the geolocation capture timestamp required by the server', async () => {
  const savedState = {
    settings: {
      serverSession: {
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Admin',
          role: 'Admin',
          outletId: '00000000-0000-4000-8000-000000000002',
        },
      },
    },
    activeOutlet: '00000000-0000-4000-8000-000000000002',
  };
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => '00000000-0000-4000-8000-000000000003',
    navigator: {
      onLine: false,
      geolocation: {
        getCurrentPosition(success) {
          success({
            timestamp: 1_795_642_800_000,
            coords: { latitude: -6.2, longitude: 106.8, accuracy: 10 },
          });
        },
      },
    },
    roleEventTypes,
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.setAttendance('in');

  const attendanceEvent = runtime.state.syncOutbox.find(
    (event) => event.type === 'attendance.upsert',
  );
  assert.equal(
    attendanceEvent.payload.checkInLocation.capturedAt,
    new Date(1_795_642_800_000).toISOString(),
  );
});
test('POS runtime preserves a saved catalog when restoring state', async () => {
  const savedState = {
    products: [{ id: 'cached-product' }],
    sales: [{ id: 'cached-sale' }],
    activeOutlet: 'outlet-a',
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    settings: {
      localDataOutletId: 'outlet-a',
      offlineSession: { user: { outletId: 'outlet-a' } },
    },
  };
  const context = {
    createPosStorage: () => ({ readSavedState: async () => savedState }),
    createUuid: () => 'device-id',
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  const restored = JSON.parse(JSON.stringify(runtime.state));
  assert.deepEqual(restored.products, savedState.products);
  assert.deepEqual(restored.sales, savedState.sales);
  assert.equal(restored.catalogInitialized, true);
  assert.equal(restored.settings.localDataOutletId, 'outlet-a');
});
test('sales trend chart uses a contained responsive viewBox and direct line segments', () => {
  assert.match(posPageSource, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(posPageSource, /h-\[380px\]/);
  assert.match(posPageSource, /reportChartCanvas[\s\S]*h-\[220px\][\s\S]*flex-1/);
  assert.match(posPageSource, /const linePath = points[\s\S]*\.join\(' '\)/);
});

test('top product orbit label distinguishes top-five units from all period items', () => {
  assert.match(posPageSource, /unit teratas/);
  assert.match(posPageSource, /slice\(0, 5\)/);
  assert.match(posPageSource, /itemCount = sales\.reduce/);
  assert.match(posPageSource, /h-\[380px\]/);
  assert.match(posPageSource, /h-\[230px\]/);
  assert.match(posPageSource, /productOrbitTopMeta/);
  assert.match(posPageSource, /#\$\{index \+ 1\} \| \$\{share\}%/);
});

test('refreshing recent sales updates report data without changing older-page cursor', async () => {
  const olderCursor = { before: '2026-11-20T10:00:00.000Z', beforeId: 'older-sale' };
  const savedState = {
    sales: [{ id: 'older-sale', at: '2026-11-20T10:00:00.000Z' }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
      salesCursor: olderCursor,
    },
    activeOutlet: 'outlet-a',
  };
  let requestedPath;
  const context = {
    AbortSignal,
    URLSearchParams,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    navigator: { onLine: true },
    fetch: async (path) => {
      requestedPath = path;
      return {
        ok: true,
        json: async () => ({
          sales: [{ id: 'new-sale', at: '2026-11-24T10:00:00.000Z', items: [], refunds: [] }],
          next: { before: '2026-11-23T10:00:00.000Z', beforeId: 'new-sale' },
          hasMore: true,
        }),
      };
    },
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.refreshSalesHistory();

  assert.equal(requestedPath, '/api/sales?limit=50');
  assert.deepEqual(
    runtime.state.sales.map((sale) => sale.id),
    ['new-sale', 'older-sale'],
  );
  assert.deepEqual(runtime.state.settings.salesCursor, olderCursor);
});
test('opening a shift saves its trimmed display name to the local history event', async () => {
  const { runtime } = await createClearRuntime(pendingClearState(), { online: false });

  runtime.openCashShift(100, ' Shift 1 ');

  assert.equal(runtime.state.activeShift.shiftName, 'Shift 1');
  assert.equal(
    runtime.state.syncOutbox.find((event) => event.type === 'shift.upsert').payload.shiftName,
    'Shift 1',
  );
});
test('Admin outlet access changes are limited to Kasir accounts, never the active account', async () => {
  const savedState = pendingClearState();
  savedState.users = [
    { id: 'admin-a', role: 'Admin' },
    { id: 'admin-b', role: 'Admin' },
    { id: 'cashier-a', role: 'Kasir' },
  ];
  const { runtime, operations } = await createClearRuntime(savedState, {
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await assert.rejects(runtime.updateUserOutletAccess('admin-a', ['outlet-a']), /miliknya sendiri/);
  await assert.rejects(
    runtime.updateUserOutletAccess('admin-b', ['outlet-a']),
    /hanya dapat mengubah akses outlet akun Kasir/,
  );
  await runtime.updateUserOutletAccess('cashier-a', ['outlet-a']);

  assert.ok(operations.includes('/api/auth/store-access'));
});
test('stock history filters use custom kind and date controls', () => {
  assert.match(posPageSource, /id="stockHistoryKind"[\s\S]*type="button"[\s\S]*data-dd-menu/);
  assert.match(posPageSource, /selectStockHistoryKind\('Semua', 'Semua jenis'\)/);
  assert.match(posPageSource, /id="stockHistoryFrom"[\s\S]*h-px w-px[\s\S]*opacity-0/);
  assert.match(posPageSource, /id="stockHistoryTo"[\s\S]*h-px w-px[\s\S]*opacity-0/);
  assert.match(posPageSource, /updateStockHistoryDateLabel/);
  assert.match(posPageSource, /openStockHistoryDatePicker\('stockHistoryFrom'\)/);
  assert.match(posPageSource, /openStockHistoryDatePicker\('stockHistoryTo'\)/);
  assert.match(posPageSource, /grid grid-cols-2 sm:flex sm:items-center/);
  assert.doesNotMatch(posPageSource, /id="stockHistorySearch"[^>]*class="[^"]*\bcol-span-2\b/);
});
test('offline stock history pages contain at most 10 rows and support previous and next', async () => {
  const savedState = {
    ...pendingClearState(),
    stockMovements: Array.from({ length: 23 }, (_, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      productId: '40000000-0000-4000-8000-000000000001',
      at: new Date(Date.UTC(2026, 10, 25, 0, 0, index)).toISOString(),
      delta: 1,
      reason: 'Penyesuaian stok',
    })),
  };
  const { runtime } = await createClearRuntime(savedState);

  const first = await runtime.loadStockHistory();
  assert.equal(first.movements.length, 10);
  assert.equal(first.page, 1);
  assert.equal(first.hasPrevious, false);
  assert.equal(first.hasMore, true);

  const second = await runtime.loadStockHistory({}, false, 'next');
  assert.equal(second.movements.length, 10);
  assert.equal(second.page, 2);
  assert.equal(second.hasPrevious, true);
  assert.equal(second.hasMore, true);

  const previous = await runtime.loadStockHistory({}, false, 'prev');
  assert.equal(previous.movements.length, 10);
  assert.equal(previous.page, 1);
  assert.equal(previous.hasPrevious, false);
});
test('product import updates matching SKU and name, and suffixes conflicting SKUs', async () => {
  const savedState = {
    products: [
      {
        id: 'existing-match',
        sku: 'MATCH',
        name: 'Produk Sama',
        category: 'Kategori Lama',
        unit: 'pcs',
        price: 1000,
        cost: 500,
        stock: 2,
        stockByOutlet: { 'outlet-a': 2 },
        createdOutletId: 'outlet-a',
      },
      {
        id: 'existing-conflict',
        sku: 'BASE',
        name: 'Nama Lama',
        category: 'Kategori',
        price: 1000,
        cost: 500,
        stock: 1,
        createdOutletId: 'outlet-a',
      },
    ],
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
  };
  let uuid = 0;
  const context = {
    AbortSignal,
    TextEncoder,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => `generated-${++uuid}`,
    navigator: { onLine: false },
    roleEventTypes,
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  const result = await runtime.importProducts([
    {
      rowNumber: 2,
      sku: 'MATCH',
      name: 'produk sama',
      category: 'Jangan ubah',
      price: 1200,
      cost: 600,
      stock: 5,
    },
    {
      rowNumber: 3,
      sku: 'BASE',
      name: 'Nama Baru',
      category: 'Kategori',
      price: 900,
      cost: 400,
      stock: 3,
    },
    {
      rowNumber: 4,
      sku: 'BASE',
      name: 'Nama Ketiga',
      category: 'Kategori',
      price: 800,
      cost: 300,
      stock: 4,
    },
    {
      rowNumber: 5,
      sku: 'INVALID',
      name: 'Harga kosong',
      category: 'Kategori',
      price: '',
      cost: 0,
      stock: 0,
    },
    {
      rowNumber: 6,
      sku: 'DUP',
      name: 'Produk Duplikat',
      category: 'Kategori',
      price: 700,
      cost: 300,
      stock: 5,
    },
    {
      rowNumber: 7,
      sku: 'DUP',
      name: 'Produk Duplikat',
      category: 'Kategori',
      price: 700,
      cost: 300,
      stock: 10,
    },
  ]);

  assert.equal(result.added, 3);
  assert.equal(result.updated, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 5);
  assert.equal(
    runtime.state.products.find((product) => product.id === 'existing-match').price,
    1200,
  );
  assert.equal(
    runtime.state.products.find((product) => product.id === 'existing-match').category,
    'Kategori Lama',
  );
  const updatedMatch = runtime.state.syncOutbox
    .filter((event) => event.type === 'product.bulkUpsert')
    .flatMap((event) => event.payload.products)
    .find((product) => product.id === 'existing-match');
  assert.equal(updatedMatch.stock, 5);
  assert.equal(updatedMatch.stockDelta, 3);
  assert.ok(runtime.state.products.some((product) => product.sku === 'BASE-D'));
  assert.ok(runtime.state.products.some((product) => product.sku === 'BASE-D2'));
  const duplicateProduct = runtime.state.products.find((product) => product.sku === 'DUP');
  assert.equal(duplicateProduct.stock, 10);
  const duplicateUpserts = runtime.state.syncOutbox.flatMap((event) =>
    event.type === 'product.bulkUpsert'
      ? event.payload.products.filter((product) => product.sku === 'DUP')
      : [],
  );
  assert.equal(duplicateUpserts.length, 1);
  assert.equal(duplicateUpserts[0].stock, 10);
  assert.equal(duplicateUpserts[0].stockDelta, null);
  assert.equal(
    runtime.state.syncOutbox.some(
      (event) => event.type === 'stock.delta' && event.payload.productId === duplicateProduct.id,
    ),
    false,
  );
});
test('product import chunks bulk events at 500 products', async () => {
  const savedState = {
    products: [],
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
  };
  let uuid = 0;
  const context = {
    AbortSignal,
    TextEncoder,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => `generated-${++uuid}`,
    navigator: { onLine: false },
    roleEventTypes,
  };
  loadPosRuntime(context);
  const runtime = await context.createPosRuntime();
  await runtime.importProducts(
    Array.from({ length: 501 }, (_, index) => ({
      sku: `SKU-${index}`,
      name: `Produk ${index}`,
      category: 'Kategori',
      price: 1000,
      cost: 500,
      stock: 0,
    })),
  );
  const batches = runtime.state.syncOutbox.filter((event) => event.type === 'product.bulkUpsert');
  assert.deepEqual(
    Array.from(batches, (event) => event.payload.products.length),
    [500, 1],
  );
});
test('clearing local data skips sync when no events are pending', async () => {
  const { runtime, operations } = await createClearRuntime(pendingClearState());

  await runtime.clearLocalDataAfterSync();

  assert.deepEqual(operations, ['clear']);
  assert.equal(runtime.getLocalPendingCount(), 0);
});
test('clearing local data preserves pending events while offline', async () => {
  const event = {
    id: '20000000-0000-4000-8000-000000000001',
    type: 'audit.append',
    outletId: 'outlet-a',
    at: '2026-11-25T00:00:00.000Z',
    payload: { id: '20000000-0000-4000-8000-000000000001', action: 'Test' },
  };
  const { runtime, operations } = await createClearRuntime(pendingClearState([event]));

  await assert.rejects(runtime.clearLocalDataAfterSync(), /perangkat sedang offline/);

  assert.deepEqual(operations, []);
  assert.equal(runtime.getLocalPendingCount(), 1);
});
test('clearing local data syncs pending events before storage and server logout', async () => {
  const event = {
    id: '20000000-0000-4000-8000-000000000001',
    type: 'audit.append',
    outletId: 'outlet-a',
    at: '2026-11-25T00:00:00.000Z',
    payload: { id: '20000000-0000-4000-8000-000000000001', action: 'Test' },
  };
  const { runtime, operations } = await createClearRuntime(pendingClearState([event]), {
    online: true,
    fetchImpl: async (url, options) => {
      if (url === '/api/health/live') return { ok: true };
      if (url === '/api/auth/logout') return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ accepted: request.events.map((item) => item.id), cursor: 1 }),
      };
    },
  });

  await runtime.clearLocalDataAfterSync();

  assert.deepEqual(operations, ['/api/health/live', '/api/sync', 'clear', '/api/auth/logout']);
  assert.equal(runtime.getLocalPendingCount(), 0);
});
test('stock transfer from a non-active outlet is rejected before local changes or network calls', async () => {
  const savedState = {
    ...pendingClearState(),
    activeOutlet: 'outlet-b',
    outlets: [
      { id: 'outlet-a', name: 'Outlet A' },
      { id: 'outlet-b', name: 'Outlet B' },
    ],
    products: [
      {
        id: 'product-a',
        stock: 4,
        stockByOutlet: { 'outlet-a': 4, 'outlet-b': 2 },
      },
    ],
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-b' },
      },
    },
  };
  const { runtime, operations } = await createClearRuntime(savedState, {
    online: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await runtime.transferStockBetweenOutlets({
    from: 'outlet-a',
    to: 'outlet-b',
    productId: 'product-a',
    qty: 1,
  });

  assert.deepEqual(operations, []);
  assert.equal(runtime.state.products[0].stockByOutlet['outlet-a'], 4);
  assert.equal(runtime.state.products[0].stockByOutlet['outlet-b'], 2);
  assert.equal(runtime.state.transfers.length, 0);
  assert.equal(runtime.state.syncOutbox.length, 0);
});
test('stock transfer from the active outlet updates balances and queues the transfer event', async () => {
  const savedState = {
    ...pendingClearState(),
    outlets: [
      { id: 'outlet-a', name: 'Outlet A' },
      { id: 'outlet-b', name: 'Outlet B' },
    ],
    products: [
      {
        id: 'product-a',
        name: 'Product A',
        stock: 4,
        stockByOutlet: { 'outlet-a': 4, 'outlet-b': 2 },
      },
    ],
  };
  const { runtime } = await createClearRuntime(savedState, {
    online: true,
    fetchImpl: async (url) => {
      if (url === '/api/health/live') return { ok: true, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [],
          stockBalances: [],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
  });

  await runtime.transferStockBetweenOutlets({
    from: 'outlet-a',
    to: 'outlet-b',
    productId: 'product-a',
    qty: 1,
  });

  assert.equal(runtime.state.products[0].stockByOutlet['outlet-a'], 3);
  assert.equal(runtime.state.products[0].stockByOutlet['outlet-b'], 3);
  assert.equal(runtime.state.transfers[0].from, 'outlet-a');
  assert.ok(runtime.state.syncOutbox.some((event) => event.type === 'transfer.upsert'));
});
test('incremental sync without a stock snapshot preserves the cached balances', async () => {
  const savedState = {
    products: [{ id: 'product-a', stock: 7, stockByOutlet: { 'outlet-a': 7 } }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path) => {
      if (path === '/api/health/live') return { ok: true };
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [],
          stockBalances: [],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(runtime.state.products[0].stock, 7);
  assert.equal(runtime.state.products[0].stockByOutlet['outlet-a'], 7);
});

test('initial Admin sync does not re-upload server-managed outlet records', async () => {
  const savedState = {
    ...pendingClearState(),
    outlets: [
      { id: 'outlet-a', name: 'Outlet A' },
      { id: 'outlet-b', name: 'Outlet B' },
    ],
  };
  const { runtime } = await createClearRuntime(savedState, {
    online: true,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        accepted: [],
        rejected: [],
        events: [],
        attendance: [],
        stockBalances: [],
        transfers: [],
        outlets: [],
        bootstrapProducts: [],
        catalogBootstrapped: false,
        bootstrapTruncated: false,
        activeShift: null,
        knownShift: null,
        cursor: 0,
        hasMore: false,
      }),
    }),
  });

  await runtime.synchronize();

  assert.equal(runtime.state.syncInitialized, true);
  assert.equal(
    runtime.state.syncOutbox.some((event) => event.type === 'outlet.upsert'),
    false,
  );
});

test('incremental sync reconciles remote stock while preserving products with pending local changes', async () => {
  const outletId = 'outlet-a';
  const savedState = {
    products: [{ id: 'product-a', stock: 5, stockByOutlet: { [outletId]: 5 } }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId },
      },
    },
    activeOutlet: outletId,
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  const context = {
    AbortController,
    AbortSignal,
    clearTimeout: () => {},
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockBalances,
    mergeStockSnapshot,
    navigator: { onLine: true },
    syncCount: 0,
    setTimeout: () => 1,
    fetch: async (path) => {
      if (path === '/api/health/live') return { ok: true };
      context.syncCount += 1;
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events:
            context.syncCount === 1
              ? [
                  {
                    event_type: 'stock.delta',
                    payload: { productId: 'product-a', outletId, delta: 2 },
                  },
                ]
              : [],
          stockBalances: [{ productId: 'product-a', outletId, variantId: null, quantity: 9 }],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 1,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(runtime.state.products[0].stock, 9);
  assert.equal(runtime.state.products[0].stockByOutlet[outletId], 9);

  runtime.state.products[0].stock = 12;
  runtime.state.products[0].stockByOutlet[outletId] = 12;
  runtime.state.syncOutbox.push({
    id: 'pending-stock',
    type: 'stock.delta',
    outletId,
    payload: { productId: 'product-a', outletId, delta: 3 },
  });
  await runtime.synchronize();
  assert.equal(runtime.state.products[0].stock, 12);
  assert.equal(runtime.state.products[0].stockByOutlet[outletId], 12);
});

test('sync conflict response exposes negative stock and flags the local sale', async () => {
  const savedState = {
    products: [
      { id: 'product-a', stock: 1, stockByOutlet: { 'outlet-a': 1 } },
      { id: 'product-b', stock: 1, stockByOutlet: { 'outlet-a': 1 } },
    ],
    sales: [{ id: 'sale-a', status: 'Lunas' }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockBalances,
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path) => {
      if (path === '/api/health/live') return { ok: true };
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [
            {
              event_type: 'stock.delta',
              payload: {
                productId: 'product-b',
                variantId: null,
                outletId: 'outlet-a',
                delta: -2,
              },
            },
          ],
          stockBalances: [],
          stockConflicts: [
            {
              saleId: 'sale-a',
              stockConflict: true,
              stockBalances: [
                { outletId: 'outlet-a', productId: 'product-a', variantId: null, quantity: -1 },
              ],
            },
          ],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(runtime.state.products[0].stock, -1);
  assert.equal(runtime.state.sales[0].stockConflict, true);
  assert.equal(runtime.state.products[1].stock, -1);
});

test('manual sync retries quarantined stock conflict events without retrying unrelated issues', async () => {
  const saleEvent = {
    id: 'sale-event',
    type: 'sale.upsert',
    outletId: 'outlet-a',
    payload: { id: 'sale-a' },
  };
  const deltaEvent = {
    id: 'stock-event',
    type: 'stock.delta',
    outletId: 'outlet-a',
    payload: { saleId: 'sale-a', reason: 'Penjualan TRX-1', delta: -2 },
  };
  const savedState = {
    products: [],
    sales: [{ id: 'sale-a' }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [
      {
        eventId: saleEvent.id,
        message:
          'new row for relation "stock_balances" violates check constraint "stock_balances_quantity_check"',
        event: saleEvent,
      },
      {
        eventId: deltaEvent.id,
        message: 'Delta akan membuat stok server menjadi negatif.',
        event: deltaEvent,
      },
      {
        eventId: 'other-event',
        message: 'Payload produk tidak valid.',
        event: { id: 'other-event', type: 'product.upsert', payload: {} },
      },
    ],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  let sentEvents = [];
  const context = {
    AbortController,
    AbortSignal,
    TextEncoder,
    clearTimeout: () => {},
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockBalances,
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path, options = {}) => {
      if (path === '/api/health/live') return { ok: true };
      const body = JSON.parse(options.body);
      sentEvents = body.events;
      return {
        ok: true,
        json: async () => ({
          accepted: sentEvents.map((event) => event.id),
          rejected: [],
          events: [],
          stockBalances: [],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: ({ events, issues }) => ({ pending: events, issues }),
    setTimeout: () => 1,
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize(true);
  assert.deepEqual(
    sentEvents.map((event) => event.id),
    ['sale-event', 'stock-event'],
  );
  assert.deepEqual(
    runtime.state.syncIssues.map((issue) => issue.eventId),
    ['other-event'],
  );
});

test('legacy catalog cache refreshes stock from the next full bootstrap', async () => {
  const savedState = {
    products: [{ id: 'product-a', stock: 0, stockByOutlet: { 'outlet-a': 0 } }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    deviceId: 'device-a',
  };
  let bootstrapRequested = false;
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path, options = {}) => {
      if (path === '/api/health/live') return { ok: true };
      bootstrapRequested = JSON.parse(options.body).bootstrap;
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [],
          stockBalances: [
            { outletId: 'outlet-a', productId: 'product-a', variantId: null, quantity: 8 },
          ],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: true,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(bootstrapRequested, true);
  assert.equal(runtime.state.products[0].stock, 8);
  assert.equal(runtime.state.stockSnapshotVersion, 1);
});
for (const [path, expected] of [
  ['/pos', './index.html'],
  ['/dashboard', './index.html'],
]) {
  test(`offline navigation ${path} uses the correct shell`, async () => {
    const handlers = {};
    let response;
    runInNewContext(source, {
      URL,
      self: {
        location: { origin: 'https://pos.test' },
        addEventListener: (name, handler) => {
          handlers[name] = handler;
        },
      },
      fetch: async () => {
        throw new Error('Offline');
      },
      caches: { match: async (key) => (typeof key === 'string' ? key : undefined) },
    });
    handlers.fetch({
      request: { method: 'GET', mode: 'navigate', url: `https://pos.test${path}` },
      respondWith: (value) => {
        response = value;
      },
    });
    assert.equal(await response, expected);
  });
}

test('authentication requests never use the offline cache', () => {
  const handlers = {};
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = input.url;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
  });
  handlers.fetch({
    request: { method: 'GET', url: 'https://pos.test/api/auth/session' },
    respondWith: () => assert.fail('API response must not be cached'),
  });
});

test('POS runtime and sync policy are cached for offline startup without legacy assets', async () => {
  const handlers = {};
  let cachedPaths = [];
  let installation;
  const cache = {
    addAll: async (requests) => {
      cachedPaths = requests.map((request) => request.url);
    },
    match: async () => null,
    add: async () => {},
  };
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = new URL(input, 'https://pos.test').href;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      skipWaiting: async () => {},
    },
    caches: { open: async () => cache },
  });
  handlers.install({
    waitUntil: (promise) => {
      installation = promise;
    },
  });
  await installation;
  assert.ok(cachedPaths.some((path) => path.endsWith('/pos-runtime.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/vendor/product-xlsx.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/vendor/fflate.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/shift-utils.mjs')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/sync-policy.js')));
  assert.ok(cachedPaths.every((path) => !path.includes('/legacy/')));
});

test('service worker activates updates only after an explicit user request', async () => {
  const handlers = {};
  let skipWaitingCount = 0;
  runInNewContext(source, {
    self: {
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      skipWaiting: async () => {
        skipWaitingCount += 1;
      },
    },
  });
  assert.equal(skipWaitingCount, 0);
  handlers.message({ data: { type: 'OTHER' } });
  assert.equal(skipWaitingCount, 0);
  await handlers.message({ data: { type: 'FASTQ_ACTIVATE_UPDATE' } });
  assert.equal(skipWaitingCount, 1);
});

test('service worker tolerates optional build-asset cache misses', () => {
  assert.match(source, /Promise\.allSettled\(BUILD_ASSETS\.map/);
  assert.match(source, /await cache\.addAll\(CORE_ASSETS/);
  assert.doesNotMatch(source, /clients\.claim/);
});

test('service worker install fails when a required core asset cannot be cached', async () => {
  const handlers = {};
  let installation;
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = new URL(input, 'https://pos.test').href;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
    caches: {
      open: async () => ({
        addAll: async () => {
          throw new Error('404 core asset');
        },
      }),
    },
  });
  handlers.install({
    waitUntil: (promise) => {
      installation = promise;
    },
  });
  await assert.rejects(installation, /404 core asset/);
});

test('cold offline module requests are fulfilled from the current service-worker cache', async () => {
  const handlers = {};
  let response;
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = input.url;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
    caches: {
      match: async (request) =>
        request.url.endsWith('/sync-policy.js') ? 'cached module' : undefined,
    },
    fetch: async () => {
      throw new Error('offline');
    },
  });
  handlers.fetch({
    request: { method: 'GET', mode: 'cors', url: 'https://pos.test/sync-policy.js' },
    respondWith: (value) => {
      response = value;
    },
  });
  assert.equal(await response, 'cached module');
});

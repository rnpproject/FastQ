import { createPosStorage } from './pos-storage.mjs';
import { calculateCartTotals } from './cart-utils.mjs';
import { createSaleNumber, createUuid } from './pos-utils.mjs';
import { createRefundRecord } from './sale-policy.mjs';
import { expectedCashForShift } from './shift-utils.mjs';
import { roleEventTypes } from './sync-role-policy.mjs';
import { PRODUCT_ICONS, isProductIcon } from './product-icons.mjs';
import {
  collectPendingStockDeltas,
  collectPendingStockProductIds,
  isServerReachable,
  mergeStockBalances,
  mergeShiftEvent,
  mergeStockSnapshot,
  prepareSyncOutbox,
  restoreActiveShift,
  restoreOfflineOutletState,
  switchOutletLocalState,
} from './sync-policy.js';

const PENDING_SERVER_LOGOUT_KEY = 'fastq-pending-server-logout-v1';
const OFFLINE_SESSION_KEY = 'fastq-offline-session-v1';
const STOCK_SNAPSHOT_VERSION = 1;
const API_BASE = (
  globalThis.window?.__FASTQ_API_BASE__ ||
  globalThis.document?.querySelector('meta[name="fastq-api-base"]')?.content ||
  ''
).replace(/\/$/, '');

function isRetryableStockConflictIssue(issue) {
  const event = issue?.event;
  const message = String(issue?.message || '');
  if (event?.type === 'sale.upsert') return /stock_balances_quantity_check/i.test(message);
  return (
    event?.type === 'stock.delta' &&
    String(event.payload?.reason || '').startsWith('Penjualan ') &&
    /Delta akan membuat stok server menjadi negatif/i.test(message)
  );
}

function readOfflineSessionProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(OFFLINE_SESSION_KEY) || 'null');
    return profile?.user ? profile : null;
  } catch {
    return null;
  }
}

function saveOfflineSessionProfile(session) {
  try {
    const { id, name, role, outletId, outletName, outletCode, identifier } = session.user || {};
    localStorage.setItem(
      OFFLINE_SESSION_KEY,
      JSON.stringify({
        user: { id, name, role, outletId, outletName, outletCode, identifier },
        expiresAt: session.expiresAt,
      }),
    );
  } catch {}
}

const createEmptyState = () => ({
  products: [],
  sales: [],
  holds: [],
  cashMovements: [],
  shifts: [],
  activeShift: null,
  settings: { service: 0, role: 'Kasir' },
  audit: [],
  stockMovements: [],
  users: [],
  customers: [],
  receivablePayments: [],
  outlets: [],
  activeOutlet: '',
  transfers: [],
  attendance: [],
  discountRequests: [],
  syncOutbox: [],
  syncIssues: [],
  syncCursor: 0,
  deviceId: createUuid(),
  syncInitialized: false,
  catalogInitialized: false,
  stockSnapshotVersion: 0,
});
const getLocalDateKey = () => new Date().toLocaleDateString('en-CA');

export async function createPosRuntime({ onChange = () => {}, onToast = () => {}, ui = {} } = {}) {
  const storage = createPosStorage(() => updateSyncStatus('Penyimpanan lokal gagal', 'error'));
  const savedState = (await storage.readSavedState()) || {};
  let state = { ...createEmptyState(), ...savedState };
  if (typeof state.settings === 'string') {
    try {
      state.settings = JSON.parse(state.settings);
    } catch {
      state.settings = {};
    }
  }
  if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    state.settings = {};
  }
  state.settings.service = Number(state.settings.service) || 0;
  state.syncOutbox ||= [];
  state.syncIssues ||= [];
  function removeRedundantOutletSyncEvents(partition) {
    if (!Array.isArray(partition?.syncOutbox)) return false;
    const remaining = partition.syncOutbox.filter((event) => event?.type !== 'outlet.upsert');
    if (remaining.length === partition.syncOutbox.length) return false;
    partition.syncOutbox = remaining;
    return true;
  }
  let removedRedundantOutletEvents = removeRedundantOutletSyncEvents(state);
  if (
    state.localOutletPartitions &&
    typeof state.localOutletPartitions === 'object' &&
    !Array.isArray(state.localOutletPartitions)
  ) {
    for (const partition of Object.values(state.localOutletPartitions))
      if (removeRedundantOutletSyncEvents(partition)) removedRedundantOutletEvents = true;
  }
  state.audit ||= [];
  state.syncCursor ||= 0;
  state.deviceId ||= createUuid();
  state.products ||= [];
  state.sales ||= [];
  state.shifts ||= [];
  state.cashMovements ||= [];
  state.outlets ||= [];
  state.attendance ||= [];
  state.users ||= [];
  state.transfers ||= [];
  state.stockMovements ||= [];
  state.stockMovements = state.stockMovements
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 500);
  state.sales = state.sales.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 1000);
  state.audit = state.audit.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 1000);
  state.holds = Array.isArray(state.holds) ? state.holds.slice(0, 100) : [];
  state.holds ||= [];
  if (state.stockSnapshotVersion !== STOCK_SNAPSHOT_VERSION) {
    state.catalogInitialized = false;
    state.settings.bootstrapOffset = 0;
  }
  let cart = Array.isArray(state.settings.cartDraft)
      ? structuredClone(state.settings.cartDraft)
      : [],
    cartDiscount = state.settings.cartDiscountDraft
      ? structuredClone(state.settings.cartDiscountDraft)
      : null,
    session =
      state.settings.serverSession || state.settings.offlineSession || readOfflineSessionProfile(),
    syncing = false,
    syncAbortController = null,
    syncTimer = null,
    syncFailureCount = 0,
    lastHealthProbeAt = 0,
    salesLoading = false,
    salesHasMore = false,
    stockHistoryLoading = false,
    stockHistoryPageCursors = [null],
    stockHistoryPage = 0,
    stockHistoryNextCursor = null,
    stockHistoryHasMore = false,
    stockHistoryFilters = {},
    disposed = false,
    status = { label: 'Lokal', state: 'local' };
  if (removedRedundantOutletEvents) storage.queueEncryptedState(state);
  const getCurrentRole = () => session?.user?.role || 'Kasir';
  const getCurrentUserName = () => session?.user?.name || 'Kasir';
  const getActiveOutletId = () => state.activeOutlet || session?.user?.outletId;
  const catalogNeedsBootstrap = () => !state.catalogInitialized && state.products.length === 0;
  const offlineStatusLabel = () =>
    catalogNeedsBootstrap()
      ? 'Katalog belum tersimpan, perlu sinkronisasi online'
      : `Offline, ${state.syncOutbox.length} antrean`;
  const publishStateChange = () => {
    if (!disposed) onChange(getStateSnapshot());
  };
  function updateSyncStatus(label, kind = 'local') {
    status = { label, state: kind };
    publishStateChange();
  }
  function showToast(message) {
    onToast(String(message));
  }
  function hasPendingServerLogout() {
    try {
      return localStorage.getItem(PENDING_SERVER_LOGOUT_KEY) === '1';
    } catch {
      return false;
    }
  }
  function setPendingServerLogout(pending) {
    try {
      if (pending) localStorage.setItem(PENDING_SERVER_LOGOUT_KEY, '1');
      else localStorage.removeItem(PENDING_SERVER_LOGOUT_KEY);
    } catch {}
  }
  async function revokePendingServerLogout() {
    if (!navigator.onLine || !hasPendingServerLogout()) return;
    try {
      await sendApiRequest('/api/auth/logout', 'POST', {});
      setPendingServerLogout(false);
    } catch (error) {
      if (error.status === 401) setPendingServerLogout(false);
    }
  }
  function persistState() {
    state.settings.cartDraft = cart.map((item) => ({ ...item }));
    state.settings.cartDiscountDraft = cartDiscount ? { ...cartDiscount } : null;
    state.products.forEach((p) => {
      p.stockByOutlet ||= {};
      p.stockByOutlet[state.activeOutlet] = p.stock;
      (p.variants || []).forEach((v) => {
        v.stockByOutlet ||= {};
        v.stockByOutlet[state.activeOutlet] = v.stock;
      });
    });
    storage.queueEncryptedState(state);
    updateSyncStatus(
      !navigator.onLine
        ? offlineStatusLabel()
        : state.syncOutbox.length
          ? `${state.syncOutbox.length} event menunggu`
          : 'Tersimpan lokal',
      !navigator.onLine ? 'offline' : state.syncOutbox.length ? 'pending' : 'local',
    );
  }
  async function flushPendingWrites() {
    await storage.flushEncryptedWrites();
  }
  function enqueueSyncEvent(type, payload, scope = state.activeOutlet) {
    const event = {
      id: createUuid(),
      type,
      outletId: scope,
      payload: structuredClone(payload),
      at: new Date().toISOString(),
    };
    state.syncOutbox.push(event);
    return event;
  }
  function recordAuditEntry(action, detail = '') {
    const entry = {
      id: createUuid(),
      at: new Date().toISOString(),
      role: getCurrentRole(),
      action,
      detail,
    };
    state.audit.push(entry);
    enqueueSyncEvent('audit.append', entry);
    return entry;
  }
  function sendApiRequest(path, method = 'GET', body, requestSignal = null) {
    const timeoutMs = path === '/api/sync' ? 60000 : path === '/api/auth/logout' ? 3000 : 15000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return fetch(API_BASE + path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal,
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = Object.assign(
          new Error(result.error || `Permintaan gagal (HTTP ${response.status})`),
          { status: response.status, code: result.code, conflict: result.conflict },
        );
        throw error;
      }
      return result;
    });
  }
  async function clearSession(clearData = false) {
    session = null;
    delete state.settings.serverSession;
    state.settings.activeUserId = null;
    state.settings.sessionExpiresAt = null;
    if (clearData) {
      await storage.clear();
      try {
        navigator.serviceWorker?.controller?.postMessage({
          type: 'FASTQ_CLEAR_PRODUCT_MEDIA',
        });
      } catch {}
      state = createEmptyState();
      cart = [];
      cartDiscount = null;
      salesHasMore = false;
    } else persistState();
    publishStateChange();
  }
  function getStateSnapshot() {
    return {
      ready: true,
      authenticated: !!session?.user,
      user: session?.user || null,
      profile: state.settings.profile || null,
      role: getCurrentRole(),
      currentUser: getCurrentUserName(),
      outletId: state.activeOutlet,
      outlet:
        state.outlets.find((x) => x.id === state.activeOutlet)?.name ||
        session?.user?.outletName ||
        'Toko',
      outlets: state.outlets,
      products: state.products.map((p) => ({ ...p, fav: !!p.favorite })),
      cart: cart.map((x) => ({
        ...x,
        itemDiscount:
          x.discount?.kind === 'amount'
            ? x.discount.value
            : x.discount?.kind === 'percent'
              ? Math.round((x.price * x.qty * x.discount.value) / 100)
              : 0,
      })),
      cartDiscount,
      globalDiscount: cartDiscount?.kind === 'amount' ? cartDiscount.value : 0,
      sales: state.sales,
      salesHasMore,
      stockMovements: state.stockMovements,
      stockHistoryHasMore,
      shifts: state.shifts,
      activeShift: state.activeShift,
      cash: state.cashMovements,
      attendance: state.attendance,
      transfers: state.transfers,
      users: state.users,
      audit: state.audit,
      holds: state.holds,
      syncOutbox: state.syncOutbox,
      syncIssues: state.syncIssues,
      lastSyncAt: state.settings.lastSyncAt || null,
      status,
    };
  }
  function mergeSyncEvent(event) {
    const d = event.payload || {};
    switch (event.event_type) {
      case 'audit.append':
        if (!state.audit.some((x) => x.id === d.id)) state.audit.push(d);
        break;
      case 'outlet.upsert':
        {
          const old = state.outlets.find((x) => x.id === d.id);
          if (old) Object.assign(old, d);
          else state.outlets.push(d);
        }
        break;
      case 'product.upsert': {
        const old = state.products.find((x) => x.id === d.id);
        if (old) {
          const stock = old.stock,
            byOutlet = old.stockByOutlet;
          Object.assign(old, d);
          old.stock = stock;
          old.stockByOutlet = byOutlet;
          old.icon = d.icon ?? old.icon ?? 'cube';
          if (Object.prototype.hasOwnProperty.call(d, 'imageId')) old.imageId = d.imageId || null;
        } else state.products.push(d);
        break;
      }
      case 'product.bulkUpsert':
        for (const product of d.products || []) {
          const old = state.products.find((item) => item.id === product.id);
          const { stockDelta: _stockDelta, ...savedProduct } = product;
          if (old) {
            const stock = old.stock;
            Object.assign(old, savedProduct);
            old.stock = stock;
            old.icon = savedProduct.icon ?? old.icon ?? 'cube';
            if (Object.prototype.hasOwnProperty.call(savedProduct, 'imageId'))
              old.imageId = savedProduct.imageId || null;
          } else state.products.push(savedProduct);
        }
        break;
      case 'product.favorite': {
        const p = state.products.find((x) => x.id === d.productId);
        if (p) p.favorite = !!d.favorite;
        break;
      }
      case 'product.delete':
        state.products = state.products.filter(
          (x) => x.id !== d.id && !(d.sku && x.sku && x.sku === d.sku),
        );
        break;
      case 'stock.delta':
      case 'stock.reconcile': {
        const p = state.products.find((x) => x.id === d.productId),
          v = p?.variants?.find((x) => x.id === d.variantId);
        if (!p) break;
        const item = v || p;
        item.stockByOutlet ||= {};
        const before = Number(item.stockByOutlet[d.outletId] ?? item.stock) || 0;
        item.stockByOutlet[d.outletId] =
          event.event_type === 'stock.reconcile' ? Number(d.quantity) : before + Number(d.delta);
        if (d.outletId === state.activeOutlet) item.stock = item.stockByOutlet[d.outletId];
        if (v) p.stock = (p.variants || []).reduce((n, x) => n + Number(x.stock) || 0, 0);
        break;
      }
      case 'sale.upsert': {
        const old = state.sales.find((x) => x.id === d.id);
        if (old) Object.assign(old, d);
        else state.sales.push(d);
        break;
      }
      case 'shift.upsert':
        mergeShiftEvent(state, d);
        break;
      case 'cash.upsert':
      case 'cash.approval': {
        const old = state.cashMovements.find((x) => x.id === d.id);
        if (old) Object.assign(old, d);
        else state.cashMovements.push(d);
        break;
      }
      case 'transfer.upsert':
        {
          const old = state.transfers.find((x) => x.id === d.id);
          if (old) Object.assign(old, d);
          else state.transfers.push(d);
        }
        break;
      case 'attendance.upsert': {
        const old =
          state.attendance.find((x) => x.id === d.id) ||
          state.attendance.find((x) => x.userId === d.userId && x.workDate === d.workDate);
        if (old) Object.assign(old, d);
        else state.attendance.push(d);
        break;
      }
      case 'receivable.payment':
        state.receivablePayments ||= [];
        {
          const old = state.receivablePayments.find((x) => x.id === d.id);
          if (old) Object.assign(old, d);
          else state.receivablePayments.push(d);
        }
        break;
      case 'discount.request':
      case 'discount.approval':
      case 'discount.cancel': {
        state.discountRequests ||= [];
        const old = state.discountRequests.find((x) => x.id === d.id);
        if (old) Object.assign(old, d);
        else state.discountRequests.push(d);
        break;
      }
    }
  }
  async function synchronizeState(manual = false) {
    if (syncing) {
      if (!manual) return;
      while (syncing) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!session?.user) {
      return;
    }
    if (!navigator.onLine) {
      updateSyncStatus(offlineStatusLabel(), 'offline');
      return;
    }
    syncing = true;
    const currentSyncController = new AbortController();
    syncAbortController = currentSyncController;
    updateSyncStatus('Menyinkronkan…', 'syncing');
    try {
      if (Date.now() - lastHealthProbeAt > 10_000) {
        const health = await fetch(API_BASE + '/api/health/live', {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(2500),
        });
        if (!health.ok)
          throw Object.assign(new Error('Server belum dapat dijangkau.'), { status: 503 });
        lastHealthProbeAt = Date.now();
      }
      const outlet = getActiveOutletId();
      if (session.user.outletId !== outlet) {
        const result = await sendApiRequest('/api/auth/outlet', 'POST', { outletId: outlet });
        session = {
          ...session,
          user: { ...session.user, ...result.user },
          expiresAt: result.expiresAt || session.expiresAt,
        };
        state.settings.serverSession = session;
        state.settings.offlineSession = { user: session.user, expiresAt: session.expiresAt };
        saveOfflineSessionProfile(session);
      }
      if (manual) {
        const retryableIssues = state.syncIssues.filter(isRetryableStockConflictIssue);
        if (retryableIssues.length) {
          for (const issue of retryableIssues) {
            if (!state.syncOutbox.some((event) => event.id === issue.eventId) && issue.event)
              state.syncOutbox.push(issue.event);
          }
          const retriedIds = new Set(retryableIssues.map((issue) => issue.eventId));
          state.syncIssues = state.syncIssues.filter((issue) => !retriedIds.has(issue.eventId));
          persistState();
          await flushPendingWrites();
          publishStateChange();
        }
      }
      const prepared = prepareSyncOutbox({
        events: state.syncOutbox,
        sales: state.sales,
        issues: state.syncIssues,
        outletId: outlet,
        role: getCurrentRole(),
      });
      state.syncIssues = prepared.issues;
      const batch = [];
      let batchBytes = 0;
      for (const event of prepared.pending) {
        const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (bytes > 512 * 1024) {
          state.syncIssues.push({
            eventId: event.id,
            code: 'SYNC_EVENT_TOO_LARGE',
            message: 'Event melebihi batas ukuran sinkronisasi 512 KB.',
            retryable: false,
            event: structuredClone(event),
          });
          state.syncOutbox = state.syncOutbox.filter((item) => item.id !== event.id);
          continue;
        }
        if (batch.length >= 100 || (batch.length && batchBytes + bytes > 512 * 1024)) break;
        batch.push(event);
        batchBytes += bytes;
      }
      if (batch.length)
        updateSyncStatus(
          `Mengunggah perubahan ${batch.length} dari ${prepared.pending.length}`,
          'syncing',
        );
      if (getCurrentRole() === 'Admin' && !state.syncInitialized) {
        state.syncInitialized = true;
        const pending = state.syncOutbox.slice(),
          deltas = collectPendingStockDeltas(pending);
        for (const original of state.products) {
          const p = structuredClone(original);
          p.stockByOutlet = { ...(p.stockByOutlet || {}) };
          for (const id of Object.keys(p.stockByOutlet)) {
            const adjust = Number(deltas.get(`${id}|${p.id}|`) || 0);
            p.stockByOutlet[id] = Number(p.stockByOutlet[id] || 0) - adjust;
          }
          for (const v of p.variants || []) {
            v.stockByOutlet = { ...(v.stockByOutlet || {}) };
            for (const id of Object.keys(v.stockByOutlet))
              v.stockByOutlet[id] =
                Number(v.stockByOutlet[id] || 0) - Number(deltas.get(`${id}|${p.id}|${v.id}`) || 0);
          }
          p.stock = Number(p.stockByOutlet[outlet] ?? p.stock ?? 0);
          enqueueSyncEvent('product.upsert', p, p.createdOutletId || outlet);
        }
        for (const shift of state.shifts)
          enqueueSyncEvent('shift.upsert', shift, shift.outletId || outlet);
        for (const movement of state.cashMovements)
          enqueueSyncEvent('cash.upsert', movement, movement.outletId || outlet);
        for (const transfer of state.transfers)
          enqueueSyncEvent('transfer.upsert', transfer, transfer.from);
        for (const sale of state.sales)
          enqueueSyncEvent('sale.upsert', sale, sale.outletId || outlet);
        persistState();
      }
      await flushPendingWrites();
      const result = await sendApiRequest(
        '/api/sync',
        'POST',
        {
          deviceId: state.deviceId,
          cursor: state.syncCursor,
          activeShiftId: state.activeShift?.id || null,
          bootstrap: !state.catalogInitialized,
          bootstrapOffset: state.settings.bootstrapOffset || 0,
          events: batch,
        },
        currentSyncController.signal,
      );
      const accepted = new Set(result.accepted || []);
      for (const rejected of result.rejected || []) {
        const event = state.syncOutbox.find((item) => item.id === rejected.id);
        if (
          event &&
          !rejected.retryable &&
          !state.syncIssues.some((issue) => issue.eventId === rejected.id)
        )
          state.syncIssues.push({
            eventId: rejected.id,
            code: rejected.code,
            message: rejected.message,
            retryable: !!rejected.retryable,
            event: structuredClone(event),
          });
      }
      const rejectedIds = new Set(
        (result.rejected || []).filter((item) => !item.retryable).map((item) => item.id),
      );
      const acceptedTransfers = state.syncOutbox
        .filter((event) => accepted.has(event.id) && event.type === 'transfer.upsert')
        .map((event) => event.payload);
      state.syncOutbox = state.syncOutbox.filter((event) => {
        if (accepted.has(event.id) || rejectedIds.has(event.id)) return false;
        if (event.type !== 'stock.delta') return true;
        const delta = event.payload || {};
        return !acceptedTransfers.some(
          (transfer) =>
            delta.productId === transfer.productId &&
            (delta.variantId || null) === (transfer.variantId || null) &&
            ((delta.outletId === transfer.from &&
              Number(delta.delta) === -Number(transfer.quantity) &&
              delta.reason === `Transfer ke ${transfer.to}`) ||
              (delta.outletId === transfer.to &&
                Number(delta.delta) === Number(transfer.quantity) &&
                delta.reason === `Transfer dari ${transfer.from}`)),
        );
      });
      state.syncIssues = state.syncIssues.filter((e) => !accepted.has(e.eventId));
      for (const event of result.events || []) mergeSyncEvent(event);
      for (const attendance of result.attendance || []) {
        mergeSyncEvent({ event_type: 'attendance.upsert', payload: attendance });
      }
      for (const product of result.bootstrapProducts || [])
        mergeSyncEvent({ event_type: 'product.upsert', payload: product });
      for (const conflict of result.stockConflicts || []) {
        const sale = state.sales.find((item) => item.id === conflict.saleId);
        if (sale) sale.stockConflict = true;
        if (Array.isArray(conflict.stockBalances))
          mergeStockBalances(state, outlet, conflict.stockBalances, state.syncOutbox);
      }
      for (const outlet of result.outlets || []) {
        const existing = state.outlets.find((item) => item.id === outlet.id);
        if (existing) Object.assign(existing, outlet);
        else state.outlets.push(outlet);
      }
      if (result.catalogBootstrapped && Array.isArray(result.stockBalances))
        mergeStockSnapshot(state, outlet, result.stockBalances, state.syncOutbox);
      else if (Array.isArray(result.stockBalances) && result.stockBalances.length) {
        const pendingProductIds = collectPendingStockProductIds(state.syncOutbox);
        const authoritativeBalances = result.stockBalances.filter(
          (balance) => !pendingProductIds.has(balance.productId),
        );
        if (authoritativeBalances.length) mergeStockBalances(state, outlet, authoritativeBalances);
      }
      for (const transfer of result.transfers || []) {
        const existing = state.transfers.find((item) => item.id === transfer.id);
        if (existing) Object.assign(existing, transfer);
        else state.transfers.push(transfer);
      }
      if (result.activeShift)
        mergeSyncEvent({ event_type: 'shift.upsert', payload: result.activeShift });
      if (result.knownShift)
        mergeSyncEvent({ event_type: 'shift.upsert', payload: result.knownShift });
      state.syncCursor = result.cursor ?? state.syncCursor;
      state.settings.lastSyncAt = new Date().toISOString();
      if (result.catalogBootstrapped) {
        if (result.bootstrapTruncated) {
          state.settings.bootstrapOffset =
            (state.settings.bootstrapOffset || 0) + (result.bootstrapProducts || []).length;
          state.catalogInitialized = false;
        } else {
          state.settings.bootstrapOffset = 0;
          state.catalogInitialized = true;
          state.stockSnapshotVersion = STOCK_SNAPSHOT_VERSION;
        }
      }
      persistState();
      await flushPendingWrites();
      if (!state.catalogInitialized)
        throw Object.assign(new Error('Server belum mengonfirmasi bootstrap katalog.'), {
          code: 'CATALOG_BOOTSTRAP_UNCONFIRMED',
        });
      updateSyncStatus(
        state.syncOutbox.length ? `${state.syncOutbox.length} event menunggu` : 'Tersinkron',
        state.syncOutbox.length ? 'pending' : 'synced',
      );
      publishStateChange();
      const retryableRejected = (result.rejected || []).some((item) => item.retryable);
      if (retryableRejected) syncFailureCount += 1;
      else syncFailureCount = 0;
      const remaining = prepareSyncOutbox({
        events: state.syncOutbox,
        sales: state.sales,
        issues: state.syncIssues,
        outletId: outlet,
        role: getCurrentRole(),
      });
      if (result.hasMore || result.bootstrapTruncated || remaining.pending.length) {
        clearTimeout(syncTimer);
        const delay = retryableRejected
          ? Math.min(60_000, 2_000 * 2 ** Math.min(syncFailureCount - 1, 5))
          : 700;
        syncTimer = setTimeout(() => {
          syncTimer = null;
          void synchronizeState();
        }, delay);
      }
    } catch (error) {
      if (error.code === 'LOCAL_STORAGE_WRITE_FAILED') {
        updateSyncStatus('Penyimpanan lokal gagal', 'error');
      } else if (error.code === 'CATALOG_BOOTSTRAP_UNCONFIRMED') {
        updateSyncStatus('Server belum mengirim konfirmasi katalog', 'error');
      } else if (error.status === 401 && session) {
        if (manual) {
          await clearSession(false);
        } else {
          updateSyncStatus('Sesi server berakhir, data lokal tetap tersedia', 'offline');
        }
      } else {
        if (['SYNC_RESYNC_REQUIRED', 'SYNC_CURSOR_ROLLBACK'].includes(error.code)) {
          state.catalogInitialized = false;
          state.syncCursor = 0;
          state.settings.bootstrapOffset = 0;
          persistState();
          updateSyncStatus('Menyegarkan katalog dari server, antrean tetap aman', 'pending');
          if (!syncTimer)
            syncTimer = setTimeout(() => {
              syncTimer = null;
              void synchronizeState();
            }, 1500);
          return;
        }
        const serverUnavailable =
          !navigator.onLine || !Number.isInteger(error.status) || error.status >= 500;
        updateSyncStatus(
          catalogNeedsBootstrap()
            ? 'Katalog belum tersimpan, server perlu dijangkau'
            : serverUnavailable
              ? 'Server tidak terjangkau, data lokal'
              : 'Sinkronisasi gagal',
          serverUnavailable ? 'offline' : 'error',
        );
        if (serverUnavailable) {
          syncFailureCount += 1;
          const base = Math.min(60_000, 2_000 * 2 ** Math.min(syncFailureCount - 1, 5));
          clearTimeout(syncTimer);
          syncTimer = setTimeout(
            () => {
              syncTimer = null;
              void synchronizeState();
            },
            Math.round(base * (0.8 + Math.random() * 0.4)),
          );
        }
      }
    } finally {
      if (syncAbortController === currentSyncController) syncAbortController = null;
      syncing = false;
    }
  }
  async function login(identifier, password, totp = '') {
    const result = await sendApiRequest('/api/auth/login', 'POST', { identifier, password, totp });
    if (result.requiresTotp) return result;
    setPendingServerLogout(false);
    switchOutletLocalState(state, result.user.outletId);
    saveOfflineSessionProfile(result);
    session = result;
    if (state.settings.profile?.id !== result.user.id) delete state.settings.profile;
    state.settings.serverSession = result;
    state.settings.offlineSession = { user: result.user, expiresAt: result.expiresAt };
    state.activeOutlet = result.user.outletId;
    state.outlets ||= [];
    if (!state.outlets.some((item) => item.id === result.user.outletId))
      state.outlets.push({
        id: result.user.outletId,
        name: result.user.outletName,
        code: result.user.outletCode,
      });
    state.settings.activeUserId = result.user.id;
    state.settings.sessionExpiresAt = result.expiresAt;
    if (!state.users.some((user) => user.id === result.user.id))
      state.users.push({ ...result.user, twoFa: '?' });
    restoreActiveShift(state, state.activeOutlet);
    persistState();
    await flushPendingWrites();
    publishStateChange();
    await synchronizeState();
    await loadSalesHistory(true);
    return result;
  }
  async function compressSquareImage(file, label) {
    if (
      !file ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      !Number.isFinite(file.size) ||
      file.size <= 0 ||
      file.size > 8 * 1024 * 1024
    )
      throw new Error(`Pilih gambar ${label} JPEG, PNG, atau WebP dengan ukuran maksimal 8 MB.`);

    const sourceBitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = 192 / Math.max(sourceBitmap.width, sourceBitmap.height);
    const width = Math.max(1, Math.round(sourceBitmap.width * scale));
    const height = Math.max(1, Math.round(sourceBitmap.height * scale));
    let bitmap;
    try {
      bitmap = await createImageBitmap(sourceBitmap, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });
    } finally {
      sourceBitmap.close();
    }
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new Error('Peramban tidak dapat menyiapkan gambar.');
    }
    const cropSize = Math.min(bitmap.width, bitmap.height);
    const cropX = Math.floor((bitmap.width - cropSize) / 2);
    const cropY = Math.floor((bitmap.height - cropSize) / 2);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    try {
      context.drawImage(
        bitmap,
        cropX,
        cropY,
        cropSize,
        cropSize,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } finally {
      bitmap.close();
    }

    const encode = (type, quality) =>
      new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Gambar gagal dikompres.'))),
          type,
          quality,
        );
      });
    let compressed;
    for (const quality of [0.72, 0.6, 0.5]) {
      compressed = await encode('image/webp', quality);
      if (compressed.type === 'image/webp' && compressed.size <= 20 * 1024) break;
    }
    if (compressed.type !== 'image/webp' || compressed.size > 20 * 1024) {
      for (const quality of [0.72, 0.6, 0.5]) {
        compressed = await encode('image/jpeg', quality);
        if (compressed.type === 'image/jpeg' && compressed.size <= 20 * 1024) break;
      }
    }
    if (!['image/webp', 'image/jpeg'].includes(compressed.type) || compressed.size > 20 * 1024)
      throw new Error(`Gambar ${label} belum dapat dikompres hingga maksimal 20 KB.`);
    return compressed;
  }
  async function blobToDataUri(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `data:${blob.type};base64,${btoa(binary)}`;
  }
  async function uploadProductImage(file) {
    if (!roleEventTypes[getCurrentRole()]?.has('product.upsert'))
      throw new Error('Peran akun ini tidak dapat mengunggah gambar produk.');
    const compressed = await compressSquareImage(file, 'produk');

    const response = await fetch(API_BASE + '/api/product-images', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': compressed.type },
      body: compressed,
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Gambar produk gagal diunggah.');
    return result;
  }
  async function loadProfile() {
    const result = await sendApiRequest('/api/auth/profile');
    state.settings.profile = result.profile;
    if (session?.user) {
      session.user = {
        ...session.user,
        name: result.profile.name,
        identifier: result.profile.identifier,
        role: result.profile.role,
        outletName: result.profile.outletName,
      };
    }
    persistState();
    publishStateChange();
    return result.profile;
  }
  async function saveProfile(input) {
    const currentProfile = state.settings.profile || (await loadProfile());
    const photo = input.photoFile
      ? await blobToDataUri(await compressSquareImage(input.photoFile, 'profil'))
      : input.removePhoto
        ? null
        : currentProfile.photo;
    const result = await sendApiRequest('/api/auth/profile', 'PUT', {
      name: input.name,
      identifier: input.identifier,
      photo,
    });
    state.settings.profile = result.profile;
    if (session?.user) {
      session.user = {
        ...session.user,
        name: result.profile.name,
        identifier: result.profile.identifier,
      };
      state.settings.offlineSession = {
        user: session.user,
        expiresAt: session.expiresAt,
      };
    }
    state.users = state.users.map((user) =>
      user.id === result.profile.id ? { ...user, name: result.profile.name } : user,
    );
    if (session?.user) saveOfflineSessionProfile(session);
    persistState();
    await flushPendingWrites();
    publishStateChange();
    showToast('Profil berhasil diperbarui.');
    return result.profile;
  }
  async function registerAccount(input) {
    if (state.products.length || state.sales.length)
      throw new Error('Gunakan profil perangkat baru untuk mendaftarkan toko.');
    if (input.password !== input.confirm) throw new Error('Konfirmasi password tidak sama.');
    if (String(input.password || '').length < 10) throw new Error('Password minimal 10 karakter.');
    const result = await sendApiRequest('/api/auth/register', 'POST', {
      storeName: input.storeName,
      name: input.name,
      identifier: input.identifier,
      password: input.password,
    });
    state.activeOutlet = result.user.outletId;
    state.outlets = [
      { id: result.user.outletId, name: result.user.outletName, code: result.user.outletCode },
    ];
    persistState();
    return result;
  }
  async function initialize() {
    const pendingLogout = hasPendingServerLogout();
    if (pendingLogout) {
      session = null;
      updateSyncStatus('Logout lokal, menunggu koneksi', 'offline');
      if (navigator.onLine) void revokePendingServerLogout();
    }
    const cachedSession = session?.user ? session : null;
    if (!pendingLogout && cachedSession) {
      restoreOfflineOutletState(state, cachedSession);
      restoreActiveShift(state, cachedSession.user.outletId);
      persistState();
    }
    if (!pendingLogout && navigator.onLine && cachedSession) {
      session = cachedSession;
      status = { label: 'Membuka data lokal', state: 'validating' };
      publishStateChange();
      try {
        const result = await sendApiRequest('/api/auth/session');
        session = {
          ...cachedSession,
          ...result,
          user: { ...(cachedSession?.user || {}), ...result.user },
        };
        state.settings.serverSession = session;
        state.settings.offlineSession = { user: session.user, expiresAt: session.expiresAt };
        saveOfflineSessionProfile(session);
        switchOutletLocalState(state, session.user.outletId);
        state.activeOutlet = session.user.outletId;
        restoreActiveShift(state, state.activeOutlet);
        state.settings.activeUserId = session.user.id;
        state.settings.sessionExpiresAt = session.expiresAt;
        if (!state.users.some((user) => user.id === session.user.id))
          state.users.push({ ...session.user, twoFa: '?' });
        persistState();
      } catch (error) {
        if (error.status === 401 && cachedSession) {
          session = cachedSession;
          updateSyncStatus('Sesi server perlu diperbarui, data lokal', 'offline');
        } else if (error.status === 401) {
          session = null;
          delete state.settings.serverSession;
          state.settings.activeUserId = null;
          state.settings.sessionExpiresAt = null;
        } else if (cachedSession) {
          session = cachedSession;
          updateSyncStatus(
            catalogNeedsBootstrap()
              ? 'Katalog belum tersimpan, server perlu dijangkau'
              : 'Server tidak terjangkau, data lokal',
            'offline',
          );
        } else {
          session = null;
          updateSyncStatus('Offline, login diperlukan', 'offline');
        }
      }
    } else if (!pendingLogout && cachedSession) {
      session = cachedSession;
      updateSyncStatus(offlineStatusLabel(), 'offline');
    } else if (!pendingLogout) session = null;
    if (!session && !pendingLogout)
      updateSyncStatus(
        navigator.onLine ? 'Login diperlukan' : 'Offline, login diperlukan',
        navigator.onLine ? 'local' : 'offline',
      );
    publishStateChange();
    if (session) {
      void synchronizeState();
      void loadSalesHistory(true);
    }
    window.addEventListener('online', () => {
      if (hasPendingServerLogout()) void revokePendingServerLogout();
      else {
        void synchronizeState();
        void refreshAccounts();
      }
    });
    window.addEventListener('offline', () => updateSyncStatus(offlineStatusLabel(), 'offline'));
    return getStateSnapshot();
  }
  async function logout(force = false) {
    if (!session) return;
    const pendingCount = () => {
      const partitions = Object.values(state.localOutletPartitions || {});
      return [state, ...partitions].reduce(
        (count, partition) =>
          count + (partition.syncOutbox?.length || 0) + (partition.syncIssues?.length || 0),
        0,
      );
    };
    const pending = pendingCount();
    if (pending && navigator.onLine) await synchronizeState(true);
    if (pendingCount() && !force)
      throw new Error(
        `Ada ${pendingCount()} event antrean/masalah sinkronisasi di seluruh outlet. Ekspor cadangan atau konfirmasi penghapusan sebelum keluar.`,
      );
    clearTimeout(syncTimer);
    syncTimer = null;
    if (syncing) {
      syncAbortController?.abort();
      while (syncing) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (state.syncOutbox.length || state.syncIssues.length)
      throw new Error(
        'Data lokal memiliki event yang belum tersinkron. Selesaikan atau ekspor masalah sinkronisasi sebelum keluar.',
      );
    delete state.settings.offlineSession;
    try {
      localStorage.removeItem(OFFLINE_SESSION_KEY);
    } catch {}
    await clearSession(false);
    setPendingServerLogout(true);
    await revokePendingServerLogout();
    updateSyncStatus('Keluar', 'local');
  }
  async function clearLocalDataAfterConfirmation(confirmed) {
    if (!confirmed) throw new Error('Penghapusan data perangkat memerlukan konfirmasi.');
    await clearSession(true);
    setPendingServerLogout(true);
    await revokePendingServerLogout();
  }
  function getLocalPendingCount() {
    return [state, ...Object.values(state.localOutletPartitions || {})].reduce(
      (count, partition) =>
        count + (partition.syncOutbox?.length || 0) + (partition.syncIssues?.length || 0),
      0,
    );
  }
  async function clearLocalDataAfterSync() {
    let pending = getLocalPendingCount();
    while (pending > 0) {
      if (!navigator.onLine)
        throw new Error(
          'Ada data belum tersinkron, tetapi perangkat sedang offline. Data tidak dihapus.',
        );
      await synchronizeState(true);
      const remaining = getLocalPendingCount();
      if (remaining >= pending)
        throw new Error(
          `Sinkronisasi belum selesai (${remaining} event atau masalah masih tertunda). Data perangkat tidak dihapus.`,
        );
      pending = remaining;
    }
    await clearLocalDataAfterConfirmation(true);
  }
  function findProductById(id) {
    return state.products.find((p) => String(p.id) === String(id) || p.sku === id || p.name === id);
  }
  function addProductToCart(id, variantId = null) {
    const p = findProductById(id);
    if (!p) return showToast('Produk tidak ditemukan.');
    if (p.variants?.length && !variantId) return { variants: p.variants };
    const v = variantId ? p.variants?.find((x) => x.id === variantId) : null;
    const available = Number(v?.stock ?? p.stock) || 0;
    if (available <= 0) return showToast('Stok produk habis.');
    const line = cart.find(
      (x) => x.productId === p.id && (x.variantId || null) === (v?.id || null),
    );
    if (line) {
      if (line.qty >= available) return showToast('Melebihi stok tersedia.');
      line.qty++;
    } else
      cart.push({
        productId: p.id,
        variantId: v?.id || null,
        name: v ? `${p.name} - ${v.name}` : p.name,
        price: Number(v?.price ?? p.price) || 0,
        qty: 1,
        discount: null,
      });
    persistState();
  }
  function updateCartQuantity(id, delta, variantId = null) {
    const line = cart.find(
      (x) => x.productId === id && (x.variantId || null) === (variantId || null),
    );
    if (!line) return;
    const p = findProductById(id),
      v = variantId ? p?.variants?.find((x) => x.id === variantId) : null;
    if (line.qty + delta <= 0) cart = cart.filter((x) => x !== line);
    else if (line.qty + delta <= Number(v?.stock ?? p?.stock ?? 0)) line.qty += delta;
    else return showToast('Stok maksimal tercapai.');
    persistState();
  }
  function getCartTotals() {
    return calculateCartTotals(cart, cartDiscount, { service: state.settings.service });
  }
  function removeProductFromCart(id, variantId = null) {
    cart = cart.filter((x) => x.productId !== id || (variantId && x.variantId !== variantId));
    persistState();
  }
  function clearCart() {
    cart = [];
    cartDiscount = null;
    persistState();
  }
  function setItemDiscount(id, value, variantId = null) {
    const line = cart.find(
      (x) => x.productId === id && (x.variantId || null) === (variantId || null),
    );
    if (!line) return showToast('Produk tidak ditemukan di keranjang.');
    value = Number(value);
    const lineTotal = Math.round(Number(line.price) * Number(line.qty));
    if (!Number.isSafeInteger(value) || value < 0 || value > lineTotal)
      return showToast('Nominal diskon harus sesuai dengan nilai produk.');
    if (value > 0 && getCurrentRole() === 'Kasir' && value > Math.round((lineTotal * 10) / 100))
      return showToast('Diskon item kasir maksimal 10% dari nilai produk.');
    line.discount = value ? { kind: 'amount', value } : null;
    persistState();
    return true;
  }
  function changeDiscount(kind, value) {
    value = Number(value);
    if (!Number.isFinite(value) || value < 0 || (kind === 'percent' && value > 100))
      return showToast('Diskon tidak valid.');
    const base = getCartTotals().subtotal - getCartTotals().itemDiscount;
    if (
      getCurrentRole() === 'Kasir' &&
      (kind === 'percent' ? value > 10 : value > Math.round(base * 0.1))
    )
      return showToast('Diskon di atas 10% memerlukan persetujuan Admin.');
    cartDiscount = value ? { kind, value } : null;
    persistState();
  }
  function holdCurrentSale(name) {
    if (!cart.length) return showToast('Keranjang masih kosong.');
    state.holds.push({
      id: createUuid(),
      name:
        name ||
        `Pesanan ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`,
      at: new Date().toISOString(),
      items: cart.map((x) => ({ ...x })),
      discount: cartDiscount,
    });
    cart = [];
    cartDiscount = null;
    recordAuditEntry('Transaksi ditahan', state.holds.at(-1).name);
    persistState();
    publishStateChange();
  }
  function resumeHeldSale(id) {
    const item = state.holds.find((x) => x.id === id);
    if (!item) return;
    state.holds = state.holds.filter((x) => x.id !== id);
    cart = item.items.map((x) => ({ ...x }));
    cartDiscount = item.discount || null;
    persistState();
    publishStateChange();
  }
  async function checkout({ method = 'Tunai', received = 0 } = {}) {
    if (!roleEventTypes[getCurrentRole()]?.has('sale.upsert'))
      throw new Error('Peran akun ini tidak dapat menyelesaikan transaksi kasir.');
    if (!cart.length) return showToast('Keranjang masih kosong.');
    if (!state.activeShift) return showToast('Buka shift sebelum menerima pembayaran.');
    const t = getCartTotals();
    received = Number(received);
    if (method === 'Tunai' && (!Number.isSafeInteger(received) || received < t.total))
      return showToast('Uang diterima belum mencukupi.');
    for (const item of cart) {
      const p = findProductById(item.productId),
        v = item.variantId ? p?.variants?.find((x) => x.id === item.variantId) : null;
      if (!p || Number(v?.stock ?? p.stock) < item.qty)
        return showToast(`Stok ${item.name} tidak mencukupi.`);
    }
    const id = createUuid(),
      at = new Date().toISOString(),
      sale = {
        id,
        number: createSaleNumber(id, at),
        at,
        cashier: getCurrentUserName(),
        shiftId: state.activeShift.id,
        outletId: state.activeOutlet,
        items: cart.map((x) => ({ ...x })),
        subtotal: t.subtotal,
        discount: t.d + t.itemDiscount,
        itemDiscount: t.itemDiscount,
        transactionDiscount: t.d,
        tax: t.tax,
        service: t.service,
        total: t.total,
        payments: [
          {
            method,
            amount: t.total,
            ...(method === 'Tunai' ? { received, change: received - t.total } : {}),
          },
        ],
        status: 'Lunas',
        outstanding: 0,
      };
    for (const item of cart) {
      const p = findProductById(item.productId),
        v = item.variantId ? p.variants.find((x) => x.id === item.variantId) : null;
      if (v) v.stock = Math.max(0, v.stock - item.qty);
      else p.stock = Math.max(0, p.stock - item.qty);
    }
    state.sales.push(sale);
    enqueueSyncEvent('sale.upsert', sale, state.activeOutlet);
    for (const item of sale.items)
      enqueueSyncEvent(
        'stock.delta',
        {
          productId: item.productId,
          variantId: item.variantId || null,
          outletId: state.activeOutlet,
          delta: -item.qty,
          reason: `Penjualan ${sale.number}`,
          saleId: sale.id,
        },
        state.activeOutlet,
      );
    recordAuditEntry('Transaksi selesai', sale.number);
    cart = [];
    cartDiscount = null;
    persistState();
    await flushPendingWrites();
    publishStateChange();
    void synchronizeState();
    return sale;
  }
  function toggleFavorite(id) {
    if (!roleEventTypes[getCurrentRole()]?.has('product.favorite'))
      return showToast('Peran akun ini tidak dapat mengubah favorit produk.');
    const p = findProductById(id);
    if (!p) return;
    p.favorite = !p.favorite;
    enqueueSyncEvent('product.favorite', { productId: p.id, favorite: p.favorite });
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function saveProduct(data, id = null) {
    if (!roleEventTypes[getCurrentRole()]?.has('product.upsert'))
      return showToast('Peran akun ini tidak dapat mengubah produk.');
    const existing = id ? findProductById(id) : null;
    const productData = {
      ...data,
      icon: data.icon ?? existing?.icon ?? 'cube',
      imageId: Object.prototype.hasOwnProperty.call(data, 'imageId')
        ? data.imageId
        : existing?.imageId || null,
    };
    if (!isProductIcon(productData.icon)) return showToast('Ikon produk tidak valid.');
    if (
      state.products.some(
        (p) => p !== existing && p.sku.toLowerCase() === productData.sku.toLowerCase(),
      )
    )
      return showToast('SKU sudah digunakan.');
    const before = Number(existing?.stock) || 0;
    if (existing) {
      Object.assign(existing, productData);
      enqueueSyncEvent('product.upsert', existing, existing.createdOutletId || state.activeOutlet);
      if (before !== Number(data.stock)) {
        state.stockMovements.unshift({
          id: createUuid(),
          productId: existing.id,
          at: new Date().toISOString(),
          before,
          after: Number(data.stock),
          delta: Number(data.stock) - before,
          reason: 'Perubahan stok dari formulir produk',
          role: getCurrentRole(),
        });
        state.stockMovements.length = Math.min(state.stockMovements.length, 500);
        enqueueSyncEvent('stock.delta', {
          productId: existing.id,
          variantId: null,
          outletId: state.activeOutlet,
          delta: Number(data.stock) - before,
          reason: 'Perubahan stok dari formulir produk',
        });
      }
    } else {
      const p = {
        id: createUuid(),
        ...productData,
        stockByOutlet: { [state.activeOutlet]: Number(productData.stock) || 0 },
        variants: [],
        favorite: false,
        createdOutletId: state.activeOutlet,
      };
      state.products.unshift(p);
      enqueueSyncEvent('product.upsert', p, state.activeOutlet);
    }
    recordAuditEntry(existing ? 'Produk diperbarui' : 'Produk ditambahkan', productData.sku);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  async function importProducts(rows, { onProgress } = {}) {
    if (!roleEventTypes[getCurrentRole()]?.has('product.upsert'))
      throw new Error('Peran akun ini tidak dapat menambahkan produk.');
    if (!Array.isArray(rows)) throw new TypeError('Daftar produk impor tidak valid.');

    const result = { added: 0, updated: 0, errors: [] };
    const bulkProducts = new Map();
    const addBulkProduct = (product) => {
      const previous = bulkProducts.get(product.id);
      if (previous)
        product.stockDelta =
          previous.stockDelta == null ? null : previous.stockDelta + product.stockDelta;
      bulkProducts.set(product.id, product);
    };
    const productsBySku = new Map(
      state.products.map((product) => [product.sku.toLowerCase(), product]),
    );
    const validQuantity = (value) =>
      Number.isFinite(value) &&
      value >= 0 &&
      value < 1e15 &&
      Math.abs(value * 1000 - Math.round(value * 1000)) <= 1e-6;
    for (const [index, row] of rows.entries()) {
      if (onProgress && index % 100 === 0) {
        onProgress({ phase: 'processing', current: index, total: rows.length });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const line = Number.isSafeInteger(row?.rowNumber) ? row.rowNumber : index + 2;
      const sku = String(row?.sku ?? '').trim();
      const name = String(row?.name ?? '').trim();
      const category = String(row?.category ?? '').trim();
      const price = row?.price === '' || row?.price == null ? Number.NaN : Number(row.price);
      const cost = row?.cost === '' || row?.cost == null ? Number.NaN : Number(row.cost);
      const stock = row?.stock === '' || row?.stock == null ? Number.NaN : Number(row.stock);
      const error =
        !sku || sku.length > 40
          ? 'SKU wajib diisi dan maksimal 40 karakter.'
          : !name || name.length > 80
            ? 'Nama produk wajib diisi dan maksimal 80 karakter.'
            : !category
              ? 'Kategori wajib diisi.'
              : category.length > 40
                ? 'Kategori maksimal 40 karakter.'
                : !Number.isSafeInteger(price) || price < 0
                  ? 'Harga jual harus bilangan bulat nol atau lebih.'
                  : !Number.isSafeInteger(cost) || cost < 0
                    ? 'Modal harus bilangan bulat nol atau lebih.'
                    : !validQuantity(stock)
                      ? 'Stok harus nol atau lebih dengan maksimal 3 angka desimal.'
                      : null;
      if (error) {
        result.errors.push({ row: line, message: error });
        continue;
      }

      const existing = productsBySku.get(sku.toLowerCase());
      if (existing && existing.name.trim().toLowerCase() === name.toLowerCase()) {
        const before = Number(existing.stock) || 0;
        Object.assign(existing, { price, cost, stock });
        existing.stockByOutlet = {
          ...(existing.stockByOutlet || {}),
          [state.activeOutlet]: stock,
        };
        const useBulk =
          !(existing.variants || []).length &&
          (!existing.createdOutletId || existing.createdOutletId === state.activeOutlet);
        const stockDelta = stock - before;
        if (useBulk) {
          addBulkProduct({
            id: existing.id,
            sku: existing.sku,
            barcode: existing.barcode || null,
            name: existing.name,
            category: existing.category,
            unit: existing.unit || 'pcs',
            price: existing.price,
            cost: existing.cost || 0,
            minStock: existing.minStock || 0,
            stock,
            stockDelta,
            favorite: !!existing.favorite,
            icon: existing.icon || 'cube',
            imageId: existing.imageId || null,
            variants: [],
          });
        } else {
          enqueueSyncEvent(
            'product.upsert',
            existing,
            existing.createdOutletId || state.activeOutlet,
          );
        }
        if (before !== stock) {
          state.stockMovements.unshift({
            id: createUuid(),
            productId: existing.id,
            at: new Date().toISOString(),
            before,
            after: stock,
            delta: stock - before,
            reason: 'Impor Excel',
            role: getCurrentRole(),
          });
          state.stockMovements.length = Math.min(state.stockMovements.length, 500);
          if (!useBulk)
            enqueueSyncEvent('stock.delta', {
              productId: existing.id,
              variantId: null,
              outletId: state.activeOutlet,
              delta: stockDelta,
              reason: 'Impor Excel',
            });
        }
        result.updated += 1;
        continue;
      }

      let productSku = sku;
      if (existing) {
        let suffix = 1;
        do {
          const marker = suffix === 1 ? '-D' : `-D${suffix}`;
          productSku = `${sku.slice(0, 40 - marker.length)}${marker}`;
          suffix += 1;
        } while (productsBySku.has(productSku.toLowerCase()));
      }
      const product = {
        id: createUuid(),
        sku: productSku,
        name,
        category,
        price,
        cost,
        stock,
        stockByOutlet: { [state.activeOutlet]: stock },
        variants: [],
        favorite: false,
        createdOutletId: state.activeOutlet,
      };
      state.products.unshift(product);
      productsBySku.set(productSku.toLowerCase(), product);
      addBulkProduct({
        id: product.id,
        sku: product.sku,
        barcode: null,
        name: product.name,
        category: product.category,
        unit: 'pcs',
        price: product.price,
        cost: product.cost,
        minStock: 0,
        stock: product.stock,
        stockDelta: null,
        favorite: false,
        icon: 'cube',
        imageId: null,
        variants: [],
      });
      result.added += 1;
    }

    if (result.added || result.updated) {
      const bulkProductList = [...bulkProducts.values()];
      const encoder = new TextEncoder();
      let chunk = [];
      let chunkBytes = encoder.encode('{"products":[]}').length;
      const enqueueBulkChunk = () => {
        if (!chunk.length) return;
        enqueueSyncEvent('product.bulkUpsert', { products: chunk }, state.activeOutlet);
        chunk = [];
        chunkBytes = encoder.encode('{"products":[]}').length;
      };
      for (const product of bulkProductList) {
        const productBytes = encoder.encode(JSON.stringify(product)).length;
        if (chunk.length && (chunk.length >= 500 || chunkBytes + productBytes + 1 > 350 * 1024))
          enqueueBulkChunk();
        if (chunkBytes + productBytes + 1 > 350 * 1024)
          throw new Error('Data satu produk melebihi batas ukuran impor sinkronisasi.');
        chunk.push(product);
        chunkBytes += productBytes + (chunk.length > 1 ? 1 : 0);
      }
      enqueueBulkChunk();
      recordAuditEntry('Impor produk', `${result.added} ditambahkan, ${result.updated} diperbarui`);
      onProgress?.({ phase: 'saving', current: rows.length, total: rows.length });
      persistState();
      await flushPendingWrites();
      onProgress?.({ phase: 'uploading', current: rows.length, total: rows.length });
      void synchronizeState();
    }
    return result;
  }
  function adjustStock(id, { kind = 'in', amount = 0, reason = '' }) {
    if (!roleEventTypes[getCurrentRole()]?.has('stock.delta') || getCurrentRole() === 'Kasir')
      return showToast('Peran akun ini tidak dapat mengubah stok.');
    const p = findProductById(id);
    if (!p) return;
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < 0 || !reason.trim())
      return showToast('Jumlah dan alasan wajib diisi.');
    const before = p.stock,
      after = kind === 'in' ? before + amount : amount;
    p.stock = after;
    const movement = {
      id: createUuid(),
      productId: id,
      at: new Date().toISOString(),
      before,
      after,
      delta: after - before,
      reason,
      role: getCurrentRole(),
    };
    state.stockMovements.unshift(movement);
    state.stockMovements.length = Math.min(state.stockMovements.length, 500);
    enqueueSyncEvent('stock.delta', {
      productId: id,
      variantId: null,
      outletId: state.activeOutlet,
      delta: after - before,
      reason,
    });
    recordAuditEntry('Stok diperbarui', `${p.sku}: ${before} → ${after}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function openCashShift(amount, shiftName = 'Shift') {
    if (!roleEventTypes[getCurrentRole()]?.has('shift.upsert'))
      return showToast('Peran akun ini tidak dapat membuka shift.');
    if (state.activeShift) return showToast('Shift sedang aktif.');
    amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount < 0)
      return showToast('Modal awal harus Rupiah bulat.');
    shiftName = String(shiftName || '').trim();
    if (!shiftName || shiftName.length > 40)
      return showToast('Nama shift wajib diisi maksimal 40 karakter.');
    const shift = {
      id: createUuid(),
      shiftName,
      openedAt: new Date().toISOString(),
      openingCash: amount,
      cashier: getCurrentUserName(),
      openedBy: getCurrentUserName(),
      openedById: session.user.id,
      cashiers: [getCurrentUserName()],
      outletId: state.activeOutlet,
    };
    mergeShiftEvent(state, shift);
    enqueueSyncEvent('shift.upsert', shift);
    recordAuditEntry('Shift dibuka', String(amount));
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function calculateExpectedCash() {
    return expectedCashForShift(state.activeShift, state.sales, state.cashMovements);
  }
  function closeCashShift(actual) {
    if (!roleEventTypes[getCurrentRole()]?.has('shift.upsert'))
      return showToast('Peran akun ini tidak dapat menutup shift.');
    const shift = state.activeShift;
    if (!shift) return;
    actual = Number(actual);
    if (!Number.isSafeInteger(actual) || actual < 0)
      return showToast('Jumlah uang fisik tidak valid.');
    const closed = {
      ...shift,
      closedAt: new Date().toISOString(),
      expectedCash: calculateExpectedCash(),
      actualCash: actual,
      physicalCash: actual,
      difference: actual - calculateExpectedCash(),
    };
    mergeShiftEvent(state, closed);
    enqueueSyncEvent('shift.upsert', closed);
    recordAuditEntry('Shift ditutup', `Selisih ${closed.difference}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function recordCashMovement(type, amount, reason) {
    if (
      !roleEventTypes[getCurrentRole()]?.has('cash.upsert') ||
      (getCurrentRole() === 'Pemilik' && type !== 'out')
    )
      return showToast('Peran akun ini tidak dapat mencatat jenis pergerakan kas tersebut.');
    amount = Number(amount);
    if (!state.activeShift) return showToast('Buka shift terlebih dahulu.');
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason.trim())
      return showToast('Jumlah dan alasan wajib diisi.');
    const movement = {
      id: createUuid(),
      at: new Date().toISOString(),
      shiftId: state.activeShift.id,
      outletId: state.activeOutlet,
      type,
      amount,
      reason,
      cashier: getCurrentUserName(),
      approvalStatus: type === 'out' && getCurrentRole() === 'Kasir' ? 'pending' : 'approved',
    };
    state.cashMovements.unshift(movement);
    enqueueSyncEvent('cash.upsert', movement);
    recordAuditEntry(type === 'in' ? 'Kas masuk' : 'Kas keluar', `${amount}, ${reason}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function decideCashApproval(index, action) {
    const movement = state.cashMovements[index];
    if (!roleEventTypes[getCurrentRole()]?.has('cash.approval') || !movement)
      return showToast('Peran akun ini tidak dapat menyetujui kas keluar.');
    movement.approvalStatus = action === 'approve' ? 'approved' : 'rejected';
    movement.approvedBy = getCurrentUserName();
    movement.approvedAt = new Date().toISOString();
    enqueueSyncEvent(
      'cash.approval',
      {
        id: movement.id,
        approvalStatus: movement.approvalStatus,
        approvedBy: movement.approvedBy,
        approvedAt: movement.approvedAt,
      },
      movement.outletId,
    );
    recordAuditEntry(
      movement.approvalStatus === 'approved' ? 'Kas keluar disetujui' : 'Kas keluar ditolak',
      movement.reason,
    );
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  async function transferStockBetweenOutlets({
    from,
    to,
    productId,
    product: productValue,
    qty,
    note = '',
  }) {
    if (!roleEventTypes[getCurrentRole()]?.has('transfer.upsert'))
      return showToast('Peran akun ini tidak dapat mentransfer stok.');
    const src = state.outlets.find((x) => x.id === from || x.name === from)?.id || from,
      dst = state.outlets.find((x) => x.id === to || x.name === to)?.id || to;
    if (!state.outlets.some((outlet) => outlet.id === src))
      return showToast('Outlet sumber tidak tersedia. Sinkronkan data outlet lalu coba lagi.');
    if (!state.outlets.some((outlet) => outlet.id === dst))
      return showToast('Outlet tujuan belum tersedia. Pastikan outlet sudah terdaftar.');
    if (src === dst) return showToast('Outlet sumber dan tujuan harus berbeda.');
    if (src !== getActiveOutletId())
      return showToast(
        'Outlet sumber harus sama dengan outlet aktif. Ganti outlet aktif ke sumber sebelum transfer.',
      );
    const serverReachable = await isServerReachable(navigator.onLine, () =>
      sendApiRequest('/api/health/live', 'GET', null, AbortSignal.timeout(2500)),
    );
    if (!serverReachable)
      return showToast(
        'Server tidak dapat dijangkau. Transfer stok belum dibuat; coba lagi online.',
      );
    if (!navigator.onLine)
      return showToast('Koneksi terputus sebelum transfer dibuat. Tidak ada perubahan.');
    const pid = String(productId || productValue || '').split(':')[0],
      variantId = String(productId || productValue || '').split(':')[1] || null,
      p = findProductById(pid),
      v = variantId ? p?.variants?.find((x) => x.id === variantId) : null;
    qty = Math.floor(Number(qty));
    if (!p || qty < 1) return showToast('Produk dan jumlah transfer tidak valid.');
    const source = v || p;
    source.stockByOutlet ||= {};
    if (source.stockByOutlet[src] == null) {
      if (src !== state.activeOutlet)
        return showToast(
          'Stok outlet sumber belum tersedia di perangkat ini. Sinkronkan data lalu coba lagi.',
        );
      source.stockByOutlet[src] = Number(source.stock) || 0;
    }
    source.stockByOutlet[dst] ??= 0;
    if (Number(source.stockByOutlet[src]) < qty)
      return showToast(`Stok outlet sumber hanya ${source.stockByOutlet[src]}.`);
    source.stockByOutlet[src] = Number(source.stockByOutlet[src]) - qty;
    source.stockByOutlet[dst] = Number(source.stockByOutlet[dst]) + qty;
    if (v) {
      if (src === state.activeOutlet) v.stock = source.stockByOutlet[src];
      const variants = p.variants || [];
      for (const outletId of [src, dst]) {
        if (variants.every((variant) => variant.stockByOutlet?.[outletId] != null)) {
          p.stockByOutlet ||= {};
          p.stockByOutlet[outletId] = variants.reduce(
            (total, variant) => total + Number(variant.stockByOutlet[outletId] || 0),
            0,
          );
        }
      }
      if (src === state.activeOutlet)
        p.stock = variants.reduce((total, variant) => total + Number(variant.stock || 0), 0);
    } else if (src === state.activeOutlet) {
      p.stock = source.stockByOutlet[src];
    }
    const entry = {
      id: createUuid(),
      at: new Date().toISOString(),
      productId: p.id,
      variantId,
      productName: p.name,
      from: src,
      to: dst,
      quantity: qty,
      note,
    };
    state.transfers.push(entry);
    enqueueSyncEvent('transfer.upsert', entry, src);
    recordAuditEntry('Transfer stok', `${p.name}: ${qty}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  async function setActiveOutlet(id, outletDetails = null) {
    const next =
      state.outlets.find((x) => x.id === id || x.name === id) ||
      (getCurrentRole() === 'Pemilik' && outletDetails?.id === id ? outletDetails : null);
    if (!next) throw new Error('Outlet tidak ditemukan.');
    if (session?.user && navigator.onLine && session.user.outletId !== next.id) {
      const result = await sendApiRequest('/api/auth/outlet', 'POST', { outletId: next.id });
      session = {
        ...session,
        user: { ...session.user, ...result.user },
        expiresAt: result.expiresAt || session.expiresAt,
      };
      state.settings.serverSession = session;
      state.settings.offlineSession = { user: session.user, expiresAt: session.expiresAt };
      saveOfflineSessionProfile(session);
    }
    if (!state.outlets.some((outlet) => outlet.id === next.id)) state.outlets.push(next);
    if (next.id !== state.activeOutlet) {
      salesHasMore = false;
      state.settings.salesCursor = null;
    }
    switchOutletLocalState(state, next.id);
    state.activeOutlet = next.id;
    restoreActiveShift(state, next.id);
    persistState();
    publishStateChange();
    void synchronizeState();
    void loadSalesHistory(true);
  }
  async function setAttendance(direction) {
    if (!session) return showToast('Login kembali untuk mencatat absensi.');
    if (!['Kasir', 'Admin'].includes(getCurrentRole()))
      return showToast('Peran akun ini tidak dapat mencatat absensi.');
    if (!navigator.geolocation) return showToast('Perangkat ini tidak mendukung lokasi.');
    const location = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            capturedAt: new Date(
              Number.isFinite(pos.timestamp) && pos.timestamp > 0 ? pos.timestamp : Date.now(),
            ).toISOString(),
          }),
        () => reject(new Error('Lokasi diperlukan untuk mencatat absensi.')),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
      ),
    );
    const userId = session.user.id,
      workDate = getLocalDateKey(),
      record = state.attendance.find(
        (x) => x.userId === userId && x.workDate === workDate && x.outletId === state.activeOutlet,
      );
    if (direction === 'in' && record) return showToast('Absensi masuk hari ini sudah tercatat.');
    if (direction === 'out' && !record) return showToast('Catat absensi masuk terlebih dahulu.');
    const at = new Date().toISOString(),
      entry = record || {
        id: createUuid(),
        userId,
        userName: getCurrentUserName(),
        role: getCurrentRole(),
        outletId: state.activeOutlet,
        workDate,
        checkIn: at,
      };
    if (direction === 'out') {
      if (record.checkOut) return showToast('Absensi pulang hari ini sudah tercatat.');
      entry.checkOut = at;
      entry.checkOutLocation = location;
    } else {
      entry.checkIn = at;
      entry.checkInLocation = location;
      state.attendance.push(entry);
    }
    enqueueSyncEvent('attendance.upsert', entry);
    recordAuditEntry(direction === 'in' ? 'Absensi masuk' : 'Absensi pulang', getCurrentUserName());
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function refundSale(saleId, form = {}) {
    if (getCurrentRole() !== 'Admin' || !roleEventTypes[getCurrentRole()]?.has('sale.upsert'))
      return showToast('Refund hanya dapat diproses oleh Admin.');
    const sale = state.sales.find((x) => x.id === saleId || x.number === saleId);
    if (!sale || !['Lunas', 'Piutang'].includes(sale.status) || sale.refunds?.length)
      return showToast('Transaksi tidak dapat direfund.');
    if (!String(form.reason || '').trim()) return ui.refund?.(saleId);
    const refundRecord = createRefundRecord({
      sale,
      ...form,
      approvedByName: getCurrentUserName(),
      id: createUuid(),
      at: new Date().toISOString(),
    });
    if (refundRecord.method === 'Tunai' && refundRecord.amount > 0 && !state.activeShift)
      throw new Error('Buka shift untuk mencatat uang refund yang keluar dari kas.');
    sale.refunds = [refundRecord];
    sale.refundedAmount = refundRecord.amount;
    sale.outstanding = 0;
    sale.status = 'Dikembalikan';
    if (form.restock)
      for (const item of sale.items) {
        const p = findProductById(item.productId),
          v = item.variantId ? p?.variants?.find((x) => x.id === item.variantId) : null;
        if (v) v.stock += item.qty;
        else if (p) p.stock += item.qty;
        enqueueSyncEvent(
          'stock.delta',
          {
            productId: item.productId,
            variantId: item.variantId || null,
            outletId: sale.outletId,
            delta: item.qty,
            reason: `Refund ${sale.number}`,
            saleId: sale.id,
          },
          sale.outletId,
        );
      }
    if (refundRecord.method === 'Tunai' && refundRecord.amount > 0) {
      const movement = {
        id: createUuid(),
        at: refundRecord.at,
        shiftId: state.activeShift.id,
        outletId: sale.outletId || state.activeOutlet,
        type: 'out',
        amount: refundRecord.amount,
        reason: `Refund ${sale.number}: ${refundRecord.reason}`,
        cashier: getCurrentUserName(),
        approvalStatus: 'approved',
      };
      state.cashMovements.unshift(movement);
      enqueueSyncEvent('cash.upsert', movement, movement.outletId);
    }
    enqueueSyncEvent('sale.upsert', sale, sale.outletId);
    recordAuditEntry('Transaksi refund', `${sale.number}: ${form.reason}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function settleSaleReceivable(saleId, { amount, method = 'Tunai', reference = '' } = {}) {
    if (
      !roleEventTypes[getCurrentRole()]?.has('receivable.payment') ||
      !roleEventTypes[getCurrentRole()]?.has('sale.upsert')
    )
      throw new Error('Peran akun ini tidak dapat menerima pembayaran piutang.');
    if (!state.activeShift) throw new Error('Buka shift untuk menerima pembayaran piutang.');
    const sale = state.sales.find((item) => item.id === saleId || item.number === saleId);
    if (!sale || sale.status !== 'Piutang' || Number(sale.outstanding) <= 0)
      throw new Error('Transaksi tidak memiliki sisa piutang.');
    amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Number(sale.outstanding))
      throw new Error('Jumlah pembayaran harus lebih dari nol dan tidak melebihi sisa piutang.');
    method = String(method || '').trim();
    if (!method || method.length > 40) throw new Error('Metode pembayaran tidak valid.');
    reference = String(reference || '').trim();
    if (reference.length > 120) throw new Error('Referensi pembayaran maksimal 120 karakter.');
    const id = createUuid(),
      at = new Date().toISOString(),
      payment = {
        id,
        method,
        status: 'Lunas',
        amount,
        reference: reference || null,
        at,
        shiftId: state.activeShift.id,
      };
    sale.payments ||= [];
    sale.payments.push(payment);
    sale.outstanding -= amount;
    if (sale.outstanding === 0) sale.status = 'Lunas';
    enqueueSyncEvent('sale.upsert', sale, sale.outletId || state.activeOutlet);
    enqueueSyncEvent(
      'receivable.payment',
      {
        id,
        saleId: sale.id,
        customerId: sale.customerId || sale.customer?.id || null,
        shiftId: payment.shiftId,
        method,
        amount,
        at,
      },
      sale.outletId || state.activeOutlet,
    );
    recordAuditEntry('Pembayaran piutang', `${sale.number}: ${amount} (${method})`);
    persistState();
    publishStateChange();
    void synchronizeState();
    return sale;
  }
  function normalizeServerSale(remote) {
    return {
      ...remote,
      items: (remote.items || []).map((item) => ({
        ...item,
        discount: item.discountAmount ? { kind: 'amount', value: item.discountAmount } : null,
      })),
      refunds: (remote.refunds || []).map((refund) => ({
        ...refund,
        approvedByName: refund.approvedBy,
      })),
    };
  }
  async function loadSalesHistory(reset = false, latestOnly = false) {
    if (salesLoading || !session || !navigator.onLine) return;
    if (reset) {
      state.settings.salesCursor = null;
      salesHasMore = false;
    }
    salesLoading = true;
    try {
      const cursor = latestOnly ? null : state.settings.salesCursor;
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) {
        params.set('before', cursor.before);
        params.set('beforeId', cursor.beforeId);
      }
      const result = await sendApiRequest(`/api/sales?${params}`);
      for (const remote of result.sales || []) {
        const normalized = normalizeServerSale(remote),
          index = state.sales.findIndex((item) => item.id === normalized.id);
        if (index < 0) state.sales.push(normalized);
        else state.sales[index] = { ...state.sales[index], ...normalized };
      }
      state.sales.sort((a, b) => new Date(b.at) - new Date(a.at));
      if (!latestOnly) state.settings.salesCursor = result.next || null;
      salesHasMore = !!result.hasMore;
      persistState();
      await flushPendingWrites();
      publishStateChange();
    } catch (error) {
      if (!session) return;
      if (error.status === 401 && navigator.onLine) return;
      updateSyncStatus(
        error.code === 'LOCAL_STORAGE_WRITE_FAILED'
          ? 'Penyimpanan lokal gagal'
          : 'Riwayat transaksi belum diperbarui, data lokal',
        error.code === 'LOCAL_STORAGE_WRITE_FAILED' ? 'error' : 'offline',
      );
    } finally {
      salesLoading = false;
    }
  }
  async function exportSalesHistory(from, to) {
    if (getCurrentRole() !== 'Admin')
      throw new Error('Ekspor riwayat transaksi hanya tersedia untuk Admin.');
    if (!session) throw new Error('Sesi login diperlukan untuk mengekspor transaksi.');
    if (!navigator.onLine)
      throw new Error('Koneksi internet diperlukan untuk mengekspor seluruh riwayat transaksi.');
    const isValidDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if (!isValidDate(from) || !isValidDate(to)) throw new Error('Tanggal ekspor tidak valid.');
    if (from > to) throw new Error('Tanggal awal tidak boleh melewati tanggal akhir.');
    const sales = [];
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
      const params = new URLSearchParams({ limit: '100', from, to });
      if (cursor) {
        params.set('before', cursor.before);
        params.set('beforeId', cursor.beforeId);
      }
      const result = await sendApiRequest(`/api/sales?${params}`);
      sales.push(...(result.sales || []));
      if (!result.hasMore) return sales;
      if (!result.next?.before || !result.next?.beforeId)
        throw new Error('Server tidak mengembalikan halaman riwayat berikutnya.');
      const nextCursor = `${result.next.before}|${result.next.beforeId}`;
      if (seenCursors.has(nextCursor))
        throw new Error('Server mengulang halaman riwayat transaksi.');
      seenCursors.add(nextCursor);
      cursor = result.next;
    }
  }
  async function exportAttendanceHistory(from, to, userId = 'all') {
    if (getCurrentRole() !== 'Admin')
      throw new Error('Ekspor riwayat kehadiran hanya tersedia untuk Admin.');
    if (!session) throw new Error('Sesi login diperlukan untuk mengekspor kehadiran.');
    if (!navigator.onLine)
      throw new Error('Koneksi internet diperlukan untuk mengekspor seluruh riwayat kehadiran.');
    const isValidDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if (!isValidDate(from) || !isValidDate(to)) throw new Error('Tanggal ekspor tidak valid.');
    if (from > to) throw new Error('Tanggal awal tidak boleh melewati tanggal akhir.');
    const attendance = [];
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
      const params = new URLSearchParams({ limit: '500', from, to });
      if (userId && userId !== 'all') params.set('userId', userId);
      if (cursor) {
        params.set('before', cursor.before);
        params.set('beforeId', cursor.beforeId);
      }
      const result = await sendApiRequest(`/api/attendance-history?${params}`);
      attendance.push(...(result.attendance || []));
      if (!result.hasMore) return attendance;
      if (!result.next?.before || !result.next?.beforeId)
        throw new Error('Server tidak mengembalikan halaman riwayat kehadiran berikutnya.');
      const nextCursor = `${result.next.before}|${result.next.beforeId}`;
      if (seenCursors.has(nextCursor))
        throw new Error('Server mengulang halaman riwayat kehadiran.');
      seenCursors.add(nextCursor);
      cursor = result.next;
    }
  }
  function refreshSalesHistory() {
    return loadSalesHistory(false, true);
  }
  async function loadStockHistory(filters = {}, reset = true, direction = 'next') {
    if (!['Pemilik', 'Admin', 'Manajer'].includes(getCurrentRole()))
      throw new Error('Peran akun ini tidak dapat melihat riwayat stok.');
    if (stockHistoryLoading) return null;
    if (reset) {
      stockHistoryFilters = { ...filters };
      stockHistoryPageCursors = [null];
      stockHistoryPage = 0;
      stockHistoryNextCursor = null;
      stockHistoryHasMore = false;
    } else if (direction === 'prev') {
      if (stockHistoryPage === 0) return null;
      stockHistoryPage -= 1;
    } else {
      if (!stockHistoryHasMore) return null;
      stockHistoryPage += 1;
    }
    stockHistoryLoading = true;
    try {
      if (navigator.onLine && session) {
        const params = new URLSearchParams({ limit: '10' });
        for (const key of ['productId', 'from', 'to', 'kind']) {
          if (stockHistoryFilters[key]) params.set(key, stockHistoryFilters[key]);
        }
        const cursor = stockHistoryPageCursors[stockHistoryPage];
        if (cursor) {
          params.set('before', cursor.before);
          params.set('beforeId', cursor.beforeId);
        }
        const result = await sendApiRequest(`/api/stock-movements?${params}`);
        stockHistoryNextCursor = result.next || null;
        if (stockHistoryNextCursor)
          stockHistoryPageCursors[stockHistoryPage + 1] = stockHistoryNextCursor;
        stockHistoryHasMore = !!result.hasMore;
        return {
          movements: result.movements || [],
          hasMore: stockHistoryHasMore,
          hasPrevious: stockHistoryPage > 0,
          page: stockHistoryPage + 1,
          offline: false,
        };
      }
      const filteredLocalMovements = state.stockMovements.filter((movement) => {
        const product = findProductById(movement.productId);
        const at = String(movement.at || '');
        if (stockHistoryFilters.productId && movement.productId !== stockHistoryFilters.productId)
          return false;
        if (stockHistoryFilters.from && at.slice(0, 10) < stockHistoryFilters.from) return false;
        if (stockHistoryFilters.to && at.slice(0, 10) > stockHistoryFilters.to) return false;
        if (stockHistoryFilters.kind && stockHistoryFilters.kind !== 'Semua') {
          const reason = movement.reason || '';
          const kind = reason.startsWith('Penjualan ')
            ? 'Penjualan'
            : reason.startsWith('Impor ')
              ? 'Impor'
              : reason.startsWith('Transfer ')
                ? 'Transfer'
                : reason.startsWith('Refund ')
                  ? 'Refund'
                  : 'Penyesuaian';
          if (kind !== stockHistoryFilters.kind) return false;
        }
        movement.productName ||= product?.name || 'Produk';
        movement.sku ||= product?.sku || '';
        movement.actor ||= 'Perangkat ini';
        return true;
      });
      const localMovements = filteredLocalMovements.slice(
        stockHistoryPage * 10,
        stockHistoryPage * 10 + 10,
      );
      stockHistoryHasMore = (stockHistoryPage + 1) * 10 < filteredLocalMovements.length;
      return {
        movements: localMovements,
        hasMore: stockHistoryHasMore,
        hasPrevious: stockHistoryPage > 0,
        page: stockHistoryPage + 1,
        offline: true,
      };
    } finally {
      stockHistoryLoading = false;
    }
  }
  async function loadSaleDetails(id) {
    let sale = state.sales.find((item) => item.id === id || item.number === id);
    if (navigator.onLine && session) {
      try {
        const result = await sendApiRequest(`/api/sales?id=${encodeURIComponent(sale?.id || id)}`);
        const remote = result.sales?.[0];
        if (remote) {
          const normalized = normalizeServerSale(remote);
          const index = state.sales.findIndex((item) => item.id === normalized.id);
          if (index < 0) state.sales.push(normalized);
          else state.sales[index] = { ...state.sales[index], ...normalized };
          sale = normalized;
          persistState();
          await flushPendingWrites();
          publishStateChange();
        }
      } catch (error) {
        if (error.status === 401) throw error;
      }
    }
    if (!sale) return null;
    const itemDiscount = sale.items.reduce(
      (sum, item) => sum + Number(item.discountAmount || 0),
      0,
    );
    return {
      ...sale,
      id: sale.number || sale.id,
      time: new Date(sale.at).toLocaleString('id-ID'),
      discount: Number(sale.discount) || 0,
      itemDiscount: Number(sale.itemDiscount) || itemDiscount,
      transactionDiscount:
        Number(sale.transactionDiscount) || Math.max(0, Number(sale.discount || 0) - itemDiscount),
    };
  }
  async function refreshAccounts() {
    if (!navigator.onLine || !['Pemilik', 'Admin'].includes(getCurrentRole())) return;
    try {
      const r = await sendApiRequest('/api/auth/users');
      state.users = (r.users || []).map((user) => ({
        ...user,
        twoFa: user.hasTotp ? 'Aktif' : '?',
        scope: user.role,
      }));
      persistState();
      await flushPendingWrites();
    } catch (error) {
      if (error.code === 'LOCAL_STORAGE_WRITE_FAILED') {
        updateSyncStatus('Penyimpanan lokal gagal', 'error');
        return;
      }
      if (Number.isInteger(error.status) && error.status < 500) showToast(error.message);
    }
  }
  async function createUser(input) {
    if (!/^[0-9]{4,8}$/.test(input.pin || '')) throw new Error('PIN harus 4–8 angka.');
    if (String(input.password || '').length < 10) throw new Error('Password minimal 10 karakter.');
    if (getCurrentRole() !== 'Pemilik') throw new Error('Hanya Pemilik yang dapat membuat akun.');
    const salt = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
        x.toString(16).padStart(2, '0'),
      ).join('');
    const derive = async (value, keySalt) => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(value),
        'PBKDF2',
        false,
        ['deriveBits'],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: new TextEncoder().encode(keySalt),
          iterations: 210000,
          hash: 'SHA-256',
        },
        key,
        256,
      );
      return Array.from(new Uint8Array(bits), (x) => x.toString(16).padStart(2, '0')).join('');
    };
    const pinSalt = salt();
    const payload = {
      id: createUuid(),
      name: input.name.trim(),
      role: input.role,
      identifier: input.identifier.trim(),
      password: input.password,
      pinSalt,
      pinHash: await derive(input.pin, pinSalt),
    };
    await sendApiRequest('/api/auth/accounts', 'POST', payload);
    await refreshAccounts();
    showToast('Akun ditambahkan ke server.');
  }
  async function deleteUser(id) {
    if (!['Pemilik', 'Admin'].includes(getCurrentRole()))
      throw new Error('Akun ini tidak memiliki izin menghapus pengguna.');
    await sendApiRequest('/api/auth/accounts', 'DELETE', { id });
    state.users = state.users.filter((user) => user.id !== id);
    publishStateChange();
    showToast('Akun dinonaktifkan di server.');
  }
  async function getUserOutletAccess() {
    if (!['Pemilik', 'Admin'].includes(getCurrentRole()))
      throw new Error('Hanya Pemilik atau Admin yang dapat mengatur akses outlet.');
    return sendApiRequest('/api/auth/store-access');
  }
  async function getOwnedOutlets() {
    if (getCurrentRole() !== 'Pemilik')
      throw new Error('Hanya Pemilik yang dapat melihat daftar outlet.');
    const result = await sendApiRequest('/api/auth/stores');
    return result.stores || [];
  }
  async function getAccessibleOutlets() {
    if (!session?.user) throw new Error('Sesi login diperlukan untuk memuat daftar outlet.');
    if (getCurrentRole() === 'Pemilik')
      throw new Error('Gunakan daftar outlet milik Owner untuk berpindah outlet.');
    const result = await sendApiRequest('/api/auth/outlets');
    if (!Array.isArray(result.outlets))
      throw new Error('Server tidak mengembalikan daftar outlet yang dapat diakses.');
    for (const outlet of result.outlets) {
      const existing = state.outlets.find((item) => item.id === outlet.id);
      if (existing) Object.assign(existing, outlet);
      else state.outlets.push(outlet);
    }
    persistState();
    return result.outlets;
  }
  async function createOutlet(name, address = '') {
    if (getCurrentRole() !== 'Pemilik') throw new Error('Hanya Pemilik yang dapat membuat outlet.');
    const normalizedName = String(name || '').trim();
    if (!normalizedName || normalizedName.length > 100)
      throw new Error('Nama outlet wajib diisi, maksimal 100 karakter.');
    const normalizedAddress = String(address || '').trim();
    if (normalizedAddress.length > 500) throw new Error('Alamat outlet maksimal 500 karakter.');
    const result = await sendApiRequest('/api/auth/stores', 'POST', {
      name: normalizedName,
      address: normalizedAddress,
    });
    showToast(`Outlet "${result.store.name}" berhasil dibuat.`);
    return result.store;
  }
  async function updateOutletDetails(storeId, name, address = '') {
    if (getCurrentRole() !== 'Pemilik')
      throw new Error('Hanya Pemilik yang dapat mengubah detail outlet.');
    const normalizedName = String(name || '').trim();
    const normalizedAddress = String(address || '').trim();
    if (!normalizedName || normalizedName.length > 100)
      throw new Error('Nama outlet wajib diisi, maksimal 100 karakter.');
    if (normalizedAddress.length > 500) throw new Error('Alamat outlet maksimal 500 karakter.');
    const result = await sendApiRequest('/api/auth/stores', 'PUT', {
      storeId,
      name: normalizedName,
      address: normalizedAddress,
    });
    const localOutlet = state.outlets.find((outlet) => outlet.id === storeId);
    if (localOutlet) {
      localOutlet.name = result.store.name;
      localOutlet.address = result.store.address;
      persistState();
      publishStateChange();
    }
    showToast(`Detail outlet "${result.store.name}" berhasil diperbarui.`);
    return result.store;
  }
  async function updateUserOutletAccess(userId, storeIds) {
    const role = getCurrentRole();
    if (!['Pemilik', 'Admin'].includes(role))
      throw new Error('Hanya Pemilik atau Admin yang dapat mengatur akses outlet.');
    const user = state.users.find((item) => item.id === userId);
    if (user?.id === session?.user?.id)
      throw new Error('Akun tidak dapat mengubah akses outlet miliknya sendiri.');
    if (user?.role === 'Pemilik') throw new Error('Akses outlet role Pemilik dikelola otomatis.');
    if (role === 'Admin' && user?.role !== 'Kasir')
      throw new Error('Admin hanya dapat mengubah akses outlet akun Kasir.');
    if (!Array.isArray(storeIds) || !storeIds.length || new Set(storeIds).size !== storeIds.length)
      throw new Error('Pilih setidaknya satu outlet yang berbeda.');
    await sendApiRequest('/api/auth/store-access', 'PUT', { userId, storeIds });
    if (user) user.storeIds = storeIds;
    publishStateChange();
    showToast('Akses outlet pengguna diperbarui.');
  }
  async function resetUserPassword(userId, input) {
    if (!['Pemilik', 'Admin'].includes(getCurrentRole()))
      throw new Error('Hanya Pemilik atau Admin yang dapat mengatur password akun.');
    if (userId === session?.user?.id)
      throw new Error('Gunakan halaman Profil untuk mengubah password akun sendiri.');
    if (String(input.newPassword || '').length < 10)
      throw new Error('Password baru minimal 10 karakter.');
    if (input.newPassword !== input.confirmPassword)
      throw new Error('Konfirmasi password baru tidak sama.');
    await sendApiRequest('/api/auth/users/password', 'POST', {
      userId,
      newPassword: input.newPassword,
      confirmPassword: input.confirmPassword,
    });
    showToast('Password akun berhasil diperbarui. Sesi pengguna tersebut telah dicabut.');
  }
  async function changePassword(input) {
    if (String(input.newPassword || '').length < 10)
      throw new Error('Password baru minimal 10 karakter.');
    if (input.newPassword !== input.confirmPassword)
      throw new Error('Konfirmasi password baru tidak sama.');
    await sendApiRequest('/api/auth/password', 'POST', {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    showToast('Password berhasil diganti.');
  }
  async function init() {
    const result = await initialize();
    if (session) void refreshAccounts();
    return result;
  }
  return {
    ready: true,
    init,
    initialize,
    login,
    registerAccount,
    logout,
    clearLocalDataAfterConfirmation,
    clearLocalDataAfterSync,
    getLocalPendingCount,
    exportSyncBackup: () =>
      JSON.stringify({ exportedAt: new Date().toISOString(), state }, null, 2),
    retrySyncIssue(eventId) {
      const issue = state.syncIssues.find((item) => item.eventId === eventId);
      if (!issue) return false;
      if (!state.syncOutbox.some((event) => event.id === issue.eventId) && issue.event)
        state.syncOutbox.push(issue.event);
      state.syncIssues = state.syncIssues.filter((item) => item.eventId !== eventId);
      persistState();
      void synchronizeState();
      return true;
    },
    discardSyncIssue(eventId, confirmed) {
      if (!confirmed) return false;
      const issue = state.syncIssues.find((item) => item.eventId === eventId);
      if (!issue) return false;
      state.syncIssues = state.syncIssues.filter((item) => item.eventId !== eventId);
      state.syncOutbox = state.syncOutbox.filter((event) => event.id !== eventId);
      persistState();
      return true;
    },
    synchronize: synchronizeState,
    getStateSnapshot,
    getProductIcons: () => PRODUCT_ICONS,
    uploadProductImage,
    loadProfile,
    saveProfile,
    getStorageDiagnostics: () => ({
      ...storage.getWriteDiagnostics(),
      catalogInitialized: !!state.catalogInitialized,
      productCount: state.products.length,
    }),
    loadSaleDetails,
    loadSalesHistory,
    exportSalesHistory,
    exportAttendanceHistory,
    refreshSalesHistory,
    loadStockHistory,
    addProductToCart,
    updateCartQuantity,
    toggleFavorite,
    setItemDiscount,
    removeProductFromCart,
    clearCart,
    getCartTotals,
    changeDiscount,
    holdCurrentSale,
    resumeHeldSale,
    checkout,
    saveProduct,
    importProducts,
    adjustStock,
    openCashShift,
    closeCashShift,
    calculateExpectedCash,
    recordCashMovement,
    decideCashApproval,
    transferStockBetweenOutlets,
    setActiveOutlet,
    setAttendance,
    refundSale,
    settleSaleReceivable,
    refreshAccounts,
    createUser,
    deleteUser,
    getUserOutletAccess,
    getOwnedOutlets,
    getAccessibleOutlets,
    createOutlet,
    updateOutletDetails,
    updateUserOutletAccess,
    resetUserPassword,
    changePassword,
    flushPendingWrites,
    get state() {
      return state;
    },
    get cart() {
      return cart;
    },
    get role() {
      return getCurrentRole();
    },
    get status() {
      return status;
    },
    pay: () => ui.checkout?.(),
    discount: () => ui.discount?.(),
    cash: (kind) => ui.cash?.(kind),
    shiftOpen: () => ui.shiftOpen?.(),
    shiftClose: () => ui.shiftClose?.(),
    users: () => ui.users?.(),
    outlet: () => ui.outlet?.(),
    outlets: () => ui.navigate?.('outlet'),
    scanner: () => ui.scanner?.(),
    holdForm: () => ui.hold?.(),
    logoutForm: () => ui.logout?.(),
    refundForm: (id) => ui.refund?.(id),
  };
}

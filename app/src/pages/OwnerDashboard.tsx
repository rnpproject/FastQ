import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import './dashboard.css';
import './dashboard-utilities.generated.css';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

const PAGE_SIZE = 5;

const DASHBOARD_LIST_LABELS = {
  categories: 'kategori',
  cashiers: 'kasir',
  payments: 'metode pembayaran',
  sales: 'transaksi',
  lowStock: 'stok menipis',
};

type DashboardListKey = keyof typeof DASHBOARD_LIST_LABELS;
type DropdownOption = { value: string; label: string };
type BreakdownRow = { label: string; value: string | number };
type DashboardSale = {
  id: string;
  sale_number: string;
  status: string;
  total_rupiah: string | number;
  occurred_at: string;
  cashier_name: string;
};
type TrendDay = { day: string; value: string | number; transactions: number };
type LowStockProduct = {
  name: string;
  sku: string;
  quantity: string | number;
  min_stock: string | number;
};
type DashboardData = {
  revenue: string | number;
  transactions: number;
  receivables: string | number;
  outlets: Array<{ id: string; name: string }>;
  lowStock: LowStockProduct[];
  byCashier: BreakdownRow[];
  byPayment: BreakdownRow[];
  byCategory: BreakdownRow[];
  trend: TrendDay[];
  sales: DashboardSale[];
};
type StoreAccessData = {
  stores: Array<{ id: string; name: string; code: string; address: string }>;
  users: Array<{ id: string; name: string; role: string; storeIds: string[] }>;
};
type SessionUser = { id: string; name: string; role: string };
type Preview = {
  subtitle: string;
  title: string;
  fields: Array<{ label: string; value: string; valueClass?: string }>;
};

const formatRupiah = (amount: string | number) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);

const formatQuantity = (quantity: string | number) =>
  new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(Number(quantity) || 0);

const formatStock = (quantity: string | number) => `${formatQuantity(quantity)} unit`;

function DashboardDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedLabel = options[selectedIndex]?.label ?? options[0]?.label ?? '';

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  function focusOption(index: number) {
    const nextIndex = (index + options.length) % options.length;
    optionRefs.current[nextIndex]?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    requestAnimationFrame(() => focusOption(selectedIndex));
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-medium text-slate-500">{label}</span>
      <div
        className="relative"
        ref={rootRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          className="w-full h-9 flex items-center justify-between gap-2 px-2.5 text-xs sm:text-sm font-medium text-slate-800 bg-white border border-slate-200 rounded-lg hover:border-[#1d4ed8]/50 focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-colors"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="truncate">{selectedLabel}</span>
          <i
            className={`ph-bold ph-caret-down text-sm text-slate-400 shrink-0 transition-transform ${
              open ? 'rotate-180 text-[#1d4ed8]' : ''
            }`}
            aria-hidden="true"
          />
        </button>

        {open && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="absolute left-0 right-0 z-20 mt-1 py-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-auto"
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs sm:text-sm transition-colors ${
                    isSelected
                      ? 'bg-[#1d4ed8]/5 font-medium text-[#1d4ed8]'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <i
                      className="ph-bold ph-check text-sm text-[#1d4ed8] shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PaginationControls({
  label,
  currentPage,
  pageCount,
  total,
  onPageChange,
}: {
  label: string;
  currentPage: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const firstItem = (currentPage - 1) * PAGE_SIZE + 1;
  const lastItem = Math.min(currentPage * PAGE_SIZE, total);

  return (
    <nav
      className="flex items-center justify-between pt-3 mt-3 border-t border-slate-200 text-xs text-slate-600"
      aria-label={`Halaman ${label}`}
    >
      <span className="tabular-nums font-medium">
        {firstItem}–{lastItem} dari {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:border-[#1d4ed8] hover:text-[#1d4ed8] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          aria-label={`Halaman sebelumnya (${currentPage - 1})`}
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          <i className="ph-bold ph-caret-left" aria-hidden="true" />
          <span>Prev</span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:border-[#1d4ed8] hover:text-[#1d4ed8] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          aria-label={`Halaman berikutnya (${currentPage + 1})`}
          disabled={currentPage === pageCount}
          onClick={() => onPageChange(currentPage + 1)}
        >
          <span>Next</span>
          <i className="ph-bold ph-caret-right" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

/**
 * Popup Modal Pratinjau untuk melihat detail penuh baris tabel/grafik
 * tanpa perlu menggeser layar (horizontal scroll) di perangkat mobile.
 */
function DetailPreviewModal({
  preview,
  onClose,
}: {
  preview: Preview | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!preview) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [preview, onClose]);

  if (!preview) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-[1px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
      onClick={onClose}
    >
      <div
        className="dashboard-preview-enter w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-xl border border-slate-200 shadow-xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header Modal */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-[#1d4ed8]">
              {preview.subtitle}
            </p>
            <h3 id="preview-modal-title" className="text-base font-semibold text-slate-900 mt-0.5">
              {preview.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup pratinjau"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <i className="ph-bold ph-x text-base" aria-hidden="true" />
          </button>
        </div>

        {/* Daftar Atribut Lengkap */}
        <dl className="px-5 py-3 divide-y divide-slate-100 text-sm">
          {preview.fields.map((field) => (
            <div key={field.label} className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500">{field.label}</dt>
              <dd
                className={`font-medium text-right tabular-nums ${field.valueClass || 'text-slate-900'}`}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Footer Modal */}
        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2 text-xs sm:text-sm font-medium text-white bg-[#1d4ed8] rounded-lg hover:bg-[#1e40af] transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OwnerDashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [login, setLogin] = useState({ identifier: '', password: '', totp: '' });
  const [requiresTotp, setRequiresTotp] = useState(false);

  const [outlet, setOutlet] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);
  const [listPages, setListPages] = useState({
    categories: 1,
    cashiers: 1,
    payments: 1,
    sales: 1,
    lowStock: 1,
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const dashboardRequestId = useRef(0);
  const [signingOut, setSigningOut] = useState(false);
  const [previewItem, setPreviewItem] = useState<Preview | null>(null);
  const [storeAccess, setStoreAccess] = useState<StoreAccessData | null>(null);
  const [storeManagementOpen, setStoreManagementOpen] = useState(false);
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreAddress, setNewStoreAddress] = useState('');
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [editStoreName, setEditStoreName] = useState('');
  const [editStoreAddress, setEditStoreAddress] = useState('');
  const [managementError, setManagementError] = useState('');
  const [managementBusy, setManagementBusy] = useState(false);

  useEffect(() => {
    setRequiresTotp(false);
    setLogin((current) => ({ ...current, totp: '' }));
  }, [login.identifier, login.password]);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' })
      .then(async (res) => {
        const body = await res.json();
        if (active) {
          setAuthenticated(res.ok);
          setSessionUser(res.ok ? body.user : null);
        }
      })
      .catch(() => {
        if (active) setAuthenticated(false);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(login),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Login gagal.');
      if (body.requiresTotp) {
        setRequiresTotp(true);
        return;
      }
      setSessionUser(body.user);
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login gagal.');
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboard(signal?: AbortSignal) {
    if (!authenticated) return;
    const requestId = ++dashboardRequestId.current;
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ days: String(days) });
      if (outlet) query.set('outletId', outlet);
      const response = await fetch(`${API_BASE}/api/dashboard?${query}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401 && requestId === dashboardRequestId.current) {
          setAuthenticated(false);
        }
        throw new Error(body.error || 'Dashboard tidak dapat dimuat.');
      }
      if (!controller.signal.aborted && requestId === dashboardRequestId.current) setData(body);
    } catch (err) {
      if (!signal?.aborted && requestId === dashboardRequestId.current) {
        setError(
          timedOut
            ? 'Permintaan terlalu lama. Periksa koneksi lalu segarkan kembali.'
            : err instanceof Error
              ? err.message
              : 'Dashboard tidak dapat dimuat.',
        );
      }
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
      if (requestId === dashboardRequestId.current) setLoading(false);
    }
  }

  async function loadStoreAccess() {
    try {
      const response = await fetch(`${API_BASE}/api/auth/store-access`, {
        credentials: 'include',
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Akses toko tidak dapat dimuat.');
      setStoreAccess(body);
      setManagementError('');
    } catch (err) {
      setManagementError(err instanceof Error ? err.message : 'Akses toko tidak dapat dimuat.');
    }
  }

  async function createStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setManagementBusy(true);
    setManagementError('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/stores`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newStoreName, address: newStoreAddress }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Toko tidak dapat dibuat.');
      setNewStoreName('');
      setNewStoreAddress('');
      await Promise.all([loadStoreAccess(), loadDashboard()]);
    } catch (err) {
      setManagementError(err instanceof Error ? err.message : 'Toko tidak dapat dibuat.');
    } finally {
      setManagementBusy(false);
    }
  }

  async function saveStoreDetails(event: FormEvent<HTMLFormElement>, storeId: string) {
    event.preventDefault();
    setManagementBusy(true);
    setManagementError('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/stores`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId,
          name: editStoreName,
          address: editStoreAddress,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Detail toko tidak dapat disimpan.');
      setStoreAccess((current) =>
        current
          ? {
              ...current,
              stores: current.stores.map((store) => (store.id === storeId ? body.store : store)),
            }
          : current,
      );
      setData((current) =>
        current
          ? {
              ...current,
              outlets: current.outlets.map((store) =>
                store.id === storeId ? { ...store, name: body.store.name } : store,
              ),
            }
          : current,
      );
      setEditingStoreId(null);
      await loadDashboard();
    } catch (err) {
      setManagementError(err instanceof Error ? err.message : 'Detail toko tidak dapat disimpan.');
    } finally {
      setManagementBusy(false);
    }
  }

  function updateSelectedStores(userId: string, storeIds: string[]) {
    setStoreAccess((current) =>
      current
        ? {
            ...current,
            users: current.users.map((user) => (user.id === userId ? { ...user, storeIds } : user)),
          }
        : current,
    );
  }

  async function saveStoreAccess(userId: string) {
    const user = storeAccess?.users.find((item) => item.id === userId);
    if (!user) return;
    setManagementBusy(true);
    setManagementError('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/store-access`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, storeIds: user.storeIds }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Akses toko tidak dapat disimpan.');
      setStoreAccess((current) =>
        current
          ? {
              ...current,
              users: current.users.map((item) =>
                item.id === userId ? { ...item, storeIds: body.storeIds } : item,
              ),
            }
          : current,
      );
    } catch (err) {
      setManagementError(err instanceof Error ? err.message : 'Akses toko tidak dapat disimpan.');
    } finally {
      setManagementBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    if (authenticated) void loadDashboard(controller.signal);
    return () => controller.abort();
  }, [authenticated, outlet, days]);

  useEffect(() => {
    if (authenticated && sessionUser?.role === 'Pemilik') void loadStoreAccess();
    else setStoreAccess(null);
  }, [authenticated, sessionUser?.role]);

  useEffect(() => {
    setListPages({ categories: 1, cashiers: 1, payments: 1, sales: 1, lowStock: 1 });
  }, [outlet, days]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Tidak dapat keluar dari akun. Coba lagi.');
      setAuthenticated(false);
      setSessionUser(null);
      setData(null);
      setStoreAccess(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tidak dapat keluar dari akun.');
    } finally {
      setSigningOut(false);
    }
  }

  if (checkingSession) {
    return (
      <main className="min-h-screen bg-white flex flex-col items-center justify-center p-6 text-slate-600">
        <p className="text-sm" role="status">
          Memeriksa sesi...
        </p>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen bg-white text-slate-900 flex flex-col">
        <header className="border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img
              className="w-8 h-8 object-contain"
              src={`${import.meta.env.BASE_URL}fastq-mark.png`}
              alt=""
            />
            <span className="font-semibold tracking-tight text-sm">FastQ</span>
            <span className="text-slate-300">/</span>
            <span className="text-sm text-slate-500">Dashboard</span>
          </div>
        </header>

        <section className="flex-1 flex items-center justify-center p-4 sm:p-6">
          <div className="w-full max-w-sm space-y-6">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                Masuk dashboard
              </h1>
              <p className="text-sm text-slate-500">Gunakan email atau nomor HP dan password.</p>
            </div>

            <form onSubmit={signIn} className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-700">Email atau nomor HP</span>
                <input
                  value={login.identifier}
                  onChange={(e) => setLogin({ ...login, identifier: e.target.value })}
                  autoComplete="username"
                  maxLength={254}
                  required
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15 transition-colors"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-700">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  maxLength={256}
                  value={login.password}
                  onChange={(e) => setLogin({ ...login, password: e.target.value })}
                  required
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15 transition-colors"
                />
              </label>

              {requiresTotp && (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-slate-700">Kode authenticator</span>
                  <input
                    autoFocus
                    required
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={login.totp}
                    onChange={(e) => setLogin({ ...login, totp: e.target.value })}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15 transition-colors"
                  />
                </label>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 text-sm font-medium text-white bg-[#1d4ed8] rounded-lg hover:bg-[#1e40af] disabled:opacity-50 transition-colors"
              >
                {loading ? 'Memeriksa...' : requiresTotp ? 'Verifikasi' : 'Masuk'}
              </button>
            </form>

            {error && (
              <p className="text-xs text-red-600" role="alert">
                {error}
              </p>
            )}

            <p className="text-xs text-slate-500">
              Belum memiliki toko?{' '}
              <a
                href="/pos"
                className="font-medium text-[#1d4ed8] underline underline-offset-4 hover:text-[#1e40af]"
              >
                Daftar dan buat toko
              </a>
            </p>
          </div>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main
        className="min-h-screen bg-white flex flex-col items-center justify-center p-6 text-center"
        aria-busy={loading}
      >
        <div className="max-w-xs w-full space-y-4">
          <img
            className="w-10 h-10 mx-auto object-contain"
            src={`${import.meta.env.BASE_URL}fastq-mark.png`}
            alt=""
          />
          <h1 className="text-base font-semibold text-slate-900">Dashboard toko</h1>
          {loading ? (
            <p className="text-sm text-slate-500" role="status">
              Memuat ringkasan transaksi...
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-red-600" role="alert">
                {error || 'Laporan belum dapat dimuat.'}
              </p>
              <button
                type="button"
                onClick={() => void loadDashboard()}
                className="px-4 py-2 text-sm font-medium text-white bg-[#1d4ed8] rounded-lg hover:bg-[#1e40af]"
              >
                Coba lagi
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  const maxTrend = Math.max(1, ...data.trend.map((point) => Number(point.value)));

  // Pada layar mobile, tampilkan 7 hari terakhir agar batang grafik tetap proporsional tanpa scroll samping
  const visibleTrend = data.trend;

  function getPage<T>(key: DashboardListKey, items: T[]) {
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const currentPage = Math.min(listPages[key], pageCount);
    const visibleItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const pagination = (
      <PaginationControls
        label={DASHBOARD_LIST_LABELS[key]}
        currentPage={currentPage}
        pageCount={pageCount}
        total={items.length}
        onPageChange={(page) => setListPages((current) => ({ ...current, [key]: page }))}
      />
    );
    return { items: visibleItems, pagination };
  }

  const renderBreakdown = (key: DashboardListKey, title: string, rows: BreakdownRow[]) => {
    const page = getPage(key, rows);
    return (
      <div className="flex flex-col justify-between p-4 sm:p-5 bg-white border border-slate-300 rounded-xl shadow-xs">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 pb-2.5 border-b border-slate-200">
            {title}
          </h3>
          {rows.length ? (
            <ul className="divide-y divide-slate-200">
              {page.items.map((row) => (
                <li
                  key={row.label}
                  className="py-2.5 flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-slate-700 truncate">{row.label}</span>
                  <span className="font-semibold text-slate-900 tabular-nums shrink-0">
                    {formatRupiah(row.value)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400 py-3">Belum ada data pada periode ini.</p>
          )}
        </div>
        {page.pagination}
      </div>
    );
  };

  const salesPage = getPage('sales', data.sales);
  const lowStockPage = getPage('lowStock', data.lowStock);

  const getStatusTextStyle = (status: string) => {
    const normalized = status.toLowerCase();
    if (normalized === 'selesai' || normalized === 'paid' || normalized === 'completed') {
      return 'text-emerald-700 font-medium';
    }
    if (normalized === 'piutang' || normalized === 'unpaid' || normalized === 'pending') {
      return 'text-amber-700 font-medium';
    }
    return 'text-rose-600 font-medium';
  };

  const openSalePreview = (sale: DashboardSale) => {
    setPreviewItem({
      subtitle: 'Detail Transaksi',
      title: sale.sale_number,
      fields: [
        {
          label: 'Waktu Transaksi',
          value: new Date(sale.occurred_at).toLocaleString('id-ID', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
        { label: 'Kasir', value: sale.cashier_name },
        {
          label: 'Status',
          value: sale.status,
          valueClass: getStatusTextStyle(sale.status),
        },
        {
          label: 'Total Pembayaran',
          value: formatRupiah(sale.total_rupiah),
          valueClass: 'text-[#1d4ed8] font-semibold',
        },
      ],
    });
  };

  const openLowStockPreview = (product: LowStockProduct) => {
    setPreviewItem({
      subtitle: 'Detail Stok Produk',
      title: product.name,
      fields: [
        { label: 'Kode SKU', value: product.sku },
        {
          label: 'Sisa Stok Saat Ini',
          value: formatStock(product.quantity),
          valueClass: 'text-rose-600 font-semibold',
        },
        { label: 'Batas Minimum', value: formatStock(product.min_stock) },
      ],
    });
  };

  const openTrendPreview = (day: TrendDay) => {
    setPreviewItem({
      subtitle: 'Ringkasan Harian',
      title: new Date(`${day.day}T00:00:00`).toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
      fields: [
        {
          label: 'Total Omzet',
          value: formatRupiah(day.value),
          valueClass: 'text-[#1d4ed8] font-semibold',
        },
        { label: 'Jumlah Transaksi', value: `${day.transactions} transaksi` },
      ],
    });
  };

  return (
    <main className="min-h-screen bg-slate-50/70 text-slate-900 antialiased overflow-x-hidden">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-300">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img
              className="w-8 h-8 shrink-0 object-contain"
              src={`${import.meta.env.BASE_URL}fastq-mark.png`}
              alt=""
            />
            <div className="flex items-baseline gap-2">
              <strong className="text-sm font-semibold tracking-tight text-slate-900">FastQ</strong>
              <span className="text-xs text-slate-500">Dashboard Toko</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 px-2.5 py-1.5 rounded-md border border-transparent hover:border-slate-300 hover:bg-slate-100 transition-colors"
          >
            <i className="ph ph-sign-out text-sm" aria-hidden="true" />
            <span>{signingOut ? 'Keluar...' : 'Keluar'}</span>
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-8 space-y-6">
        {sessionUser?.role === 'Pemilik' && (
          <section className="space-y-3">
            <h2>
              <button
                type="button"
                aria-expanded={storeManagementOpen}
                aria-controls="store-management-panel"
                onClick={() => setStoreManagementOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:bg-slate-50 sm:p-5"
              >
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-slate-900">
                    Toko dan akses pengguna
                  </span>
                  <span className="mt-1 block text-sm font-normal text-slate-600">
                    Kelola detail toko dan akses pengguna.
                  </span>
                </span>
                <i
                  className={`ph ${storeManagementOpen ? 'ph-caret-up' : 'ph-caret-down'} shrink-0 text-lg text-slate-500`}
                  aria-hidden="true"
                />
              </button>
            </h2>

            <div
              id="store-management-panel"
              hidden={!storeManagementOpen}
              className="space-y-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
            >
              <form
                onSubmit={createStore}
                className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
              >
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">Tambah toko baru</h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Nama wajib diisi; alamat opsional.
                  </p>
                </div>
                <div className="grid items-end gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(16rem,1.5fr)_auto]">
                  <label
                    className="block text-xs font-medium text-slate-600"
                    htmlFor="new-store-name"
                  >
                    Nama toko
                    <input
                      id="new-store-name"
                      value={newStoreName}
                      onChange={(event) => setNewStoreName(event.target.value)}
                      maxLength={100}
                      required
                      placeholder="Contoh: FastQ Cabang Utama"
                      className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <label
                    className="block text-xs font-medium text-slate-600"
                    htmlFor="new-store-address"
                  >
                    Alamat toko
                    <textarea
                      id="new-store-address"
                      value={newStoreAddress}
                      onChange={(event) => setNewStoreAddress(event.target.value)}
                      maxLength={500}
                      rows={1}
                      placeholder="Alamat lengkap (opsional)"
                      className="mt-1 block min-h-[42px] w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={managementBusy}
                    className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg bg-[#1d4ed8] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1e40af] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <i className="ph ph-plus" aria-hidden="true" />
                    Buat toko
                  </button>
                </div>
              </form>

              {managementError && (
                <p
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                  role="alert"
                >
                  {managementError}
                </p>
              )}

              {storeAccess ? (
                <div className="grid gap-3 xl:grid-cols-2">
                  <div className="space-y-2 rounded-xl bg-slate-50/70 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">Toko milik Anda</h3>
                      </div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600">
                        {storeAccess.stores.length}
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {storeAccess.stores.map((store) => (
                        <li
                          key={store.id}
                          className="rounded-lg border border-slate-200 bg-white p-2.5"
                        >
                          {editingStoreId === store.id ? (
                            <form
                              onSubmit={(event) => void saveStoreDetails(event, store.id)}
                              className="space-y-2.5"
                            >
                              <label className="block text-xs font-medium text-slate-600">
                                Nama toko
                                <input
                                  value={editStoreName}
                                  onChange={(event) => setEditStoreName(event.target.value)}
                                  maxLength={100}
                                  required
                                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#1d4ed8] focus:outline-none"
                                />
                              </label>
                              <label className="block text-xs font-medium text-slate-600">
                                Alamat toko
                                <textarea
                                  value={editStoreAddress}
                                  onChange={(event) => setEditStoreAddress(event.target.value)}
                                  maxLength={500}
                                  rows={2}
                                  className="mt-1 block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#1d4ed8] focus:outline-none"
                                />
                              </label>
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  disabled={managementBusy}
                                  onClick={() => setEditingStoreId(null)}
                                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                                >
                                  Batal
                                </button>
                                <button
                                  type="submit"
                                  disabled={managementBusy}
                                  className="rounded-lg bg-[#1d4ed8] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1e40af] disabled:opacity-50"
                                >
                                  Simpan detail
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-slate-800">
                                  {store.name}
                                </p>
                                <p className="mt-0.5 text-xs text-slate-500">Kode: {store.code}</p>
                                <p className="mt-1 text-xs text-slate-600">
                                  {store.address || 'Alamat belum ditambahkan'}
                                </p>
                              </div>
                              <button
                                type="button"
                                disabled={managementBusy}
                                onClick={() => {
                                  setEditingStoreId(store.id);
                                  setEditStoreName(store.name);
                                  setEditStoreAddress(store.address || '');
                                }}
                                className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Edit
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                      {!storeAccess.stores.length && (
                        <li className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500">
                          Belum ada toko.
                        </li>
                      )}
                    </ul>
                  </div>

                  <div className="space-y-2 rounded-xl bg-slate-50/70 p-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">Hak akses toko</h3>
                    </div>
                    <div className="space-y-2">
                      {storeAccess.users
                        .filter((user) => user.id !== sessionUser.id)
                        .map((user) => (
                          <div
                            key={user.id}
                            className="rounded-lg border border-slate-200 bg-white p-2.5"
                          >
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-medium text-slate-800">
                                {user.name}
                              </span>
                              <span className="shrink-0 rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                                {user.role}
                              </span>
                            </div>
                            {user.role === 'Pemilik' ? (
                              <p className="text-xs text-slate-600">
                                Pemilik mengakses semua toko yang dimilikinya.
                              </p>
                            ) : (
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                                <label className="min-w-0 flex-1 text-xs text-slate-600">
                                  Toko yang dapat diakses
                                  <select
                                    multiple
                                    size={Math.min(3, Math.max(1, storeAccess.stores.length))}
                                    value={user.storeIds}
                                    disabled={managementBusy}
                                    onChange={(event) =>
                                      updateSelectedStores(
                                        user.id,
                                        Array.from(
                                          event.currentTarget.selectedOptions,
                                          (option) => option.value,
                                        ),
                                      )
                                    }
                                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                                  >
                                    {storeAccess.stores.map((store) => (
                                      <option key={store.id} value={store.id}>
                                        {store.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <button
                                  type="button"
                                  disabled={managementBusy}
                                  onClick={() => void saveStoreAccess(user.id)}
                                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                  Simpan akses
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      {!storeAccess.users.some((user) => user.id !== sessionUser.id) && (
                        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500">
                          Belum ada pengguna lain.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                !managementError && (
                  <p className="text-sm text-slate-500" role="status">
                    Memuat pengaturan toko...
                  </p>
                )
              )}
            </div>
          </section>
        )}

        {/* Header & Unified Filter Bar */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-5 border-b border-slate-300">
          <div className="space-y-1">
            <h1 className="text-lg sm:text-2xl font-semibold tracking-tight text-slate-900">
              Ringkasan penjualan
            </h1>
            <p className="text-xs sm:text-sm text-slate-600">
              Data transaksi perangkat yang sudah tersinkron ke server.
            </p>
          </div>

          <div
            className="grid grid-cols-[1fr_1fr_auto] sm:flex sm:items-end gap-2 sm:gap-2.5 w-full lg:w-auto"
            role="group"
            aria-label="Filter laporan"
          >
            <div className="min-w-0 sm:w-44">
              <DashboardDropdown
                label="Toko"
                value={outlet}
                options={[
                  { value: '', label: 'Semua toko' },
                  ...data.outlets.map((o) => ({ value: o.id, label: o.name })),
                ]}
                onChange={setOutlet}
              />
            </div>

            <div className="min-w-0 sm:w-40">
              <DashboardDropdown
                label="Periode"
                value={String(days)}
                options={[
                  { value: '7', label: '7 hari' },
                  { value: '30', label: '30 hari' },
                  { value: '90', label: '90 hari' },
                  { value: '365', label: '12 bulan' },
                ]}
                onChange={(val) => setDays(Number(val))}
              />
            </div>

            <div className="flex flex-col justify-end">
              <button
                type="button"
                onClick={() => void loadDashboard()}
                disabled={loading}
                aria-busy={loading}
                aria-label="Segarkan data"
                title="Segarkan data"
                className="h-9 px-2.5 sm:px-3 inline-flex items-center justify-center gap-1.5 text-xs sm:text-sm font-medium text-white bg-[#1d4ed8] rounded-lg hover:bg-[#1e40af] disabled:opacity-50 transition-colors shrink-0"
              >
                <i
                  className={`ph-bold ph-arrows-clockwise text-sm ${loading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">{loading ? 'Memuat' : 'Segarkan'}</span>
              </button>
            </div>
          </div>
        </section>

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {/* Key Metrics Card */}
        <section
          aria-label="Metrik penjualan"
          className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-300 bg-white border border-slate-300 rounded-xl shadow-xs"
        >
          <div className="p-4 sm:p-5 flex items-center justify-between sm:flex-col sm:items-start gap-1">
            <span className="text-xs font-medium text-slate-600">Omzet</span>
            <strong className="text-lg sm:text-2xl font-semibold tracking-tight text-[#1d4ed8] tabular-nums">
              {formatRupiah(data.revenue)}
            </strong>
          </div>
          <div className="p-4 sm:p-5 flex items-center justify-between sm:flex-col sm:items-start gap-1">
            <span className="text-xs font-medium text-slate-600">Transaksi berhasil</span>
            <strong className="text-lg sm:text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
              {data.transactions}
            </strong>
          </div>
          <div className="p-4 sm:p-5 flex items-center justify-between sm:flex-col sm:items-start gap-1">
            <span className="text-xs font-medium text-slate-600">Piutang aktif</span>
            <strong className="text-lg sm:text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
              {formatRupiah(data.receivables)}
            </strong>
          </div>
        </section>

        {/* Daily Revenue Trend Card */}
        <section className="p-4 sm:p-5 bg-white border border-slate-300 rounded-xl shadow-xs space-y-3">
          <div className="flex items-center justify-between pb-2.5 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">Tren omzet harian</h2>
            <span className="text-[11px] text-slate-500">Ketuk batang untuk detail</span>
          </div>

          <div className="h-40 sm:h-44 w-full flex items-end gap-1 sm:gap-2 pt-3 border-b border-slate-300">
            {visibleTrend.map((day, idx) => {
              const heightPct = Math.max(6, (Number(day.value) / maxTrend) * 100);
              const showMobileLabel = idx % 3 === 0 || idx === visibleTrend.length - 1;
              return (
                <button
                  key={day.day}
                  type="button"
                  onClick={() => openTrendPreview(day)}
                  className="flex-1 h-full flex flex-col items-center justify-end group focus:outline-none"
                  title={`${day.day}: ${formatRupiah(day.value)}, ${day.transactions} transaksi`}
                >
                  <div className="w-full flex-1 flex items-end justify-center">
                    <div
                      className="w-full max-w-[26px] bg-[#1d4ed8] group-hover:bg-[#1e40af] group-focus:bg-[#1e40af] rounded-t transition-all duration-200"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                  <span
                    className={`mt-2 text-[10px] sm:text-[11px] text-slate-600 tabular-nums whitespace-nowrap ${
                      showMobileLabel ? 'opacity-100' : 'opacity-0 sm:opacity-100'
                    }`}
                  >
                    {new Date(`${day.day}T00:00:00`).toLocaleDateString('id-ID', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Breakdown Lists Grid */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">Rincian penjualan</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
            {renderBreakdown('categories', 'Kategori', data.byCategory)}
            {renderBreakdown('cashiers', 'Kasir', data.byCashier)}
            {renderBreakdown('payments', 'Metode pembayaran', data.byPayment)}
          </div>
        </section>

        {/* Recent Transactions Card */}
        <section className="p-3 sm:p-4 bg-white border border-slate-300 rounded-xl shadow-xs space-y-1">
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">Transaksi terbaru</h2>
            <span className="hidden sm:inline text-[11px] text-slate-500">
              Pilih baris untuk rincian
            </span>
          </div>

          <div className="w-full">
            <table className="w-full table-fixed text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-300 text-xs font-semibold text-slate-600">
                  <th className="w-[48%] sm:w-[24%] py-2 pr-2">Transaksi</th>
                  <th className="hidden sm:table-cell sm:w-[20%] py-2 px-2">Waktu</th>
                  <th className="hidden md:table-cell md:w-[18%] py-2 px-2">Kasir</th>
                  <th className="w-[19%] sm:w-[14%] py-2 px-1 sm:px-2">Status</th>
                  <th className="w-[33%] sm:w-[24%] py-2 pl-1 sm:pl-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {salesPage.items.map((sale) => (
                  <tr
                    key={sale.sale_number}
                    onClick={() => openSalePreview(sale)}
                    className="hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 pr-2 align-top sm:align-middle overflow-hidden">
                      <div
                        className="max-w-full truncate font-medium text-slate-900 tabular-nums text-xs sm:text-sm"
                        title={sale.sale_number}
                      >
                        {sale.sale_number}
                      </div>
                      <div className="text-[11px] text-slate-500 sm:hidden mt-0.5 truncate">
                        {new Date(sale.occurred_at).toLocaleTimeString('id-ID', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        - {sale.cashier_name}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-slate-600 whitespace-nowrap tabular-nums hidden sm:table-cell">
                      {new Date(sale.occurred_at).toLocaleString('id-ID', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td
                      className="py-2.5 px-2 text-slate-700 whitespace-nowrap truncate hidden md:table-cell"
                      title={sale.cashier_name}
                    >
                      {sale.cashier_name}
                    </td>
                    <td className="py-2.5 px-1 sm:px-2 whitespace-nowrap align-top sm:align-middle">
                      <span className={`text-[11px] sm:text-xs ${getStatusTextStyle(sale.status)}`}>
                        {sale.status}
                      </span>
                    </td>
                    <td className="py-2.5 pl-1 sm:pl-2 font-semibold text-slate-900 text-right whitespace-nowrap tabular-nums text-xs sm:text-sm align-top sm:align-middle">
                      {formatRupiah(sale.total_rupiah)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.sales.length && (
              <p className="text-sm text-slate-400 py-4">Belum ada transaksi pada periode ini.</p>
            )}
          </div>
          {salesPage.pagination}
        </section>

        {/* Low Stock Card */}
        <section className="p-3 sm:p-4 bg-white border border-slate-300 rounded-xl shadow-xs space-y-1">
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">Stok menipis</h2>
            <span className="hidden sm:inline text-[11px] text-slate-500">
              Pilih produk untuk detail
            </span>
          </div>

          <div className="w-full">
            <table className="w-full table-fixed text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-300 text-xs font-semibold text-slate-600">
                  <th className="w-[65%] sm:w-[28%] py-2 pr-2">Produk</th>
                  <th className="hidden sm:table-cell sm:w-[22%] py-2 px-2">SKU</th>
                  <th className="w-[35%] sm:w-[25%] py-2 pl-1 sm:px-2 text-right">Sisa stok</th>
                  <th className="hidden sm:table-cell sm:w-[25%] py-2 pl-2 text-right">
                    Batas minimum
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {lowStockPage.items.map((product) => (
                  <tr
                    key={product.sku}
                    onClick={() => openLowStockPreview(product)}
                    className="hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 pr-2 align-top sm:align-middle overflow-hidden">
                      <div
                        className="max-w-full truncate font-medium text-slate-900 text-xs sm:text-sm"
                        title={product.name}
                      >
                        {product.name}
                      </div>
                      <div className="text-[11px] text-slate-500 sm:hidden mt-0.5 tabular-nums truncate">
                        {product.sku} - Min. {formatQuantity(product.min_stock)}
                      </div>
                    </td>
                    <td
                      className="py-2.5 px-2 text-slate-600 tabular-nums truncate hidden sm:table-cell"
                      title={product.sku}
                    >
                      {product.sku}
                    </td>
                    <td className="py-2.5 pl-1 sm:px-2 font-semibold text-rose-600 text-right whitespace-nowrap tabular-nums text-xs sm:text-sm align-top sm:align-middle">
                      {formatStock(product.quantity)}
                    </td>
                    <td className="py-2.5 pl-2 text-slate-600 text-right whitespace-nowrap tabular-nums hidden sm:table-cell">
                      {formatStock(product.min_stock)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.lowStock.length && (
              <p className="text-sm text-slate-400 py-4">Tidak ada stok di bawah batas minimum.</p>
            )}
          </div>
          {lowStockPage.pagination}
        </section>
      </div>

      {/* Popup Preview Modal untuk Mobile & Desktop */}
      <DetailPreviewModal preview={previewItem} onClose={() => setPreviewItem(null)} />
    </main>
  );
}

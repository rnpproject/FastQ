export function createAttendanceHistoryHandler({ pool, activeSession, json, isUuid }) {
  return async function attendanceHistory(req, res, url) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method tidak didukung.' });
    const actor = await activeSession(req);
    if (actor.role !== 'Admin')
      return json(res, 403, { error: 'Ekspor riwayat kehadiran hanya tersedia untuk Admin.' });

    const requestedOutlet = url.searchParams.get('outletId');
    if (requestedOutlet && requestedOutlet !== actor.outlet_id)
      return json(res, 403, { error: 'Outlet berada di luar akses akun.' });

    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const validDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if (!validDate(from) || !validDate(to))
      return json(res, 400, { error: 'Rentang tanggal harus menggunakan YYYY-MM-DD.' });
    if (from > to) return json(res, 400, { error: 'Tanggal awal melewati tanggal akhir.' });

    const requestedUser = url.searchParams.get('userId');
    const userId = requestedUser && requestedUser !== 'all' ? requestedUser : null;
    if (userId && !isUuid(userId)) return json(res, 400, { error: 'ID staf tidak valid.' });

    const rawLimit = url.searchParams.get('limit') || '500';
    if (!/^\d{1,3}$/.test(rawLimit)) return json(res, 400, { error: 'Batas halaman tidak valid.' });
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 500)
      return json(res, 400, { error: 'Batas halaman harus antara 1 dan 500.' });

    const before = url.searchParams.get('before');
    const beforeId = url.searchParams.get('beforeId');
    if (
      (before == null) !== (beforeId == null) ||
      (before != null && (!validDate(before) || !isUuid(beforeId)))
    ) {
      return json(res, 400, { error: 'Cursor riwayat kehadiran tidak valid.' });
    }

    const page = await pool.query(
      `SELECT id,user_id,user_name,work_date::text AS work_date,check_in,check_out,
              check_in_location,check_out_location
       FROM attendance
       WHERE outlet_id=$1
         AND work_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR user_id=$4::uuid)
         AND ($5::date IS NULL OR (work_date,id)<($5::date,$6::uuid))
       ORDER BY work_date DESC,id DESC
       LIMIT $7`,
      [actor.outlet_id, from, to, userId, before, beforeId, limit + 1],
    );
    const hasMore = page.rows.length > limit;
    const rows = page.rows.slice(0, limit).map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      workDate: row.work_date,
      checkIn: row.check_in,
      checkOut: row.check_out,
      checkInLocation: row.check_in_location,
      checkOutLocation: row.check_out_location,
    }));
    const last = rows.at(-1);
    return json(res, 200, {
      attendance: rows,
      hasMore,
      next: hasMore ? { before: last.workDate, beforeId: last.id } : null,
    });
  };
}

export function createOutletSessionHandler({
  pool,
  activeSession,
  sessionUser,
  requireSameOrigin,
  readJson,
  isUuid,
  json,
  setSessionCookie,
  signSession,
  isAllowedOrigin,
}) {
  return async function switchOutlet(req, res) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    requireSameOrigin(req);
    const actor = await activeSession(req);
    const input = await readJson(req, 20000);
    if (!isUuid(input.outletId)) return json(res, 400, { error: 'ID outlet tidak valid.' });
    const result = await pool.query(
      `SELECT o.id,o.name,o.code
       FROM users u JOIN outlets o ON o.id=$1
       WHERE u.id=$2 AND u.active=true
         AND (
           o.id=u.outlet_id
           OR (u.role='Pemilik' AND o.owner_user_id=u.id)
           OR (
             u.role<>'Pemilik' AND EXISTS (
               SELECT 1 FROM user_outlet_access a
               WHERE a.user_id=u.id AND a.outlet_id=o.id
             )
           )
         )`,
      [input.outletId, actor.id],
    );
    if (!result.rowCount) return json(res, 403, { error: 'Outlet tidak termasuk akses akun.' });
    const session = sessionUser(req);
    if (!session) return json(res, 401, { error: 'Sesi berakhir. Silakan login kembali.' });
    const outlet = result.rows[0];
    const token = signSession({ ...session, outletId: outlet.id });
    const maxAge = Math.max(0, Math.ceil((session.exp - Date.now()) / 1000));
    setSessionCookie(res, token, maxAge, {
      crossOrigin: isAllowedOrigin(req.headers.origin),
    });
    return json(res, 200, {
      user: {
        id: actor.id,
        name: actor.name,
        role: actor.role,
        outletId: outlet.id,
        outletName: outlet.name,
        outletCode: outlet.code,
      },
      expiresAt: session.exp,
    });
  };
}

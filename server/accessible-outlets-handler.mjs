export function createAccessibleOutletsHandler({ pool, activeSession, json }) {
  return async function accessibleOutlets(req, res) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    const actor = await activeSession(req);
    const result = await pool.query(
      `SELECT o.id,o.name,o.code,o.address
       FROM users u JOIN outlets o ON (
         (u.role='Pemilik' AND o.owner_user_id=u.id)
         OR (
           u.role<>'Pemilik' AND (
             o.id=u.outlet_id
             OR EXISTS (
               SELECT 1 FROM user_outlet_access a
               WHERE a.user_id=u.id AND a.outlet_id=o.id
             )
           )
         )
       )
       WHERE u.id=$1 AND u.active=true
       ORDER BY o.name`,
      [actor.id],
    );
    return json(res, 200, { outlets: result.rows });
  };
}

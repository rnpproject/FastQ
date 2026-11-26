export async function applyShiftEvent({ client, event, scope, actor, deviceId, isUuid }) {
  if (event.type === 'shift.upsert') {
    const s = event.payload;
    s.physicalCash ??= s.actualCash;
    if (!isUuid(s.id) || !Number.isSafeInteger(s.openingCash) || s.openingCash < 0)
      throw Object.assign(new Error('Data shift tidak valid.'), { status: 400 });
    if (s.shiftName != null) {
      if (typeof s.shiftName !== 'string' || !s.shiftName.trim() || s.shiftName.trim().length > 40)
        throw Object.assign(new Error('Nama shift tidak valid.'), { status: 400 });
      s.shiftName = s.shiftName.trim();
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fastq-shift:${scope}`]);
    const opening = await client.query(
      'SELECT user_id,opening_cash_rupiah,metadata FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE',
      [s.id, scope],
    );
    const openingMetadata = opening.rows[0]?.metadata || {};
    if (!s.closedAt) {
      const activeShift = await client.query(
        'SELECT id FROM shifts WHERE outlet_id=$1 AND closed_at IS NULL AND id<>$2 LIMIT 1 FOR UPDATE',
        [scope, s.id],
      );
      if (activeShift.rowCount)
        throw Object.assign(
          new Error(
            'Shift outlet sudah dibuka oleh perangkat atau kasir lain. Gunakan shift yang sedang aktif.',
          ),
          { status: 409, code: 'ACTIVE_SHIFT' },
        );
      s.openedBy = actor.name;
      s.openedById = actor.id;
      s.cashier = actor.name;
      s.cashiers = [...new Set([...(s.cashiers || []), actor.name])];
    } else {
      const openerId = opening.rows[0]?.user_id || openingMetadata.openedById || s.openedById;
      if (openerId && openerId !== actor.id && actor.role !== 'Admin') {
        throw Object.assign(
          new Error(
            `Shift ini dibuka oleh ${openingMetadata.openedBy || s.openedBy || 'kasir lain'}; hanya perwakilan pembuka atau Admin yang dapat menutupnya.`,
          ),
          { status: 403 },
        );
      }
      s.closedBy = actor.name;
      const roster = await client.query(
        'SELECT DISTINCT cashier_name FROM sales WHERE shift_id=$1 AND outlet_id=$2 ORDER BY cashier_name',
        [s.id, scope],
      );
      s.cashiers = [
        ...new Set([
          ...(openingMetadata.cashiers || []),
          ...(s.cashiers || []),
          ...roster.rows.map((row) => row.cashier_name).filter(Boolean),
        ]),
      ];
    }
    let expectedCash = null,
      difference = null;
    if (s.closedAt) {
      const pending = await client.query(
        'SELECT 1 FROM cash_movements WHERE shift_id=$1 AND approval_status=$2 LIMIT 1',
        [s.id, 'pending'],
      );
      if (pending.rowCount)
        throw Object.assign(
          new Error('Shift tidak dapat ditutup sebelum semua kas keluar disetujui atau ditolak.'),
          { status: 409 },
        );
      const pendingDiscount = await client.query(
        `SELECT 1 FROM sync_events
             WHERE outlet_id=$1 AND event_type='discount.request'
               AND payload->>'shiftId'=$2 AND payload->>'saleId' IS NOT NULL
               AND payload->>'approvalStatus'='pending'
             LIMIT 1 FOR UPDATE`,
        [scope, s.id],
      );
      if (pendingDiscount.rowCount)
        throw Object.assign(
          new Error('Shift tidak dapat ditutup sebelum semua diskon disetujui atau ditolak.'),
          { status: 409 },
        );
      const unrequestedDiscount = await client.query(
        `SELECT 1 FROM sync_events sale
             WHERE sale.outlet_id=$1 AND sale.event_type='sale.upsert'
               AND sale.payload->>'shiftId'=$2 AND sale.payload->>'status' IN ('Lunas','Piutang')
               AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(sale.payload->'items') AS item
                 WHERE (item->'discount'->>'pendingApproval')::boolean IS TRUE
                   AND NOT EXISTS (
                     SELECT 1 FROM sync_events req
                     WHERE req.outlet_id=$1 AND req.event_type='discount.request'
                       AND req.payload->>'id' = item->'discount'->>'approvalRequestId'
                   )
               )
             LIMIT 1 FOR UPDATE`,
        [scope, s.id],
      );
      if (unrequestedDiscount.rowCount)
        throw Object.assign(
          new Error(
            'Shift tidak dapat ditutup sebelum semua diskon besar tercatat sebagai permintaan persetujuan dan diputuskan.',
          ),
          { status: 409 },
        );
      if (!Number.isSafeInteger(s.physicalCash) || s.physicalCash < 0)
        throw Object.assign(new Error('Jumlah kas fisik tidak valid.'), { status: 400 });
      const cashSales = await client.query(
        `SELECT COALESCE(sum(p.amount_rupiah),0)::text AS total FROM payments p JOIN sales sale ON sale.id=p.sale_id
             WHERE COALESCE(NULLIF(p.metadata->>'shiftId',''),sale.shift_id::text)=$1::text
               AND sale.outlet_id=$2 AND p.method='Tunai' AND sale.status NOT IN ('Void','Gagal','Menunggu')`,
        [s.id, scope],
      );
      const movements = await client.query(
        `SELECT COALESCE(sum(CASE WHEN direction='in' THEN amount_rupiah ELSE -amount_rupiah END),0)::text AS total
             FROM cash_movements WHERE shift_id=$1 AND approval_status='approved'`,
        [s.id],
      );
      expectedCash =
        Number(opening.rows[0]?.opening_cash_rupiah ?? s.openingCash) +
        Number(cashSales.rows[0].total) +
        Number(movements.rows[0].total);
      difference = s.physicalCash - expectedCash;
      if (!Number.isSafeInteger(expectedCash) || !Number.isSafeInteger(difference))
        throw Object.assign(new Error('Nilai kas shift melebihi batas penyimpanan.'), {
          status: 400,
        });
      s.expectedCash = expectedCash;
      s.difference = difference;
    }
    const metadata = {
      ...openingMetadata,
      cashier: openingMetadata.cashier || s.cashier || actor.name,
      openedBy: openingMetadata.openedBy || s.openedBy || s.cashier || actor.name,
      shiftName: openingMetadata.shiftName || s.shiftName || null,
      openedById:
        openingMetadata.openedById || s.openedById || opening.rows[0]?.user_id || actor.id,
      closedBy: s.closedAt ? actor.name : openingMetadata.closedBy || null,
      cashiers: [...new Set([...(openingMetadata.cashiers || []), ...(s.cashiers || [])])],
    };
    const savedShift = await client.query(
      `INSERT INTO shifts(id,outlet_id,user_id,opened_at,closed_at,opening_cash_rupiah,expected_cash_rupiah,physical_cash_rupiah,difference_rupiah,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE
           SET closed_at=COALESCE(shifts.closed_at,EXCLUDED.closed_at),
           expected_cash_rupiah=CASE WHEN shifts.closed_at IS NULL THEN EXCLUDED.expected_cash_rupiah ELSE shifts.expected_cash_rupiah END,
           physical_cash_rupiah=CASE WHEN shifts.closed_at IS NULL THEN EXCLUDED.physical_cash_rupiah ELSE shifts.physical_cash_rupiah END,
           difference_rupiah=CASE WHEN shifts.closed_at IS NULL THEN EXCLUDED.difference_rupiah ELSE shifts.difference_rupiah END,
           metadata=CASE WHEN shifts.closed_at IS NULL THEN EXCLUDED.metadata ELSE shifts.metadata END
           WHERE shifts.outlet_id=EXCLUDED.outlet_id
           RETURNING id,outlet_id,user_id,opened_at,closed_at,opening_cash_rupiah,expected_cash_rupiah,physical_cash_rupiah,difference_rupiah,metadata`,
      [
        s.id,
        s.outletId || event.outletId,
        opening.rows[0]?.user_id || actor.id,
        s.openedAt,
        s.closedAt || null,
        s.openingCash || 0,
        s.expectedCash ?? null,
        s.physicalCash ?? null,
        s.difference ?? null,
        metadata,
      ],
    );
    if (!savedShift.rowCount)
      throw Object.assign(new Error('ID shift sudah digunakan di outlet lain.'), { status: 409 });
    const saved = savedShift.rows[0],
      canonical = {
        ...s,
        id: saved.id,
        outletId: saved.outlet_id,
        openedAt: saved.opened_at,
        closedAt: saved.closed_at,
        openingCash: Number(saved.opening_cash_rupiah),
        expectedCash:
          saved.expected_cash_rupiah === null ? null : Number(saved.expected_cash_rupiah),
        physicalCash:
          saved.physical_cash_rupiah === null ? null : Number(saved.physical_cash_rupiah),
        difference: saved.difference_rupiah === null ? null : Number(saved.difference_rupiah),
        cashier: saved.metadata?.cashier || s.cashier,
        openedBy: saved.metadata?.openedBy || s.openedBy || s.cashier,
        shiftName: saved.metadata?.shiftName || s.shiftName || null,
        openedById: saved.metadata?.openedById || saved.user_id,
        closedBy: saved.metadata?.closedBy || s.closedBy || null,
        cashiers: saved.metadata?.cashiers || s.cashiers || [],
      };
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
      canonical,
      deviceId,
      event.id,
    ]);
  }
}

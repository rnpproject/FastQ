const RUNTIME_ROLE_CHECK = `
  SELECT r.rolsuper AS is_superuser, r.rolcreatedb AS can_create_database,
         r.rolcreaterole AS can_create_role, r.rolreplication AS can_replicate,
         r.rolbypassrls AS can_bypass_rls,
         pg_get_userbyid(d.datdba)=current_user AS owns_database,
         has_database_privilege(current_user,current_database(),'CREATE') AS can_create_schema,
         has_schema_privilege(current_user,'public','CREATE') AS can_create_public_objects,
         EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relowner=r.oid) AS owns_public_objects,
         EXISTS (
           SELECT 1 FROM pg_roles inherited
           WHERE pg_has_role(
                   current_user,inherited.oid,
                   CASE WHEN current_setting('server_version_num')::integer >= 160000 THEN 'SET' ELSE 'MEMBER' END
                 )
             AND (
               inherited.rolsuper OR inherited.rolcreatedb OR inherited.rolcreaterole
               OR inherited.rolreplication OR inherited.rolbypassrls
               OR pg_get_userbyid(d.datdba)=inherited.rolname
               OR has_database_privilege(inherited.rolname,current_database(),'CREATE')
               OR has_schema_privilege(inherited.rolname,'public','CREATE')
               OR EXISTS (
                 SELECT 1 FROM pg_shdepend owner_dep
                 WHERE owner_dep.refclassid='pg_authid'::regclass
                   AND owner_dep.refobjid=inherited.oid
                   AND owner_dep.deptype='o'
                   AND owner_dep.dbid IN (0,d.oid)
               )
             )
         ) AS can_assume_privileged_role
  FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
  WHERE r.rolname=current_user
`;

export const REQUIRED_SCHEMA_VERSION = 11;

export async function checkDatabaseReadiness(
  pool,
  requiredSchemaVersion = REQUIRED_SCHEMA_VERSION,
) {
  const blockers = [];
  let roleResult;
  try {
    roleResult = await pool.query(RUNTIME_ROLE_CHECK);
  } catch {
    return { ready: false, reason: 'database_unavailable', blockers: ['database_unavailable'] };
  }
  if (!roleResult.rowCount) blockers.push('runtime_role_not_found');
  else if (Object.values(roleResult.rows[0]).some(Boolean))
    blockers.push('runtime_role_too_privileged');

  let requiredTables;
  try {
    requiredTables = await pool.query(`SELECT
      to_regclass('public.sync_events') IS NOT NULL AS sync_events,
      to_regclass('public.sync_devices') IS NOT NULL AS sync_devices,
      to_regclass('public.sync_event_retention') IS NOT NULL AS sync_event_retention,
      to_regclass('public.auth_sessions') IS NOT NULL AS auth_sessions,
      to_regclass('public.product_images') IS NOT NULL AS product_images,
      to_regclass('public.user_outlet_access') IS NOT NULL AS user_outlet_access,
      to_regclass('public.user_profile_photos') IS NOT NULL AS user_profile_photos`);
    const tables = requiredTables.rows[0] || {};
    if (
      !tables.sync_events ||
      !tables.sync_devices ||
      !tables.sync_event_retention ||
      !tables.auth_sessions ||
      !tables.product_images ||
      !tables.user_outlet_access ||
      !tables.user_profile_photos
    )
      blockers.push('sync_schema_incomplete');
  } catch {
    blockers.push('sync_schema_unavailable');
  }

  let migration;
  try {
    migration = await pool.query(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
  } catch {
    blockers.push('schema_migrations_unavailable');
  }
  let version;
  if (migration) {
    if (!migration.rowCount) blockers.push('schema_migration_missing');
    else {
      version = Number(migration.rows[0].version);
      if (!Number.isSafeInteger(version) || version < requiredSchemaVersion)
        blockers.push('schema_version_outdated');
    }
  }
  try {
    const privilege = await pool.query(`SELECT CASE
      WHEN to_regclass('public.schema_migrations') IS NULL THEN false
      ELSE has_table_privilege(current_user,to_regclass('public.schema_migrations'),'INSERT')
        OR has_table_privilege(current_user,to_regclass('public.schema_migrations'),'UPDATE')
        OR has_table_privilege(current_user,to_regclass('public.schema_migrations'),'DELETE')
      END AS can_write_schema_migrations`);
    if (privilege.rows[0]?.can_write_schema_migrations)
      blockers.push('runtime_can_write_schema_migrations');
  } catch {
    blockers.push('schema_migration_privilege_check_unavailable');
  }
  return {
    ready: blockers.length === 0,
    reason: blockers[0] || 'ready',
    blockers,
    warnings: [],
    version,
  };
}

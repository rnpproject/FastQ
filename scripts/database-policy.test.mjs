import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDatabaseReadiness, REQUIRED_SCHEMA_VERSION } from '../server/database-policy.mjs';

const noPrivileges = {
  is_superuser: false,
  can_create_database: false,
  can_create_role: false,
  can_replicate: false,
  can_bypass_rls: false,
  owns_database: false,
  can_create_schema: false,
  can_create_public_objects: false,
  owns_public_objects: false,
  can_assume_privileged_role: false,
};

test('readiness reports role and missing schema blockers together', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('pg_roles'))
        return { rowCount: 1, rows: [{ ...noPrivileges, can_create_role: true }] };
      if (sql.includes('has_table_privilege'))
        return { rowCount: 1, rows: [{ can_write_schema_migrations: false }] };
      if (sql.includes('to_regclass'))
        return {
          rowCount: 1,
          rows: [
            {
              sync_events: true,
              sync_devices: true,
              sync_event_retention: false,
              auth_sessions: true,
              product_images: true,
              user_outlet_access: true,
              user_profile_photos: true,
            },
          ],
        };
      if (sql.includes('schema_migrations')) throw new Error('relation does not exist');
      throw new Error('Unexpected query');
    },
  };
  const result = await checkDatabaseReadiness(pool, 3);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'runtime_role_too_privileged');
  assert.deepEqual(result.blockers, [
    'runtime_role_too_privileged',
    'sync_schema_incomplete',
    'schema_migrations_unavailable',
  ]);
});

test('readiness accepts the required role, tables, and migration version', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('pg_roles')) return { rowCount: 1, rows: [noPrivileges] };
      if (sql.includes('has_table_privilege'))
        return { rowCount: 1, rows: [{ can_write_schema_migrations: false }] };
      if (sql.includes('to_regclass'))
        return {
          rowCount: 1,
          rows: [
            {
              sync_events: true,
              sync_devices: true,
              sync_event_retention: true,
              auth_sessions: true,
              product_images: true,
              user_outlet_access: true,
              user_profile_photos: true,
            },
          ],
        };
      if (sql.includes('schema_migrations')) return { rowCount: 1, rows: [{ version: 3 }] };
      throw new Error('Unexpected query');
    },
  };
  assert.deepEqual(await checkDatabaseReadiness(pool, 3), {
    ready: true,
    reason: 'ready',
    blockers: [],
    warnings: [],
    version: 3,
  });
});

test('readiness blocks an older schema before applying required security migration', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('pg_roles')) return { rowCount: 1, rows: [noPrivileges] };
      if (sql.includes('has_table_privilege'))
        return { rowCount: 1, rows: [{ can_write_schema_migrations: false }] };
      if (sql.includes('to_regclass'))
        return {
          rowCount: 1,
          rows: [
            {
              sync_events: true,
              sync_devices: true,
              sync_event_retention: true,
              auth_sessions: true,
              product_images: true,
              user_outlet_access: true,
              user_profile_photos: true,
            },
          ],
        };
      if (sql.includes('schema_migrations')) return { rowCount: 1, rows: [{ version: 2 }] };
      throw new Error('Unexpected query');
    },
  };
  const result = await checkDatabaseReadiness(pool, 3);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['schema_version_outdated']);
});

test('readiness requires the outlet-details database migration', async () => {
  assert.equal(REQUIRED_SCHEMA_VERSION, 11);
  const pool = {
    async query(sql) {
      if (sql.includes('pg_roles')) return { rowCount: 1, rows: [noPrivileges] };
      if (sql.includes('has_table_privilege'))
        return { rowCount: 1, rows: [{ can_write_schema_migrations: false }] };
      if (sql.includes('to_regclass'))
        return {
          rowCount: 1,
          rows: [
            {
              sync_events: true,
              sync_devices: true,
              sync_event_retention: true,
              auth_sessions: true,
              product_images: true,
              user_outlet_access: true,
              user_profile_photos: true,
            },
          ],
        };
      if (sql.includes('schema_migrations')) return { rowCount: 1, rows: [{ version: 5 }] };
      throw new Error('Unexpected query');
    },
  };
  const result = await checkDatabaseReadiness(pool, REQUIRED_SCHEMA_VERSION);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['schema_version_outdated']);
});

test('readiness blocks runtime schema write grants and unavailable privilege checks', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('pg_roles')) return { rowCount: 1, rows: [noPrivileges] };
      if (sql.includes('has_table_privilege'))
        return { rowCount: 1, rows: [{ can_write_schema_migrations: true }] };
      if (sql.includes('to_regclass'))
        return {
          rowCount: 1,
          rows: [
            {
              sync_events: true,
              sync_devices: true,
              sync_event_retention: true,
              auth_sessions: true,
              product_images: true,
              user_outlet_access: true,
              user_profile_photos: true,
            },
          ],
        };
      if (sql.includes('schema_migrations')) return { rowCount: 1, rows: [{ version: 3 }] };
      throw new Error('Unexpected query');
    },
  };
  const result = await checkDatabaseReadiness(pool, 3);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['runtime_can_write_schema_migrations']);
  const unavailable = await checkDatabaseReadiness(
    {
      async query(sql) {
        if (sql.includes('pg_roles')) return { rowCount: 1, rows: [noPrivileges] };
        if (sql.includes('has_table_privilege')) throw new Error('permission check unavailable');
        if (sql.includes('to_regclass'))
          return {
            rowCount: 1,
            rows: [
              {
                sync_events: true,
                sync_devices: true,
                sync_event_retention: true,
                auth_sessions: true,
                product_images: true,
                user_outlet_access: true,
                user_profile_photos: true,
              },
            ],
          };
        if (sql.includes('schema_migrations') && sql.includes('SELECT version'))
          return { rowCount: 1, rows: [{ version: 3 }] };
        throw new Error('Unexpected query');
      },
    },
    3,
  );
  assert.equal(unavailable.ready, false);
  assert.deepEqual(unavailable.blockers, ['schema_migration_privilege_check_unavailable']);
});

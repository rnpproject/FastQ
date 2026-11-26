import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canManageOutletAccess,
  canManageUserAccounts,
  canResetUserPassword,
  isValidOutletAssignment,
} from '../server/user-management-policy.mjs';

test('only owners and admins can manage registered user accounts', () => {
  assert.equal(canManageUserAccounts('Pemilik'), true);
  assert.equal(canManageUserAccounts('Admin'), true);
  assert.equal(canManageUserAccounts('Manajer'), false);
  assert.equal(canManageUserAccounts('Kasir'), false);
});

test('owner accounts have no outlet access settings and privileged password resets cannot target self', () => {
  const admin = { id: 'admin', role: 'Admin' };
  const owner = { id: 'owner', role: 'Pemilik' };
  const manager = { id: 'manager', role: 'Manajer' };
  const cashier = { id: 'cashier', role: 'Kasir' };
  assert.equal(canManageOutletAccess(owner, { id: 'other-owner', role: 'Pemilik' }), false);
  assert.equal(canManageOutletAccess(owner, { id: 'staff', role: 'Admin' }), true);
  assert.equal(canManageOutletAccess(admin, { id: 'owner', role: 'Pemilik' }), false);
  assert.equal(canManageOutletAccess(admin, cashier), true);
  assert.equal(canManageOutletAccess(admin, { id: 'another-admin', role: 'Admin' }), false);
  assert.equal(canManageOutletAccess(admin, manager), false);
  assert.equal(canManageOutletAccess(admin, admin), false);
  assert.equal(canManageOutletAccess(manager, cashier), false);
  assert.equal(canManageOutletAccess(cashier, cashier), false);
  assert.equal(canManageOutletAccess(owner, owner), false);
  assert.equal(canResetUserPassword(admin, { id: 'admin', role: 'Admin' }), false);
  assert.equal(canResetUserPassword(admin, { id: 'staff', role: 'Kasir' }), true);
  assert.equal(canResetUserPassword(owner, { id: 'other-owner', role: 'Pemilik' }), true);
  assert.equal(canResetUserPassword(owner, { id: 'staff', role: 'Admin' }), true);
});

test('outlet assignments stay within the actor scope and retain the primary outlet', () => {
  const allowed = new Set(['outlet-main', 'outlet-branch']);
  assert.equal(
    isValidOutletAssignment(['outlet-main', 'outlet-branch'], allowed, 'outlet-main'),
    true,
  );
  assert.equal(isValidOutletAssignment(['outlet-branch'], allowed, 'outlet-main'), false);
  assert.equal(isValidOutletAssignment(['outlet-main', 'other'], allowed, 'outlet-main'), false);
  assert.equal(
    isValidOutletAssignment(['outlet-main', 'outlet-main'], allowed, 'outlet-main'),
    false,
  );
});

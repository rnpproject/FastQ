const USER_MANAGEMENT_ROLES = new Set(['Pemilik', 'Admin']);

export function canManageUserAccounts(role) {
  return USER_MANAGEMENT_ROLES.has(role);
}

export function canManageOutletAccess(actor, target) {
  if (!actor || !target || actor.id === target.id) return false;
  if (actor.role === 'Pemilik') return target.role !== 'Pemilik';
  return actor.role === 'Admin' && target.role === 'Kasir';
}

export function canResetUserPassword(actor, target) {
  return (
    canManageUserAccounts(actor?.role) &&
    !(actor.role === 'Admin' && target?.role === 'Pemilik') &&
    actor.id !== target?.id
  );
}

export function isValidOutletAssignment(storeIds, allowedOutletIds, primaryOutletId) {
  return (
    Array.isArray(storeIds) &&
    storeIds.length > 0 &&
    storeIds.length <= 100 &&
    new Set(storeIds).size === storeIds.length &&
    storeIds.includes(primaryOutletId) &&
    storeIds.every((id) => typeof id === 'string' && allowedOutletIds.has(id))
  );
}

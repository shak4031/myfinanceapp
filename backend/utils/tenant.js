import { AsyncLocalStorage } from 'node:async_hooks';

const tenants = new AsyncLocalStorage();

export function withUser(userId, callback, options = {}) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('A valid authenticated user is required');
  return tenants.run({ userId, readOnly: options.readOnly === true }, callback);
}

export function currentUserId() {
  const id = tenants.getStore()?.userId;
  if (!id) throw new Error('Database access requires an authenticated user');
  return id;
}

export function currentReadOnly() {
  return tenants.getStore()?.readOnly === true;
}

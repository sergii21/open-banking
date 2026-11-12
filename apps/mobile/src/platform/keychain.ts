import * as SecureStore from 'expo-secure-store';

const KEY = 'monobank-token';

/**
 * The iOS Keychain holds the bank token: readable only while the phone is unlocked, never copied to another device and
 * never part of a backup. This file is the one place the app reads it back, and nothing here or anywhere else prints it.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface TokenVault {
  read(): Promise<string | null>;
  save(token: string): Promise<void>;
  forget(): Promise<void>;
}

export const keychainVault: TokenVault = {
  read: () => SecureStore.getItemAsync(KEY, OPTIONS),
  save: (token) => SecureStore.setItemAsync(KEY, token, OPTIONS),
  forget: () => SecureStore.deleteItemAsync(KEY, OPTIONS),
};

const FAMILY_KEY = 'family-secret';

/** The family secret, kept the way the bank token is: in the Keychain, on this device only. */
export interface FamilyKeyring {
  load(): Promise<string | null>;
  keep(secret: string): Promise<void>;
  drop(): Promise<void>;
}

export const keychainFamily: FamilyKeyring = {
  load: () => SecureStore.getItemAsync(FAMILY_KEY, OPTIONS),
  keep: (secret) => SecureStore.setItemAsync(FAMILY_KEY, secret, OPTIONS),
  drop: () => SecureStore.deleteItemAsync(FAMILY_KEY, OPTIONS),
};

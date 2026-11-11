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

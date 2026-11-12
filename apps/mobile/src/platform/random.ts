import { getRandomBytes } from 'expo-crypto';
import type { RandomBytes } from '../family/crypto';

/** The phone's own secure random generator: family secrets and the nonce of every sealed summary come from here. */
export const secureRandom: RandomBytes = (length) => getRandomBytes(length);

import type { Category } from '@ledger-lens/contracts';

export interface CategoryInfo {
  label: string;
  icon: string;
}

export const CATEGORY_INFO: Record<Category, CategoryInfo> = {
  groceries: { label: 'Groceries', icon: 'shopping_basket' },
  dining: { label: 'Dining', icon: 'restaurant' },
  transport: { label: 'Transport', icon: 'directions_transit' },
  shopping: { label: 'Shopping', icon: 'shopping_bag' },
  housing: { label: 'Housing', icon: 'home' },
  bills: { label: 'Bills & utilities', icon: 'receipt_long' },
  subscriptions: { label: 'Subscriptions', icon: 'autorenew' },
  entertainment: { label: 'Entertainment', icon: 'movie' },
  health: { label: 'Health', icon: 'medical_services' },
  travel: { label: 'Travel', icon: 'flight' },
  transfers: { label: 'Transfers', icon: 'swap_horiz' },
  income: { label: 'Income', icon: 'payments' },
  other: { label: 'Other', icon: 'category' },
};

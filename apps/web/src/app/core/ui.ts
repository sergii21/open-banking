import { Service, signal } from '@angular/core';
import type { ImportResult } from '@ledger-lens/contracts';

/** Which sheets are open. Small, shared, and not worth a router segment. */
@Service()
export class Ui {
  readonly settings = signal(false);
  readonly liveApi = signal(false);
  /** What the last statement import did; Home shows it until it is dismissed. */
  readonly imported = signal<ImportResult | null>(null);
  /** Bumped by the `/` shortcut; the Activity screen focuses its search box when it changes. */
  readonly focusSearch = signal(0);
}

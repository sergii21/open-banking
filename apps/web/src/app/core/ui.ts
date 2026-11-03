import { Service, signal } from '@angular/core';

/** Which sheets are open. Small, shared, and not worth a router segment. */
@Service()
export class Ui {
  readonly settings = signal(false);
  readonly liveApi = signal(false);
  /** Bumped by the `/` shortcut; the Activity screen focuses its search box when it changes. */
  readonly focusSearch = signal(0);
}

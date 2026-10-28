import { inject, Service } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/** "Dashboard · Ledger Lens": the route `title` first, so tabs and screen-reader page announcements stay distinct. */
@Service({ autoProvided: false })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${page} · Ledger Lens` : 'Ledger Lens');
  }
}

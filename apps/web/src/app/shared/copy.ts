import { inject, Service } from '@angular/core';
import { Toast } from '../core/toast';

@Service()
export class Clipboard {
  private readonly toast = inject(Toast);

  async copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show(`${what} copied`);
    } catch {
      this.toast.show('Copying is blocked in this browser');
    }
  }
}

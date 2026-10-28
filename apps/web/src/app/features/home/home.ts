import { httpResource } from '@angular/common/http';
import { Component } from '@angular/core';

interface ApiMeta {
  name: string;
  version: string;
  environment: string;
  providers: string[];
}

@Component({
  selector: 'll-home',
  template: `
    <main class="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 p-6">
      <h1 class="text-3xl font-semibold tracking-tight">Ledger Lens</h1>
      <p class="text-on-surface-variant">
        An Open Banking proof of concept: account information and payment initiation, with an API
        Inspector.
      </p>
      <p class="text-sm" data-testid="api-status" role="status">
        @if (meta.isLoading()) {
          Checking the API…
        } @else if (meta.value(); as api) {
          API {{ api.version }} is up ({{ api.environment }}) · providers:
          {{ api.providers.join(', ') }}
        } @else {
          The API is not reachable.
        }
      </p>
    </main>
  `,
})
export class Home {
  protected readonly meta = httpResource<ApiMeta>(() => '/api/meta');
}

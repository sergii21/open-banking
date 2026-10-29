import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { describeError } from '../../core/api/api-error';
import { Money } from '../../shared/money/money';
import { RelativeTime } from '../../shared/relative-time/relative-time';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { StatusChip } from '../../shared/status-chip/status-chip';
import { PaymentsData } from './payments-data';
import { statusView } from './payment-view';

@Component({
  selector: 'll-payments',
  imports: [MatButton, MatIcon, Money, RelativeTime, RouterLink, Skeleton, StateCard, StatusChip],
  templateUrl: './payments.html',
})
export class Payments {
  protected readonly data = inject(PaymentsData);

  protected readonly loading = computed(
    () => this.data.payments.status() === 'loading' && !this.data.payments.hasValue(),
  );
  protected readonly failure = computed(() => describeError(this.data.payments.error()));
  protected readonly view = statusView;
}

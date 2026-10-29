import { Routes } from '@angular/router';
import { Shell } from './core/shell/shell';
import { applyAccountFilter } from './features/transactions/account-filter.resolver';

export const routes: Routes = [
  {
    path: '',
    component: Shell,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Dashboard',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'transactions',
        title: 'Transactions',
        runGuardsAndResolvers: 'paramsOrQueryParamsChange',
        resolve: { accountFilter: applyAccountFilter },
        loadComponent: () =>
          import('./features/transactions/transactions').then((m) => m.Transactions),
      },
      {
        path: 'payments',
        title: 'Payments',
        loadComponent: () => import('./features/payments/payments').then((m) => m.Payments),
      },
      {
        path: 'payments/new',
        title: 'New payment',
        loadComponent: () => import('./features/payments/payment-form').then((m) => m.PaymentForm),
      },
      {
        path: 'payments/:id',
        title: 'Payment',
        loadComponent: () =>
          import('./features/payments/payment-detail').then((m) => m.PaymentDetail),
      },
      {
        path: 'payments/:id/result',
        title: 'Payment status',
        loadComponent: () =>
          import('./features/payments/payment-detail').then((m) => m.PaymentDetail),
      },
      {
        path: 'connections',
        title: 'Connections & privacy',
        loadComponent: () =>
          import('./features/connections/connections').then((m) => m.Connections),
      },
      {
        path: 'connect',
        title: 'Connect a bank',
        loadComponent: () => import('./features/connect/connect').then((m) => m.Connect),
      },
      {
        path: 'connect/review/:institutionId',
        title: 'Review access',
        loadComponent: () =>
          import('./features/connect/connect-review').then((m) => m.ConnectReview),
      },
      {
        path: 'connect/result',
        title: 'Connection result',
        loadComponent: () =>
          import('./features/connect/connect-result').then((m) => m.ConnectResult),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];

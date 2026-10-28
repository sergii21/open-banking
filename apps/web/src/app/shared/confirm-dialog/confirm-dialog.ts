import { Component, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogTitle,
} from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

export interface ConfirmData {
  title: string;
  message: string;
  confirmLabel: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
}

@Component({
  selector: 'll-confirm-dialog',
  imports: [MatButton, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p class="text-on-surface-variant">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false" cdkFocusInitial>Cancel</button>
      <button
        mat-flat-button
        type="button"
        [mat-dialog-close]="true"
        [class]="data.destructive ? '!bg-error !text-on-error' : ''"
        data-testid="confirm-yes"
      >
        {{ data.confirmLabel }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

/** Opens a confirmation and resolves true only if the person explicitly confirms. Cancel is focused first. */
export async function confirm(dialog: MatDialog, data: ConfirmData): Promise<boolean> {
  const ref = dialog.open<ConfirmDialog, ConfirmData, boolean>(ConfirmDialog, {
    data,
    width: '28rem',
    maxWidth: '92vw',
  });
  return (await firstValueFrom(ref.afterClosed())) === true;
}

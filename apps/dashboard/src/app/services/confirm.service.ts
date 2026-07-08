import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly danger?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly visible = signal(false);
  readonly options = signal<ConfirmOptions>({ title: '', message: '' });

  private resolver: ((value: boolean) => void) | null = null;

  confirm(opts: ConfirmOptions): Promise<boolean> {
    this.options.set(opts);
    this.visible.set(true);
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  accept(): void {
    this.visible.set(false);
    this.resolver?.(true);
    this.resolver = null;
  }

  cancel(): void {
    this.visible.set(false);
    this.resolver?.(false);
    this.resolver = null;
  }
}

import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'bifrost-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private mediaQuery: MediaQueryList | null = null;

  readonly mode = signal<ThemeMode>('system');
  readonly resolved = signal<'light' | 'dark'>('dark');

  constructor() {
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

      const saved = this.loadSaved();
      this.mode.set(saved);
      this.resolved.set(this.resolve(saved));
      this.apply(this.resolved());

      this.mediaQuery.addEventListener('change', () => {
        if (this.mode() === 'system') {
          const resolved = this.resolve('system');
          this.resolved.set(resolved);
          this.apply(resolved);
        }
      });
    }
  }

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
    localStorage.setItem(STORAGE_KEY, mode);

    const resolved = this.resolve(mode);
    this.resolved.set(resolved);
    this.apply(resolved);
  }

  private loadSaved(): ThemeMode {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  }

  private resolve(mode: ThemeMode): 'light' | 'dark' {
    if (mode === 'system') {
      return this.mediaQuery?.matches ? 'dark' : 'light';
    }
    return mode;
  }

  private apply(theme: 'light' | 'dark'): void {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
}

import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly auth = inject(AuthService);
  private readonly baseUrl = environment.apiUrl;

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  get<T>(path: string): Promise<T> {
    return this.request('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request('DELETE', path);
  }
}

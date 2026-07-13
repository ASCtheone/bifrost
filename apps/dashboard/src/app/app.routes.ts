import { Routes } from '@angular/router';
import { authGuard, adminGuard, superadminGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/landing/landing.page').then((m) => m.LandingPage),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'setup',
    loadComponent: () =>
      import('./pages/setup/setup.page').then((m) => m.SetupPage),
  },
  {
    path: 'change-password',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/change-password/change-password.page').then((m) => m.ChangePasswordPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
      },
      {
        path: 'sparks',
        loadComponent: () =>
          import('./pages/nodes/nodes.page').then((m) => m.NodesPage),
      },
      {
        path: 'devices',
        loadComponent: () =>
          import('./pages/devices/devices.page').then((m) => m.DevicesPage),
      },
      {
        path: 'users',
        canActivate: [adminGuard],
        loadComponent: () =>
          import('./pages/users/users.page').then((m) => m.UsersPage),
      },
      {
        path: 'admin/sparks',
        canActivate: [superadminGuard],
        loadComponent: () =>
          import('./pages/admin-nodes/admin-nodes.page').then((m) => m.AdminNodesPage),
      },
      { path: 'nodes', redirectTo: 'sparks', pathMatch: 'full' },
      { path: 'admin/nodes', redirectTo: 'admin/sparks', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: '' },
];

export const environment = {
  production: true,
  // Same-origin, under the /bifrost prefix: the whole app (UI + API + feed) is
  // mounted at /bifrost so a single path can be routed to it. The API lives at
  // /bifrost/api; a leading "/" keeps it origin-relative (no hardcoded host).
  apiUrl: '/bifrost/api',
  // spark-server is HTTP-only (no WebSocket push).
  wsUrl: '',
  // The public landing and the dashboard live on different subdomains in prod.
  // Both are configurable here so the "Connect" button and cross-links follow
  // the deployment without code changes.
  landingUrl: 'https://asc.ninja/bifrost',
  dashboardUrl: 'https://dash.asc.ninja/bifrost/login',
};

export const environment = {
  production: false,
  // Self-hosted spark-server (Rust). No AWS.
  apiUrl: 'http://127.0.0.1:8899',
  // spark-server is HTTP-only (no WebSocket push); leave blank to disable the
  // realtime channel — pages load their data over the REST API.
  wsUrl: '',
  // Public marketing landing page (where the top-left "Connect" button lives).
  landingUrl: 'http://localhost:4200/',
  // Where "Connect" sends visitors — the dashboard sign-in. In dev the dashboard
  // is same-origin, so leave blank to route internally to /login.
  dashboardUrl: '',
};

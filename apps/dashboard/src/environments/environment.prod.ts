export const environment = {
  production: true,
  // Same-origin: in production the dashboard is served by spark-server itself,
  // so the API + opkg feed live on the same host. Relative URLs (leading "/")
  // hit the API at the server root regardless of domain — no hardcoded host.
  apiUrl: '',
  // spark-server is HTTP-only (no WebSocket push).
  wsUrl: '',
};

export const environment = {
  production: false,
  // Self-hosted spark-server (Rust). No AWS.
  apiUrl: 'http://127.0.0.1:8899',
  // spark-server is HTTP-only (no WebSocket push); leave blank to disable the
  // realtime channel — pages load their data over the REST API.
  wsUrl: '',
};

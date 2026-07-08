export interface UniFiMeta {
  readonly rc: "ok" | "error";
  readonly msg?: string;
}

export interface UniFiResponse<T> {
  readonly meta: UniFiMeta;
  readonly data: readonly T[];
}

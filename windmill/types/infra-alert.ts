// homelab's f/infra/alert.ts (Alertmanager, ntfy, phone) as the flows' steps import it: Windmill resolves
// "/f/infra/alert.ts" at run time; tsc resolves it here (windmill/tsconfig.json paths). Types only.
export declare function main(
  name: string,
  summary: string,
  description?: string,
  severity?: "critical" | "warning" | "info",
  labels?: Record<string, string>,
  duration_minutes?: number,
): Promise<{ sent: string; severity: string; ends: string }>;

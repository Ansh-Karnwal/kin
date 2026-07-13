/** Structured console logging: ISO timestamp, event name, JSON detail. */
export function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(`[${new Date().toISOString()}] [${event}] ${JSON.stringify(detail)}`);
}

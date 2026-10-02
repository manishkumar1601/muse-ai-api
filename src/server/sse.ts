export function sseLine(payload: string): string { return `data: ${payload}\n\n`; }
export function sseNamed(event: string, payload: string): string { return `event: ${event}\ndata: ${payload}\n\n`; }

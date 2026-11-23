import pino from "pino";

// Sanitise: an invalid LOG_LEVEL must not crash the process at import
// time (pino throws). loadConfig() validates LOG_LEVEL properly and the
// entrypoint reports it — the logger just needs a safe fallback until then.
const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
const raw = process.env["LOG_LEVEL"];
const level = (LEVELS as readonly string[]).includes(raw ?? "") ? (raw as (typeof LEVELS)[number]) : "info";
export const logger = pino({ level });

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_PRIORITY: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const minLevel = (() => {
  const raw = process.env.LOG_LEVEL?.toUpperCase();
  if (raw === "DEBUG" || raw === "INFO" || raw === "WARN" || raw === "ERROR") {
    return raw;
  }
  return "INFO";
})();

function shouldLog(level: Level): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
    ...extra,
  };
  const line = JSON.stringify(payload);
  if (level === "ERROR") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logger = {
  debug(message: string, extra?: Record<string, unknown>) {
    log("DEBUG", message, extra);
  },
  info(message: string, extra?: Record<string, unknown>) {
    log("INFO", message, extra);
  },
  warn(message: string, extra?: Record<string, unknown>) {
    log("WARN", message, extra);
  },
  error(message: string, extra?: Record<string, unknown>) {
    log("ERROR", message, extra);
  },
};
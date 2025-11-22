import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  console.log("Initializing sentry");

  Sentry.init({
    dsn: SENTRY_DSN,
    integrations: [
      Sentry.consoleLoggingIntegration({
        levels: ["assert", "debug", "error", "info", "log", "trace", "warn"],
      }),
    ],
    enableLogs: true,
    sendDefaultPii: true,
    environment: process.env.NODE_ENV || "development",
  });
}

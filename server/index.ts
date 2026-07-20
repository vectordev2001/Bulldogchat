import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { syncDeactivatedFromAuth } from "./users-sync";
import { createServer } from "node:http";
import { recordBogeyDiagnostic } from "./bogey-storage";

const app = express();
// Behind Render's TLS-terminating reverse proxy. Honor X-Forwarded-* so
// req.protocol reflects the real client-facing scheme (https), which Twilio
// signature verification depends on.
app.set("trust proxy", true);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Cross-App Mini-Chat Widget (Phase 2.5): Contracts and Ops embed a widget
// that calls this API cross-origin with credentials (the shared
// bulldog_access cookie, Domain=.bulldogops.com). Browsers require an
// explicit allowlisted Origin (not "*") whenever a request carries
// credentials, so we mirror the request's Origin back only when it's on
// the allowlist. CORS_ALLOWED_ORIGINS is a comma-separated list, e.g.
// "https://contracts.bulldogops.com,https://ops.bulldogops.com". Local dev
// origins are included by default so `npm run dev` works without env setup.
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5000",
];
const corsAllowedOrigins = new Set([
  ...DEFAULT_DEV_ORIGINS,
  ...(process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && corsAllowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ?? "Content-Type, Authorization",
    );
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  express.json({
    // File uploads go through multer (multipart), not here — this limit is
    // just headroom for message payloads carrying attachment metadata.
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    // Record diagnostic so Bogey's Help Desk can surface it when the user
    // says "X is broken". Scoped to the requesting user when we know them;
    // otherwise userId=0 so admins can still see it. Fire-and-forget —
    // recordBogeyDiagnostic never throws.
    if (status >= 400 && req.path.startsWith("/api")) {
      const sessionUser = (req as any).user?.id ?? (req as any).session?.userId ?? 0;
      const stackHead = String(err?.stack || "").split("\n").slice(0, 4).join("\n");
      recordBogeyDiagnostic({
        userId: typeof sessionUser === "number" ? sessionUser : 0,
        severity: status >= 500 ? "error" : "warn",
        app: "chat",
        code: err.code || `http_${status}`,
        summary: message.slice(0, 500),
        path: `${req.method} ${req.path}`,
        context: { status, stackHead },
      });
    }

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );

  // Background roster sync from bulldog-auth. Cookieless, so it only does real
  // work when SUITE_INTERNAL_SECRET is configured and auth accepts it; without
  // a credential it logs source=none and no-ops. The user-visible guarantee is
  // the /api/org/members deactivated filter — this just keeps the flag fresh.
  syncDeactivatedFromAuth()
    .then((r) => log(`[user-sync] startup checked=${r.checked} deactivated=${r.deactivated} reactivated=${r.reactivated} source=${r.source}`))
    .catch((e) => console.warn("[user-sync] startup error:", e?.message));
  setInterval(() => {
    syncDeactivatedFromAuth().catch(() => {});
  }, 5 * 60 * 1000);
})();

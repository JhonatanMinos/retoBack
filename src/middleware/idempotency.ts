import { Request, RequestHandler } from "express";
import crypto from "crypto";
import { DB } from "../db";
import { ApiError } from "../errors";

export type HandlerResult = { status: number; body: unknown };
export type Handler = (req: Request) => Promise<HandlerResult>;

// In-process promise cache: two parallel requests with the same Idempotency-Key
// share the same promise, so the handler runs exactly once.
const inflight = new Map<string, Promise<HandlerResult>>();

function hashBody(body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(body ?? {}))
    .digest("hex");
}

export function idempotencyMiddleware(
  db: DB,
  handler: Handler,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = req.header("Idempotency-Key");

      // No key → just run the handler
      if (!key) {
        const result = await handler(req);
        res.status(result.status).json(result.body);
        return;
      }

      const compositeKey = `${req.method}:${req.baseUrl}${req.path}:${key}`;
      const bodyHash = hashBody(req.body);

      // 1. Fast path: replay from DB
      const stored = db
        .prepare(
          "SELECT body_hash, response_status, response_body FROM idempotency_keys WHERE key = ?",
        )
        .get(compositeKey) as
        | {
            body_hash: string;
            response_status: number | null;
            response_body: string | null;
          }
        | undefined;

      if (stored) {
        if (stored.body_hash !== bodyHash) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key reused with a different request body",
          );
        }
        if (stored.response_status !== null && stored.response_body !== null) {
          res
            .status(stored.response_status)
            .json(JSON.parse(stored.response_body));
          return;
        }
      }

      // 2. Parallel path: share the same in-flight promise
      let promise = inflight.get(compositeKey);
      if (!promise) {
        promise = (async (): Promise<HandlerResult> => {
          // Reserve the key atomically
          try {
            db.prepare(
              "INSERT INTO idempotency_keys (key, method, path, body_hash) VALUES (?, ?, ?, ?)",
            ).run(compositeKey, req.method, req.baseUrl + req.path, bodyHash);
          } catch {
            // Another process inserted it first — read the cached response
            const replay = db
              .prepare(
                "SELECT body_hash, response_status, response_body FROM idempotency_keys WHERE key = ?",
              )
              .get(compositeKey) as {
              body_hash: string;
              response_status: number | null;
              response_body: string | null;
            };
            if (replay.body_hash !== bodyHash) {
              throw new ApiError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "Idempotency-Key reused with a different request body",
              );
            }
            if (
              replay.response_status !== null &&
              replay.response_body !== null
            ) {
              return {
                status: replay.response_status,
                body: JSON.parse(replay.response_body),
              };
            }
            // Fallback: run the handler (rare race)
            return handler(req);
          }

          const result = await handler(req);

          db.prepare(
            "UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE key = ?",
          ).run(result.status, JSON.stringify(result.body), compositeKey);

          return result;
        })();

        inflight.set(compositeKey, promise);
        promise
          .catch(() => {
            /* swallow — each caller handles its own error */
          })
          .finally(() => {
            // Keep a small window so late parallel waiters hit the same promise
            setTimeout(() => inflight.delete(compositeKey), 3000);
          });
      }

      const result = await promise;
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  };
}

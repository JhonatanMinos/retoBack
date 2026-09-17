import { DBType } from "../db";

const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fire-and-forget notification to NOTIFY_URL with exponential backoff.
 * Every attempt is logged in `notifications` regardless of outcome.
 */
export async function dispatchNotification(
  db: DBType,
  taskId: number,
  title: string,
  archivedAt: string,
): Promise<void> {
  const url = process.env.NOTIFY_URL;
  if (!url) return;

  const baseMs = Number(process.env.NOTIFY_RETRY_BASE_MS ?? 1000);
  const payload = { taskId, title, archivedAt };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 1s, 2s between attempts (configurable base)
    if (attempt > 1) await sleep(baseMs * Math.pow(2, attempt - 2));

    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      statusCode = res.status;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "network error";
    }

    db.prepare(
      "INSERT INTO notifications (task_id, attempt, status_code, error) VALUES (?, ?, ?, ?)",
    ).run(taskId, attempt, statusCode, error);

    // Success or non-retriable 4xx → stop
    if (statusCode !== null && statusCode >= 200 && statusCode < 300) return;
    if (statusCode !== null && statusCode >= 400 && statusCode < 500) return;
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FfmpegRunOutcome =
  | { ok: true }
  | { ok: false; reason: "timeout" | "aborted" | "failed" };

/**
 * Runs a single FFmpeg invocation as an argument array (never a shell
 * string — see ffmpeg-args.ts, which builds these arrays) with a hard
 * timeout and an optional external AbortSignal (used so a lost lease can
 * kill an in-flight encode via lease-renewal.ts's onLeaseLost callback).
 * stdout/stderr are never returned to the caller: FFmpeg's own diagnostic
 * text can be long and is not something this worker needs to persist or log
 * verbatim — failure/timeout/abort classification is all callers act on.
 */
export const runFfmpegProcess = async (
  executablePath: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<FfmpegRunOutcome> => {
  try {
    await execFileAsync(executablePath, args, {
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      signal: options.signal,
      maxBuffer: 16 * 1024 * 1024,
    });

    return { ok: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };

    if (options.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    if (err.killed && err.signal === "SIGKILL") {
      return { ok: false, reason: "timeout" };
    }

    return { ok: false, reason: "failed" };
  }
};

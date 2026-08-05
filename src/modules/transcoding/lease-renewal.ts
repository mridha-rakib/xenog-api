/**
 * Runs `work` while periodically calling `renew` on a fixed interval, so a
 * long-running FFmpeg operation keeps the job's lease alive instead of
 * letting it expire mid-encode and be reclaimed by another worker. If a
 * renewal ever reports the lease is no longer held (another worker already
 * reclaimed it), `onLeaseLost` fires so the caller can abort the in-flight
 * operation — this function itself never throws or cancels `work` directly,
 * it only signals.
 *
 * The interval timer is always cleared, including when `work` throws.
 */
export const runWithPeriodicLeaseRenewal = async <T>(params: {
  intervalMs: number;
  renew: () => Promise<boolean>;
  onLeaseLost: () => void;
  work: () => Promise<T>;
}): Promise<T> => {
  let renewing = false;

  const timer = setInterval(() => {
    if (renewing) {
      return;
    }
    renewing = true;

    void params
      .renew()
      .then((stillOwned) => {
        if (!stillOwned) {
          params.onLeaseLost();
        }
      })
      .catch(() => {
        // A renewal call throwing (e.g. a transient DB error) is treated as
        // "try again next tick", not as lease loss — only an explicit
        // `false` result means another worker provably holds the job now.
      })
      .finally(() => {
        renewing = false;
      });
  }, params.intervalMs);

  try {
    return await params.work();
  } finally {
    clearInterval(timer);
  }
};

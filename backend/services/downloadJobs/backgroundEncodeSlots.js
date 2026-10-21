// A FIFO, cancellation-aware limiter for CPU-heavy background media conversions.
// Deliberately independent of provider download concurrency and interactive streaming.
export class BackgroundEncodeSlots {
  constructor(limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Background encode slot limit must be a positive integer");
    }
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  get stats() {
    return { limit: this.limit, active: this.active, waiting: this.waiters.length };
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve, reject, signal, onAbort: null, granted: false,
      };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.granted) return;
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(abortError());
          this.#drain();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.#drain();
    });
  }

  async run(callback, { signal } = {}) {
    const release = await this.acquire({ signal });
    try {
      if (signal?.aborted) throw abortError();
      return await callback();
    } finally {
      release();
    }
  }

  #drain() {
    while (this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(abortError());
        continue;
      }
      waiter.granted = true;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.#drain();
      });
    }
  }
}

function abortError() {
  const error = new Error("Background encoding cancelled while waiting for capacity");
  error.name = "AbortError";
  error.code = "ENCODE_CANCELLED";
  return error;
}

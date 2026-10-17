/**
 * Framework-neutral coalescing progress reporter.
 *
 * Wire `publish` to interaction.editReply(), edit_original_response(), or
 * another transport boundary. Adapt this file to the target repository.
 */
export class ProgressReporter {
  #publish;
  #validate;
  #onError;
  #minIntervalMs;
  #now;
  #setTimer;
  #clearTimer;
  #latest = Object.freeze({});
  #version = 0;
  #publishedVersion = 0;
  #lastPublishedAt = Number.NEGATIVE_INFINITY;
  #timer = null;
  #publishing = null;
  #lastError = null;
  #closed = false;

  constructor({
    publish,
    minIntervalMs = 1_000,
    validate = validateProgressState,
    onError = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (typeof publish !== "function") throw new TypeError("publish must be a function");
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError("minIntervalMs must be a non-negative number");
    }

    this.#publish = publish;
    this.#validate = validate;
    this.#onError = onError;
    this.#minIntervalMs = minIntervalMs;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  get state() {
    return this.#latest;
  }

  get pending() {
    return this.#publishedVersion < this.#version;
  }

  phase(name, patch = {}) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("phase name must be a non-empty string");
    }
    return this.update({ ...patch, phase: name });
  }

  update(patch) {
    if (this.#closed) throw new Error("progress reporter is closed");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("progress patch must be an object");
    }

    const next = Object.freeze({ ...this.#latest, ...patch });
    this.#validate?.(next, this.#latest);
    this.#latest = next;
    this.#version += 1;
    this.#schedule();
    return this;
  }

  async flush() {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }

    if (this.#lastError) {
      const error = this.#lastError;
      this.#lastError = null;
      throw error;
    }

    while (this.#publishedVersion < this.#version) {
      await this.#publishLatest();
    }
  }

  async finalize(patch = {}) {
    if (this.#closed) throw new Error("progress reporter is closed");
    this.update(patch);
    await this.flush();
    this.close();
  }

  close() {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#closed = true;
  }

  #schedule() {
    if (this.#timer !== null || this.#publishing !== null) return;

    const elapsed = this.#now() - this.#lastPublishedAt;
    const delay = Math.max(0, this.#minIntervalMs - elapsed);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#publishLatest().catch((error) => {
        this.#lastError = error;
        this.#onError(error);
      });
    }, delay);
  }

  async #publishLatest() {
    if (this.#publishing !== null) {
      await this.#publishing;
      return;
    }

    const targetVersion = this.#version;
    const snapshot = this.#latest;
    this.#publishing = Promise.resolve().then(() => this.#publish(snapshot));

    try {
      await this.#publishing;
      this.#publishedVersion = targetVersion;
      this.#lastPublishedAt = this.#now();
      this.#lastError = null;
    } finally {
      this.#publishing = null;
    }

    if (!this.#closed && this.#publishedVersion < this.#version) this.#schedule();
  }
}

export function validateProgressState(next, previous = {}) {
  for (const key of ["completed", "total", "failed", "skipped"]) {
    if (next[key] !== undefined && (!Number.isFinite(next[key]) || next[key] < 0)) {
      throw new RangeError(`${key} must be a non-negative finite number`);
    }
  }

  if (next.total !== undefined && next.completed !== undefined && next.completed > next.total) {
    throw new RangeError("completed cannot exceed total");
  }

  for (const key of ["completed", "failed", "skipped"]) {
    if (previous[key] !== undefined && next[key] !== undefined && next[key] < previous[key]) {
      throw new RangeError(`${key} progress cannot move backwards`);
    }
  }

  const terminalPhases = new Set([
    "empty", "permission_denied", "partial", "success", "succeeded", "failed",
    "cancelled", "timed_out",
  ]);
  if (terminalPhases.has(previous.phase) && next.phase !== previous.phase) {
    throw new Error(`terminal phase ${previous.phase} cannot transition to ${next.phase}`);
  }
}

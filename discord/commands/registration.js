async function registerCommandsWithRetry({ application, payload, delaysMs = [0], wait = null }) {
    if (!application?.commands?.set) throw new Error("COMMAND_APPLICATION_UNAVAILABLE");
    const sleep = wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let lastError = null;
    let attempts = 0;
    for (const delayMs of delaysMs) {
        if (delayMs > 0) await sleep(delayMs);
        attempts++;
        try {
            await application.commands.set(payload);
            return { ok: true, attempts, error: null };
        } catch (err) {
            lastError = err;
        }
    }
    return { ok: false, attempts, error: lastError };
}

module.exports = { registerCommandsWithRetry };

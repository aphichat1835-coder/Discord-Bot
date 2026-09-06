'use strict';

const SCHEDULE_HOURS = Object.freeze([0, 8, 16]);

const RECHECK_COUNT = 3;
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([
    5 * 60 * 1000,
    15 * 60 * 1000,
    30 * 60 * 1000
]);

function transientRetryDelayMs(attempt = 0) {
    const index = Math.max(0, Math.min(TRANSIENT_RETRY_DELAYS_MS.length - 1, attempt));
    return TRANSIENT_RETRY_DELAYS_MS[index];
}

function zonedParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);

    return Object.fromEntries(
        parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
    );
}

function zonedDateTimeToUtc({ year, month, day, hour }, timeZone) {
    const target = Date.UTC(year, month - 1, day, hour, 0, 0);
    let guess = target;

    for (let i = 0; i < 2; i++) {
        const actual = zonedParts(new Date(guess), timeZone);
        const actualAsUtc = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour,
            actual.minute,
            actual.second
        );
        guess += target - actualAsUtc;
    }

    return new Date(guess);
}

function addLocalDays({ year, month, day }, days) {
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
    };
}

function nextDailyTime(hour, now = new Date(), timeZone = 'Asia/Bangkok') {
    const local = zonedParts(now, timeZone);
    let candidate = zonedDateTimeToUtc({ ...local, hour }, timeZone);
    if (candidate.getTime() <= now.getTime()) {
        candidate = zonedDateTimeToUtc({ ...addLocalDays(local, 1), hour }, timeZone);
    }
    return candidate;
}

function addScheduleJitter(date, random = Math.random, maxJitterMs = 60_000) {
    const jitter = Math.floor(Math.max(0, Math.min(1, random())) * maxJitterMs);
    return new Date(date.getTime() + jitter);
}

function nextScheduledCheck(now = new Date(), timeZone = 'Asia/Bangkok') {
    const local = zonedParts(now, timeZone);

    for (const hour of SCHEDULE_HOURS) {
        const candidate = zonedDateTimeToUtc({ ...local, hour }, timeZone);
        if (candidate.getTime() > now.getTime()) return candidate;
    }

    const tomorrow = addLocalDays(local, 1);
    return zonedDateTimeToUtc({ ...tomorrow, hour: SCHEDULE_HOURS[0] }, timeZone);
}

function nextRecheckState({
    isRecheck = false,
    rechecksRemaining = 0,
    attempted = false,
    progressed = false
} = {}) {
    let remaining = rechecksRemaining;

    if (progressed || (!isRecheck && attempted)) {
        remaining = RECHECK_COUNT;
    } else if (isRecheck && remaining > 0) {
        remaining -= 1;
    }

    return {
        rechecksRemaining: remaining,
        shouldRecheck: remaining > 0,
        delayMs: remaining > 0 ? RECHECK_INTERVAL_MS : 0
    };
}

function formatScheduleTime(date, timeZone = 'Asia/Bangkok') {
    if (!date) return '-';
    const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
    if (!Number.isFinite(d.getTime())) return '-';
    return d.toLocaleString('th-TH', { timeZone, hour12: false });
}

module.exports = {
    SCHEDULE_HOURS,
    RECHECK_COUNT,
    RECHECK_INTERVAL_MS,
    transientRetryDelayMs,
    nextDailyTime,
    addScheduleJitter,
    nextScheduledCheck,
    nextRecheckState,
    formatScheduleTime
};

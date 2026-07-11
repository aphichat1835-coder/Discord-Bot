"use strict";

const lifecycle = require("../discord/verification/lifecycle");

describe("verification runtime lifecycle", () => {
    afterEach(async () => {
        await lifecycle.stopVerificationRuntime();
    });

    test("serializes concurrent startup and clears the only interval on stop", async () => {
        let finishStartup;
        const maintenanceRunner = jest.fn(() => new Promise(resolve => { finishStartup = resolve; }));
        const timer = { unref: jest.fn() };
        const setIntervalFn = jest.fn(() => timer);
        const clearIntervalFn = jest.fn();
        const options = { maintenanceRunner, setIntervalFn, clearIntervalFn };

        const first = lifecycle.startVerificationRuntime(options);
        const second = lifecycle.startVerificationRuntime(options);
        expect(maintenanceRunner).toHaveBeenCalledTimes(1);
        finishStartup({ ok: true });
        await Promise.all([first, second]);

        expect(setIntervalFn).toHaveBeenCalledTimes(1);
        expect(timer.unref).toHaveBeenCalledTimes(1);
        await lifecycle.stopVerificationRuntime();
        expect(clearIntervalFn).toHaveBeenCalledTimes(1);
        expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    });
});

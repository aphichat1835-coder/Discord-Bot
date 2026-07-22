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

    test("does not schedule background work until initial maintenance succeeds", async () => {
        const startupError = new Error("temporary database failure");
        const maintenanceRunner = jest.fn()
            .mockRejectedValueOnce(startupError)
            .mockResolvedValue({ ok: true });
        const timer = { unref: jest.fn() };
        const setIntervalFn = jest.fn(() => timer);
        const clearIntervalFn = jest.fn();

        await expect(lifecycle.startVerificationRuntime({
            maintenanceRunner,
            setIntervalFn,
            clearIntervalFn
        })).rejects.toThrow("temporary database failure");

        expect(setIntervalFn).not.toHaveBeenCalled();
        expect(lifecycle.getVerificationDiagnostics().timerActive).toBe(false);

        await lifecycle.startVerificationRuntime({ maintenanceRunner, setIntervalFn, clearIntervalFn });
        expect(maintenanceRunner).toHaveBeenCalledTimes(2);
        expect(setIntervalFn).toHaveBeenCalledTimes(1);
        expect(lifecycle.getVerificationDiagnostics().timerActive).toBe(true);

        await lifecycle.stopVerificationRuntime();
        expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    });
});

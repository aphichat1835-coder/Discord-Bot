const state = require("../discord/verification/utils/state");

function withSecret(fn) {
    const old = process.env.VERIFY_STATE_SECRET;
    process.env.VERIFY_STATE_SECRET = "state-test-secret";
    try {
        return fn();
    } finally {
        if (old === undefined) delete process.env.VERIFY_STATE_SECRET;
        else process.env.VERIFY_STATE_SECRET = old;
    }
}

test("signed JSON state round-trips and rejects tampering", () => withSecret(() => {
    const token = state.encodeSignedState({
        type: "admin-login",
        guildId: "123",
        ts: Date.now()
    });

    expect(state.decodeSignedState(token).guildId).toBe("123");
    expect(state.decodeSignedState(`${token}tampered`)).toBeNull();
}));

test("compact callback state round-trips through shared helper", () => withSecret(() => {
    const token = state.createCompactCallbackState({
        guildId: "111111111111111111",
        roleId: "222222222222222222",
        expectedUserId: null,
        panelRevision: "panel_rev"
    });
    const decoded = state.decodeCallbackState(token);

    expect(decoded.v).toBe(4);
    expect(decoded.guildId).toBe("111111111111111111");
    expect(decoded.roleId).toBe("222222222222222222");
    expect(decoded.panelRevision).toBe("panel_rev");
    expect(decoded.mode).toBe("compact-direct-oauth-panel-revision");
}));


test("verification state signing fails closed without its dedicated secret", () => {
    const names = [
        "VERIFY_STATE_SECRET",
        "API_SECRET",
        "INTERNAL_API_SECRET",
        "SESSION_SECRET",
        "ENCRYPTION_KEY"
    ];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
        delete process.env.VERIFY_STATE_SECRET;
        process.env.API_SECRET = "must-not-be-used";
        process.env.INTERNAL_API_SECRET = "must-not-be-used";
        process.env.SESSION_SECRET = "must-not-be-used";
        process.env.ENCRYPTION_KEY = "must-not-be-used";
        expect(() => state.encodeSignedState({ guildId: "123" })).toThrow("Missing VERIFY_STATE_SECRET");
    } finally {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});

process.env.SESSION_SECRET = "test-secret-for-csrf-unit-tests";

const { makeCsrfToken, setCsrfCookie, requireCsrf, CSRF_COOKIE } = require("../utils/csrf");

describe("CSRF constants", () => {
    it("CSRF_COOKIE name is csrf_pub", () => {
        expect(CSRF_COOKIE).toBe("csrf_pub");
    });
});

describe("makeCsrfToken", () => {
    it("returns empty string when sessionId is missing", () => {
        expect(makeCsrfToken("")).toBe("");
        expect(makeCsrfToken(null)).toBe("");
        expect(makeCsrfToken(undefined)).toBe("");
    });

    it("returns 64-char hex string for valid sessionId", () => {
        const token = makeCsrfToken("session-abc-123");
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same sessionId", () => {
        expect(makeCsrfToken("same-session")).toBe(makeCsrfToken("same-session"));
    });

    it("produces different tokens for different sessions", () => {
        expect(makeCsrfToken("session-one")).not.toBe(makeCsrfToken("session-two"));
    });

    it("returns empty string when no secret env is set", () => {
        const saved = {
            SESSION_SECRET: process.env.SESSION_SECRET,
            API_SECRET: process.env.API_SECRET,
            ENCRYPTION_KEY: process.env.ENCRYPTION_KEY
        };
        try {
            delete process.env.SESSION_SECRET;
            delete process.env.API_SECRET;
            delete process.env.ENCRYPTION_KEY;
            expect(makeCsrfToken("some-session")).toBe("");
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
});

describe("setCsrfCookie", () => {
    it("does nothing when session has no id", () => {
        const headers = [];
        setCsrfCookie({ session: {} }, { append: (k, v) => headers.push({ k, v }) });
        expect(headers).toHaveLength(0);
    });

    it("does nothing when session is absent", () => {
        const headers = [];
        setCsrfCookie({}, { append: (k, v) => headers.push({ k, v }) });
        expect(headers).toHaveLength(0);
    });

    it("appends Set-Cookie header with SameSite=Strict when session id exists", () => {
        const headers = [];
        setCsrfCookie(
            { session: { id: "sess-test-001" } },
            { append: (k, v) => headers.push({ k, v }) }
        );
        expect(headers).toHaveLength(1);
        expect(headers[0].k).toBe("Set-Cookie");
        expect(headers[0].v).toContain(`${CSRF_COOKIE}=`);
        expect(headers[0].v).toContain("SameSite=Strict");
        expect(headers[0].v).toContain("Path=/");
    });

    it("does not set Secure flag outside production", () => {
        const orig = process.env.NODE_ENV;
        try {
            delete process.env.NODE_ENV;
            const headers = [];
            setCsrfCookie({ session: { id: "sess-dev" } }, { append: (k, v) => headers.push({ k, v }) });
            expect(headers[0].v).not.toContain("; Secure");
        } finally {
            if (orig === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = orig;
        }
    });
});

describe("requireCsrf middleware", () => {
    it("passes GET requests without token", () => {
        const next = jest.fn();
        requireCsrf({ method: "GET", session: {}, headers: {} }, {}, next);
        expect(next).toHaveBeenCalled();
    });

    it("passes HEAD and OPTIONS without token", () => {
        for (const method of ["HEAD", "OPTIONS"]) {
            const next = jest.fn();
            requireCsrf({ method, session: {}, headers: {} }, {}, next);
            expect(next).toHaveBeenCalled();
        }
    });

    it("rejects POST with missing token — 403 csrf_missing", () => {
        let status = null;
        let body = null;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
        requireCsrf({ method: "POST", session: { id: "s1" }, headers: {} }, res, () => {});
        expect(status).toBe(403);
        expect(body.code).toBe("csrf_missing");
    });

    it("rejects POST with no session — 403 csrf_missing", () => {
        let status = null;
        let body = null;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
        requireCsrf({ method: "POST", session: {}, headers: { "x-csrf-token": "abc" } }, res, () => {});
        expect(status).toBe(403);
        expect(body.code).toBe("csrf_missing");
    });

    it("rejects POST with wrong token — 403 csrf_invalid", () => {
        let status = null;
        let body = null;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
        requireCsrf({ method: "POST", session: { id: "s3" }, headers: { "x-csrf-token": "a".repeat(64) } }, res, () => {});
        expect(status).toBe(403);
        expect(body.code).toBe("csrf_invalid");
    });

    it("allows POST with correct token", () => {
        const sessionId = "valid-session-id";
        const token = makeCsrfToken(sessionId);
        const next = jest.fn();
        requireCsrf({ method: "POST", session: { id: sessionId }, headers: { "x-csrf-token": token } }, {}, next);
        expect(next).toHaveBeenCalled();
    });

    it("rejects PATCH, DELETE, PUT without token — 403", () => {
        for (const method of ["PATCH", "DELETE", "PUT"]) {
            let status = null;
            const res = { status(s) { status = s; return this; }, json() {} };
            requireCsrf({ method, session: { id: "s9" }, headers: {} }, res, () => {});
            expect(status).toBe(403);
        }
    });
});

from pathlib import Path

path = Path("verification-tests/ipIdentityHistory.test.js")
text = path.read_text(encoding="utf-8")
old = '''        expect(history._test.roleEventFilter({ ...base, roles: ["3", "1", "2", "1"] }))
            .toEqual({ eventId: { $in: compatible } });
'''
new = '''        expect(history._test.roleEventIdentity({ ...base, roles: ["3", "1", "2", "1"] })).toEqual({
            guildId: base.guildId,
            ipHash: base.ipHash,
            userId: base.userId,
            roleId: base.roleId,
            result: base.result,
            at: base.at,
            roles: { $all: ["1", "2", "3"], $size: 3 }
        });
        expect(history._test.roleEventFilter({ ...base, roles: ["3", "1", "2", "1"] })).toEqual({
            $or: [
                { eventId: { $in: compatible } },
                history._test.roleEventIdentity({ ...base, roles: ["3", "1", "2", "1"] })
            ]
        });
'''
if text.count(old) != 1:
    raise SystemExit("role expectation anchor mismatch")
text = text.replace(old, new, 1)
marker = '    test("rejects non-snowflake history lookup identifiers before database access", () => {'
if text.count(marker) != 1:
    raise SystemExit("role test insertion anchor mismatch")
before, after = text.split(marker, 1)
before = before.rstrip("\n") + "\n\n\n"
extra = '''    test("role filters match legacy records even when their stored role order differs", () => {
        const base = {
            guildId: "12345678901234567",
            ipHash: "ip-hash",
            userId: "22345678901234567",
            roleId: "32345678901234567",
            result: "success",
            at: 100,
            roles: ["3", "1", "2"]
        };
        const filter = history._test.roleEventFilter(base);
        expect(filter.$or[1]).toEqual({
            guildId: base.guildId,
            ipHash: base.ipHash,
            userId: base.userId,
            roleId: base.roleId,
            result: base.result,
            at: base.at,
            roles: { $all: ["1", "2", "3"], $size: 3 }
        });
        expect(history._test.roleEventIdentity({ ...base, roles: [] }).roles).toEqual({ $size: 0 });
    });

'''
path.write_text(before + extra + marker + after, encoding="utf-8")

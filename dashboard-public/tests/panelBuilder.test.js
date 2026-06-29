const {
    DEFAULT_PANEL,
    sanitizeText,
    sanitizeUrl,
    parseEmbedColor,
    normalizePanelInput,
    buildOAuthUrl,
    buildEmbed,
    buildPanelPayload,
    buildValidationSummary
} = require("../utils/panelBuilder");

describe("DEFAULT_PANEL", () => {
    it("is frozen and has required fields", () => {
        expect(Object.isFrozen(DEFAULT_PANEL)).toBe(true);
        expect(DEFAULT_PANEL.verifyType).toBe("oauth");
        expect(typeof DEFAULT_PANEL.title).toBe("string");
        expect(typeof DEFAULT_PANEL.description).toBe("string");
        expect(DEFAULT_PANEL.showTimestamp).toBe(false);
    });
});

describe("sanitizeText", () => {
    it("trims whitespace", () => {
        expect(sanitizeText("  hello  ")).toBe("hello");
    });

    it("truncates to max length", () => {
        expect(sanitizeText("a".repeat(3000), 2000).length).toBe(2000);
    });

    it("returns empty string for falsy input", () => {
        expect(sanitizeText("")).toBe("");
        expect(sanitizeText(null)).toBe("");
        expect(sanitizeText(undefined)).toBe("");
    });
});

describe("sanitizeUrl", () => {
    it("accepts valid http and https URLs", () => {
        expect(sanitizeUrl("https://example.com")).toBe("https://example.com/");
        expect(sanitizeUrl("http://example.com/path")).toBe("http://example.com/path");
    });

    it("rejects non-http protocols", () => {
        expect(sanitizeUrl("javascript:alert(1)")).toBe("");
        expect(sanitizeUrl("ftp://example.com")).toBe("");
        expect(sanitizeUrl("data:text/html,<h1>")).toBe("");
    });

    it("returns empty string for empty or invalid input", () => {
        expect(sanitizeUrl("")).toBe("");
        expect(sanitizeUrl(null)).toBe("");
        expect(sanitizeUrl("not-a-url")).toBe("");
    });
});

describe("parseEmbedColor", () => {
    it("accepts #RRGGBB hex", () => {
        expect(parseEmbedColor("#5865F2")).toBe(0x5865f2);
        expect(parseEmbedColor("#000000")).toBe(0);
        expect(parseEmbedColor("#ffffff")).toBe(0xffffff);
    });

    it("accepts 6-digit hex without hash", () => {
        expect(parseEmbedColor("5865F2")).toBe(0x5865f2);
        expect(parseEmbedColor("ff0000")).toBe(0xff0000);
    });

    it("accepts decimal number string", () => {
        expect(parseEmbedColor("5793266")).toBe(0x5865f2);
        expect(parseEmbedColor("0")).toBe(0);
    });

    it("falls back to default color for invalid input", () => {
        expect(parseEmbedColor("")).toBe(0x5865f2);
        expect(parseEmbedColor("invalid")).toBe(0x5865f2);
        expect(parseEmbedColor(null)).toBe(0x5865f2);
        expect(parseEmbedColor("99999999")).toBe(0x5865f2);
    });
});

describe("normalizePanelInput", () => {
    it("fills defaults for empty object", () => {
        const result = normalizePanelInput({});
        expect(result.title).toBe(DEFAULT_PANEL.title);
        expect(result.description).toBe(DEFAULT_PANEL.description);
        expect(result.verifyType).toBe("oauth");
        expect(result.showTimestamp).toBe(false);
    });

    it("overrides defaults with provided values", () => {
        const result = normalizePanelInput({ title: "My Panel", description: "Custom desc" });
        expect(result.title).toBe("My Panel");
        expect(result.description).toBe("Custom desc");
    });

    it("falls back to default title when blank", () => {
        expect(normalizePanelInput({ title: "   " }).title).toBe(DEFAULT_PANEL.title);
    });

    it("keeps buttonText and buttonLabel in sync", () => {
        const result = normalizePanelInput({ buttonText: "Click me" });
        expect(result.buttonText).toBe("Click me");
        expect(result.buttonLabel).toBe("Click me");
    });

    it("resolves image alias to imageUrl", () => {
        const result = normalizePanelInput({ image: "https://example.com/img.png" });
        expect(result.imageUrl).toBe("https://example.com/img.png");
    });

    it("sanitizes URLs and rejects dangerous protocols", () => {
        const result = normalizePanelInput({
            imageUrl: "javascript:evil()",
            thumbnailUrl: "https://example.com/thumb.png",
            titleUrl: "https://example.com"
        });
        expect(result.imageUrl).toBe("");
        expect(result.thumbnailUrl).toBe("https://example.com/thumb.png");
        expect(result.titleUrl).toBe("https://example.com/");
    });

    it("coerces showTimestamp to boolean", () => {
        expect(normalizePanelInput({ showTimestamp: 1 }).showTimestamp).toBe(true);
        expect(normalizePanelInput({ showTimestamp: 0 }).showTimestamp).toBe(false);
    });
});

describe("buildOAuthUrl", () => {
    it("returns correct URL with state", () => {
        expect(buildOAuthUrl({ baseUrl: "https://bot.example.com", state: "guild-123" }))
            .toBe("https://bot.example.com/auth/discord?state=guild-123");
    });

    it("strips trailing slashes from baseUrl", () => {
        expect(buildOAuthUrl({ baseUrl: "https://bot.example.com///", state: "abc" }))
            .toBe("https://bot.example.com/auth/discord?state=abc");
    });

    it("returns empty string when baseUrl or state is missing", () => {
        expect(buildOAuthUrl({ baseUrl: "", state: "abc" })).toBe("");
        expect(buildOAuthUrl({ baseUrl: "https://example.com", state: "" })).toBe("");
        expect(buildOAuthUrl({})).toBe("");
    });

    it("encodes special characters in state", () => {
        const url = buildOAuthUrl({ baseUrl: "https://example.com", state: "guild/123&x=y" });
        expect(url).toContain("guild%2F123%26x%3Dy");
    });
});

describe("buildEmbed", () => {
    it("returns object with title, description, and color", () => {
        const panel = normalizePanelInput({ title: "T", description: "D", color: "#ff0000" });
        const embed = buildEmbed(panel);
        expect(embed.title).toBe("T");
        expect(embed.description).toBe("D");
        expect(embed.color).toBe(0xff0000);
        expect(embed.image).toBeUndefined();
        expect(embed.timestamp).toBeUndefined();
    });

    it("includes image when imageUrl is set", () => {
        const panel = normalizePanelInput({ imageUrl: "https://example.com/img.png" });
        expect(buildEmbed(panel).image.url).toBe("https://example.com/img.png");
    });

    it("includes thumbnail when thumbnailUrl is set", () => {
        const panel = normalizePanelInput({ thumbnailUrl: "https://example.com/thumb.png" });
        expect(buildEmbed(panel).thumbnail.url).toBe("https://example.com/thumb.png");
    });

    it("includes ISO timestamp when showTimestamp is true", () => {
        const panel = normalizePanelInput({ showTimestamp: true });
        const embed = buildEmbed(panel);
        expect(typeof embed.timestamp).toBe("string");
        expect(Number.isNaN(Date.parse(embed.timestamp))).toBe(false);
    });

    it("includes footer when footerText is set", () => {
        const panel = normalizePanelInput({ footerText: "My Footer" });
        expect(buildEmbed(panel).footer.text).toBe("My Footer");
    });

    it("includes url when titleUrl is set", () => {
        const panel = normalizePanelInput({ titleUrl: "https://example.com" });
        expect(buildEmbed(panel).url).toBe("https://example.com/");
    });
});

describe("buildPanelPayload", () => {
    it("returns valid Discord message payload shape", () => {
        const payload = buildPanelPayload({
            panel: { title: "Test", description: "Desc" },
            oauthUrl: "https://example.com/auth"
        });
        expect(Array.isArray(payload.embeds)).toBe(true);
        expect(payload.embeds.length).toBe(1);
        expect(Array.isArray(payload.components)).toBe(true);
        expect(payload.components[0].type).toBe(1);
        expect("allowed_mentions" in payload).toBe(true);
    });

    it("oauth mode: button has url when oauthUrl is valid", () => {
        const payload = buildPanelPayload({
            panel: { verifyType: "oauth" },
            oauthUrl: "https://example.com/auth/discord?state=abc"
        });
        const button = payload.components[0].components[0];
        expect(button.style).toBe(5);
        expect(button.url).toBeTruthy();
        expect(button.custom_id).toBeUndefined();
    });

    it("oauth mode: disabled button when oauthUrl is missing", () => {
        const payload = buildPanelPayload({ panel: { verifyType: "oauth" }, oauthUrl: "" });
        const button = payload.components[0].components[0];
        expect(button.disabled).toBe(true);
        expect(button.custom_id).toBe("verify_oauth_url_missing");
    });

    it("direct mode: button has custom_id and no url", () => {
        const payload = buildPanelPayload({
            panel: { verifyType: "direct" },
            directCustomId: "verify_role_abc"
        });
        const button = payload.components[0].components[0];
        expect(button.style).toBe(3);
        expect(button.custom_id).toBe("verify_role_abc");
        expect(button.url).toBeUndefined();
    });
});

describe("buildValidationSummary", () => {
    it("ok=true when all checks pass and no errors", () => {
        expect(buildValidationSummary({ ok: true, checks: [{ ok: true }], warnings: [], errors: [] }).ok).toBe(true);
    });

    it("ok=false when errors array is non-empty", () => {
        expect(buildValidationSummary({ ok: true, checks: [], warnings: [], errors: ["fail"] }).ok).toBe(false);
    });

    it("ok=false when any check has ok=false", () => {
        expect(buildValidationSummary({ ok: true, checks: [{ ok: false }], warnings: [], errors: [] }).ok).toBe(false);
    });

    it("ok=false when top-level ok is falsy", () => {
        expect(buildValidationSummary({ ok: false, checks: [], warnings: [], errors: [] }).ok).toBe(false);
    });
});

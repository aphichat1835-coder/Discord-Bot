# Bundled tooling catalog

Use the unified `scripts/discord_engineer.py` CLI first. Run a focused standalone tool only when its evidence boundary matches the task:

- `ux plan|compose|compare`: select a panel/direction from job context, build a reviewable Components V2 payload, and reject structurally duplicated variants. See `discord-visual-system.md`.

- `scripts/analyze_typescript.mjs`: TypeScript compiler/type-checker graph and diagnostics.
- `scripts/audit_discord_project.py`: lightweight Discord source review.
- `scripts/inspect_discord_project.py`: legacy detailed inventory when the central Project Model lacks a field.
- `scripts/audit_locale_catalogs.py`: locale key, placeholder, whitespace, and Markdown drift.
- `scripts/validate_experience_snapshot.py`: state/progress/control snapshot validation.
- `scripts/preview_experience.py`: static approximation for review, never Discord-client proof.
- `scripts/validate_benchmarks.py`: benchmark manifest integrity.

Reusable implementation material lives in `assets/examples/catalog.json`; coalescing progress helpers are `assets/patterns/progress-reporter.mjs` and `assets/patterns/progress_reporter.py`. Copy only the relevant pattern and adapt it to installed framework types and repository conventions.

Manifests in `assets/manifests/` are executable policy inputs where wired into the engine. Schemas in `assets/schemas/` define artifact contracts. A manifest or schema existing on disk is not proof that a workflow ran; the receipt must name the command and result.

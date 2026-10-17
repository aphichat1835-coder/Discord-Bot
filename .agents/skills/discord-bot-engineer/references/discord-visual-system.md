# Discord Visual System

Use this reference when creating or redesigning Discord messages, panels, controls, forms, or command flows. This is a selection system, not a mandate to put every component in every response.

## Decision sequence

1. Name the user job, decision, risk, frequency, and expected duration.
2. Choose the smallest panel archetype that makes the job clear. Do not default to a Container merely because it looks finished.
3. Choose native controls by data type: buttons for actions, string select for bounded authored choices, entity selects for users/roles/channels/mentionables, and a modal for structured input.
4. Establish hierarchy before decoration: primary truth, status/impact, next action, then details.
5. Apply one visual direction and the project Taste Profile. Preserve Discord-native behavior.
6. Write copy to its placement: short control labels, concise state headlines, sufficient summaries, complete recovery and confirmation text, diagnostics on demand.
7. Define initial, loading, partial, success, empty, denied, failed, cancelled, timed-out, expired, and stale states only where reachable.
8. Render realistic Thai/English, long values, narrow clients, missing media, and disabled/expired controls. Compare sibling commands before acceptance.

Run:

```bash
python3 scripts/discord_engineer.py ux plan "<job>" --command-type <type> --taste <taste.json> --output plan.json
python3 scripts/discord_engineer.py ux compose <components-spec.json> --output payload.json
python3 scripts/discord_engineer.py ux compare <plan-a.json> <plan-b.json>
```

The plan exposes the selected panel, alternatives, direction, recipe, component palette, copy contract, state contract, variation fingerprint, and proof needed. Override `--panel` only when the default command pattern does not match the actual job.

## Panel families

- **Read/understand:** result, detail inspector, announcement, transaction receipt, audit timeline, permission matrix, help command center.
- **Act safely:** destructive confirmation, review summary, approval, requirements, error recovery.
- **Work over time:** operational status, queue job, live monitor.
- **Choose/browse:** selection, entity picker, pagination browser, filter/sort.
- **Configure/input:** settings, form modal, multi-step form, onboarding wizard.
- **Media/community:** media player and media-rich announcement.
- **Boundary states:** empty state, partial result, permission denied, expired, cancelled, timed out, stale.

Choose by information and interaction shape—not command name alone. A moderation lookup may be an inspector; a moderation purge needs destructive confirmation followed by operational status and a result. One command may transition between archetypes while keeping one response owner.

## Native component coverage

The component palette includes every currently documented Discord component type: Action Row, Button, String Select, Text Input, User/Role/Mentionable/Channel Select, Section, Text Display, Thumbnail, Media Gallery, File, Separator, Container, Label, File Upload, Radio Group, Checkbox Group, and Checkbox. Message and modal components are not interchangeable.

Components V2 messages require the flag `1 << 15`; traditional `content` and `embeds` no longer work on that message, attachments must be exposed through components, and a message may contain at most 40 components. An Action Row holds up to five buttons or one select. Put modal inputs inside Label; the old Action Row + Text Input pattern is deprecated.

Use one primary action when actions have unequal weight. Danger means consequential/destructive action, not generic red decoration. Premium buttons require a SKU and are not ordinary interactions. Bind interactive IDs to actor/session/state, acknowledge once, disable or expire terminal controls, and prevent stale handlers from overwriting newer state.

## Taste without template sameness

A Taste Profile records approved evidence, not vague adjectives. Capture:

- preferred and rejected directions;
- density and brand intensity;
- recurring composition, copy, icon, media, and accent choices;
- examples the user approved and the specific reason;
- patterns to avoid, including repeated AI-like phrasing or identical layouts across unrelated commands.

Validate a profile with `taste-profile.schema.json`. A profile may guide selection but cannot override accessibility, semantic status, security, or platform constraints. Generate at least two materially different directions for a major redesign. Reject variants that only swap color or emoji while preserving the same hierarchy.

## Feedback, motion, and perceived performance

Discord message UX has state transitions rather than freeform animation. Acknowledge immediately, show an honest phase, update at meaningful milestones, preserve partial truth, and settle into one terminal state. Avoid message spam, fake percentages, decorative spinners on instant work, and updates too frequent to read.

Use dashboard motion only when it explains hierarchy, continuity, causality, progress, onboarding, or spatial change. Respect reduced motion. Motion must not delay input or conceal failure.

## Acceptance gate

Do not call the experience good from JSON alone. Require schema/component validity, complete reachable states, truthful progress, action ownership/expiry, accessibility, localization stress, rendered wide/narrow review, sibling-command comparison, and explicit direction acceptance for major redesigns. Beauty remains a human judgment; report structural validation separately from rendered and user-accepted quality.

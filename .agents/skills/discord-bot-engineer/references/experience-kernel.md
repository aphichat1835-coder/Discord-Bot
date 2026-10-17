# Discord experience kernel

## Contents

- Decision inputs
- Surface selection
- Panel system
- Hierarchy and actions
- States and feedback
- Copy, localization, and onboarding

## Decision inputs

Compile user job, audience, frequency, risk, information density, action count, state complexity, latency, reversibility, platform capability, brand intensity, and accessibility into an explicit UX decision. Do not begin with color, emoji, gradient, or animation.

## Surface selection

- Plain text: short facts, conversation, simple errors.
- Embed: structured read-only summaries and semantic accent rail.
- Legacy components: compact established interactions.
- Components V2: structured messages/control panels using current supported component contracts.
- Modal: focused short input, not hidden scope or long documents.
- Ephemeral: actor-specific setup/control/errors, never authorization.
- Dashboard: dense persistent searchable or multi-step management.

Verify current Discord component behavior before composing payloads. Discord-native messages do not provide arbitrary CSS or motion; simulate no dashboard behavior through rapid edits.

## Panel system

Select one primary archetype from the manifest:

- operational status;
- destructive confirmation;
- selection;
- settings;
- review/summary;
- result;
- error/recovery;
- requirements/permissions;
- queue/job;
- onboarding wizard;
- empty state;
- detail inspector.

Compose only necessary anatomy: semantic accent, context, title, summary, primary facts, status/progress, secondary detail, warnings, actions, metadata.

## Hierarchy and actions

Lead with current truth and the next decision. Use progressive disclosure for advanced options and diagnostics. Keep data and actions distinguishable, preserve the location of important state, and test long Thai/English names and mobile scanning.

Use one primary action per decision surface. Distinguish secondary, destructive, tertiary, dismiss, disabled, and pending. A destructive action needs scope, consequence, safe escape, and fresh authorization.

Accent colors are semantic neutral/info/success/warning/destructive/disabled/brand roles. Meaning must survive without color or emoji.

## States and feedback

Design all reachable states: acknowledged, confirming, working, waiting, empty, denied, conflict, partial, success, failure, cancelled, timeout, stale/expired, and retry where real.

Feedback must be immediate enough to confirm input, tied to the affected action/content, and limited to one dominant status. Show determinate progress only from real totals. Separate scanned, eligible, processed, succeeded, skipped, and failed. Stop writers and disable stale controls at terminal state.

## Copy, localization, and onboarding

Match copy density to placement and purpose. A button label or loading headline should usually be short—`✨ กำลังดำเนินการ โปรดรอสักครู่...` can be ideal there. A panel summary may need enough context to explain the current truth. Error recovery and destructive confirmation must communicate cause or uncertainty, impact, scope, safe action, and escape. Supporting detail and diagnostics may be long when they help a decision or investigation. Use hierarchy and progressive disclosure instead of forcing every message to be short or every state into a report. Taste is proportion, not brevity.

Emoji is allowed for tone, scanability, semantic cues, and brand character. Review indiscriminate repetition, tone that conflicts with risk, or meaning that disappears without the emoji; never reject purposeful emoji-led copy by default. Prevent accidental mentions and unsafe Markdown. Use semantic locale keys, formatter-compatible placeholders, locale-aware formatting, natural Thai order, consistent terminology, and explicit fallback.

Onboarding should be benefit-led, short, contextual, and progressive. Use one-time welcome only for a genuinely new experience, contextual help at the point of need, a resumable wizard for required multi-step setup, and actionable empty states. Avoid repeated welcome, passive tours, surprise requirements, and animation without action.

For design research, synthesize a project fingerprint from multiple compatible sources; do not clone one product or use popularity as usability proof. Use [Discord Components](https://docs.discord.com/developers/components/reference), [Fluent onboarding](https://fluent2.microsoft.design/onboarding), and [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) as current evidence when relevant.

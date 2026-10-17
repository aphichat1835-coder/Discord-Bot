# Design research and reference discovery

## Contents

- Research posture
- Source lanes
- Research workflow
- Extracting design DNA
- Reference evaluation
- Discord translation
- Source registry
- Search stop and fallback

## Research posture

Use design research to train judgment for the current brief, not to outsource taste to popularity. Separate three questions:

1. **What works?** Use research, platform guidance, accessibility standards, and production patterns.
2. **What fits?** Use the audience, job, product character, constraints, and existing system.
3. **What feels distinctive?** Use curated visual references, typography, motion, and a justified creative direction.

Never infer usability from visual awards or stars. Never infer originality from novelty alone. Do not copy pixels, protected assets, distinctive copy, or a complete visual identity. Extract principles, combine multiple sources, and produce a new fingerprint for the user's product.

## Source lanes

Research only the lanes that can change the decision:

| Lane | Question | Preferred sources |
| --- | --- | --- |
| Platform truth | What can Discord or the installed framework actually render and update? | current Discord docs, framework docs/source/types |
| UX evidence | What feedback, loading, error, accessibility, or control pattern works? | W3C/WAI, Nielsen Norman Group, platform HIG, mature design systems |
| Production flow | How do real products structure this task across states? | Page Flows, Mobbin, maintained production examples, product documentation |
| Visual direction | What structures, palettes, density, and art direction match the tone? | SiteInspire, Awwwards, Recent, relevant studios/products |
| Typography | What type relationships express the character and remain readable? | Typewolf, Fonts In Use, foundry specimens, existing project fonts |
| Motion craft | What movement vocabulary, timing, and physical behavior fit? | Apple HIG, Material, animations.dev/Emil Kowalski, real product recordings |
| Microcopy | How should status, errors, buttons, empty states, and recovery sound? | UX writing references, established product voice, real user language |
| Anti-patterns | What makes this result generic, inaccessible, misleading, or costly? | Hallmark, Anthropic frontend-design, Impeccable, Vercel guidelines, audits/tests |

Visual galleries are inspiration sources, not authorities. Community skills are heuristics, not platform specifications. Verify technical claims against current official documentation and the installed version.

## Research workflow

1. **Read local evidence first.** Inspect existing tokens, components, embeds, messages, copy helpers, screenshots, fonts, motion dependencies, dashboards, and user-provided references.
2. **Write the gap.** Examples: “Need a compact visual grammar for destructive moderation progress” or “Need a technical-but-human dashboard direction that preserves the current navy palette.”
3. **Choose lanes.** Do not browse every registry. Select one authoritative UX source and one or two relevant visual/flow sources when that is enough.
4. **Build narrow queries.** Combine surface + task + state + tone. Examples:
   - `bulk delete progress cancellation UX pattern`
   - `technical dashboard dense dark typography design inspiration`
   - `Discord Components V2 container accent color current docs`
   - `error message partial completion retry UX writing`
5. **Open the real artifact.** Inspect the exact guideline, product flow, live page, screenshot sequence, or source file rather than relying on a search snippet.
6. **Extract DNA.** Record principles and relationships, not a shopping list of effects.
7. **Triangulate.** For a high-impact direction, combine functional evidence, a real flow, and visual inspiration. Resolve contradictions in favor of usability, platform constraints, and the user's intent.
8. **Translate.** Re-express the principles using the target project's tokens, surfaces, language, and implementation boundaries.
9. **Validate.** Render or run the result when possible; compare against the brief, anti-references, accessibility, performance, and the anti-generic review.
10. **Stop.** Additional browsing must be able to change the decision, not merely produce more moodboard items.

Do not browse for a tiny copy edit when project voice and state are already clear. Do browse when the user requests research, provides a reference URL, rejects generic design, asks for a new visual direction, or when current platform capability changes the solution.

## Extracting design DNA

For each useful reference, capture only applicable dimensions:

- **Purpose and audience:** what job and emotional context shaped it?
- **Macrostructure:** how are major regions sequenced and proportioned?
- **Information hierarchy:** what is primary, supporting, metadata, and action?
- **Density and rhythm:** compact or spacious; regular or deliberately broken?
- **Typography:** contrast of display/body/mono, scale, width, weight, leading, tracking.
- **Palette roles:** dominant neutral, accent, semantic states, contrast behavior—not just hex values.
- **Shape and depth:** edges, borders, radii, shadows, layers, containers, separators.
- **Component behavior:** default, hover, focus, active, disabled, loading, success, error.
- **Motion:** purpose, origin, distance, easing family, duration class, staggering, interruptibility.
- **Copy:** sentence shape, vocabulary, directness, warmth, humor, evidence, calls to action.
- **Signature detail:** the one memorable device and why it belongs to that subject.
- **Anti-pattern:** what should not be transferred because it is decorative, inaccessible, slow, or too identity-specific?

Synthesize into a direction statement:

> For **[audience/job]**, use **[structural principle]** with **[hierarchy/density]**, **[type relationship]**, and **[state/motion behavior]**. Preserve **[existing product signals]**. Avoid **[anti-references/defaults]**. The signature detail is **[new, justified device]** because **[reason]**.

If the user supplies one admired site, do not clone it. Identify its DNA, then combine it with at least one functional source and the user's own content. If the source is inaccessible, ask for a screenshot only when visual inspection is necessary; otherwise continue with available evidence.

## Reference evaluation

Score a candidate before using it:

| Dimension | Check |
| --- | --- |
| Relevance | same audience, job, surface, information density, or emotional context |
| Authenticity | real content and states rather than a context-free concept shot |
| Currency | still reflects current platform capabilities and conventions where that matters |
| Usability | hierarchy, feedback, recovery, and controls remain understandable |
| Accessibility | contrast, focus, semantics, motion reduction, and non-color cues are plausible |
| Feasibility | fits Discord constraints, framework, performance budget, and delivery scope |
| Originality | provides principles to synthesize rather than a template to copy |
| Rights | assets, fonts, code, copy, and licenses can be used or safely substituted |

Popularity, awards, and visual novelty are weak signals by themselves. A beautiful marketing page may be a poor model for an admin dashboard. A production flow may be usable but visually wrong for the user's brand. Use each reference for the lane it can actually support.

## Discord translation

Translate web and product patterns into Discord-native equivalents:

| Product pattern | Discord translation |
| --- | --- |
| Page hierarchy | container/embed structure, title, summary, details, actions |
| Toast/status banner | ephemeral reply or edited operational message |
| Progress bar | real `completed / total`, meaningful steps, or honest indeterminate phase |
| Disabled/loading button | component disabled or replaced while the operation runs |
| Modal form | Discord modal when inputs are focused and supported |
| Detail drawer | follow-up/ephemeral detail view or a dashboard link when content is dense |
| Undo snackbar | time-bounded undo button only if the side effect is genuinely reversible |
| Motion transition | meaningful message edit or state change, not rapid decorative edits |
| Design tokens | semantic color, emoji, copy, component, and status helpers |

Example synthesis for a bulk-delete command:

- From UX evidence: acknowledge latency, use determinate progress only after eligible count is known, preserve partial results, and offer recovery.
- From production flows: keep a single operation surface with phase, count, cancellation when safe, and final summary.
- From the bot fingerprint: use its danger accent only for confirmation/failure, working accent during deletion, one restrained broom icon, and Thai conversational copy.
- Discord result: defer, confirm destructive scope when required, edit one Components V2 or embed response at meaningful intervals, disable stale controls, then render completed/skipped/failed counts.

## Source registry

Use current pages and inspect the relevant section at task time.

### Platform and accessibility

- `https://docs.discord.com/developers/components/overview`
- `https://docs.discord.com/developers/interactions/receiving-and-responding`
- `https://docs.discord.com/developers/reference#message-formatting`
- `https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html`
- `https://www.w3.org/WAI/ARIA/apg/`

### UX, loading, status, and errors

- `https://www.nngroup.com/articles/progress-indicators/`
- `https://www.nngroup.com/articles/response-times-3-important-limits/`
- `https://www.nngroup.com/articles/error-message-guidelines/`
- `https://m3.material.io/components/progress-indicators/overview`
- `https://carbondesignsystem.com/components/loading/usage/`
- `https://carbondesignsystem.com/patterns/status-indicator-pattern/`

### Motion and interface craft

- `https://developer.apple.com/design/human-interface-guidelines/motion`
- `https://github.com/emilkowalski/skills`
- `https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design`
- `https://github.com/vercel-labs/web-interface-guidelines`

### Anti-generic systems and UX writing

- `https://github.com/Nutlope/hallmark`
- `https://github.com/pbakaus/impeccable`
- `https://github.com/content-designer/ux-writing-skill`

### Production flows and visual references

- `https://pageflows.com/`
- `https://www.mobbin.com/`
- `https://www.siteinspire.com/`
- `https://www.awwwards.com/`
- `http://recent.design/`
- `https://www.designspells.com/`
- `https://www.typewolf.com/`
- `https://fontsinuse.com/`

Do not fetch every source for every task. This registry provides lanes, not a mandatory tour.

## Search stop and fallback

Stop when:

- the functional pattern is supported by authoritative evidence;
- the direction fits the user's brief and anti-references;
- enough DNA has been extracted to make deliberate decisions;
- further examples repeat the same structure or trend;
- implementation or visual testing will answer more than browsing.

If a gallery is blocked, use another curated source or user-provided screenshots. If live motion cannot be inspected, use documented behavior and label timing or feel provisional until rendered. If no references fit, construct a custom direction from the subject, audience, content, and constraints rather than falling back to the default AI aesthetic.

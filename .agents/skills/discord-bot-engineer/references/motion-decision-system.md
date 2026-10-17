# Motion decision system

## Contents

- Boundary
- Motion categories
- Loading and perceived performance
- Accessibility
- Decision gate

## Boundary

Discord message UI is platform-rendered. Use component state, message edits, modals, media, and acknowledgement—not custom CSS, spatial transitions, or rapid-edit animation. Dashboard web UI can use real motion but must preserve context, performance, focus, and reduced-motion alternatives.

## Motion categories

### Micro-interactions

Use for hover/focus/pressed, toggle/select, submit, copy, save, retry, validation, expand/collapse, and pending state. In Discord, express the equivalent through platform controls, disabled states, acknowledgement, or message replacement.

### Structural/hierarchy transitions

Use when information structure changes: list/detail, wizard step, drawer/modal, filter result, settings section, or hierarchy expansion. Preserve continuous anchors and focus.

### Feedback/status

Required for accepted, working, saved, completed, failed, disconnected, and retry states. Communicate with text/icon/shape as well as motion.

### Guided onboarding

Use for genuinely new or required multi-step setup. Keep benefit first, step count/expectation clear, contextual help available, and escape/resume real.

### Spatial/dimensionality

Use only on dashboards where layers, ownership, navigation, or direct manipulation benefit from origin/destination continuity. Do not invent this within Discord messages.

### Animated empty states

Use only when the visual reinforces what can be created and points to the CTA. Prefer static/actionable states for frequent operational emptiness, errors, or constrained Discord surfaces.

### Choreographed/sequential

Reserve for rare hierarchy reveals, wizard milestones, or explanatory transformations. Finish at important content; never delay completion or animate every admin action.

### Emotional/branding

Reserve expressive motion for rare positive milestones. Forbid it in errors, security events, destructive moderation, partial failure, and frequent operations.

## Loading and perceived performance

- Very short wait: avoid loader flicker.
- Short unknown wait: one inline indeterminate indicator with descriptive phase.
- Known total: determinate progress from real counters.
- Structured dashboard initial load: skeleton that preserves layout.
- Multi-phase operation: phase plus counters and partial truth.
- External/queued wait: maintain context and explain what is awaited.

Forbid blank wait, artificial delay, fake percentage, competing indicators, decorative loops, and rapid Discord edits. See [Fluent Wait UX](https://fluent2.microsoft.design/wait-ux) and [Carbon loading](https://carbondesignsystem.com/patterns/loading-pattern/).

## Accessibility

Dashboard motion must honor `prefers-reduced-motion`, retain a static equivalent, preserve focus and reading order, avoid motion-only meaning, flashing, large continuous movement, and unnecessary autoplay. Motion triggered by interaction must be reducible when not essential. See [WCAG animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html), [WCAG status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), and [MDN reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion).

## Decision gate

For every motion proposal answer:

1. What user problem does it solve?
2. Is feedback, continuity, guidance, perceived performance, or rare expression the purpose?
3. Does the surface support it?
4. Is the action frequent, risky, or emotionally sensitive?
5. What is the reduced/static equivalent?
6. Does it preserve focus, context, and performance?
7. Can it be removed without losing understanding? If yes and it adds distraction, remove it.

Use productive motion by default and expressive motion rarely. Motion should often go unnoticed because it supports the task. See [Carbon motion strategy](https://carbondesignsystem.com/elements/motion/resources/).

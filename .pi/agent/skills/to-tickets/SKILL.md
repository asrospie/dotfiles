---
name: to-tickets
description: Break a plan, specification, or conversation into tracer-bullet implementation tickets with explicit blocking dependencies, then save the approved backlog to TICKETS.md. Use when planning work or turning requirements into actionable tickets.
---

# To Tickets

Break a plan, specification, or conversation into **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it. Keep the approved ticket backlog in `TICKETS.md` at the repository root.

## Process

### 1. Gather context

Work from the conversation context. If the user supplies a reference, such as a specification path, issue number, or URL, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If the codebase has not already been explored, inspect it to understand its current state. Use the project's domain glossary and respect relevant ADRs.

Look for prefactoring that makes the implementation easier: make the change easy, then make the easy change.

### 3. Draft vertical slices

Break the work into **tracer-bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every affected layer (schema, API, UI, tests): vertical, not a horizontal layer-only task.
- A completed slice is independently demoable or verifiable.
- Each slice fits in one fresh context window.
- Complete necessary prefactoring first.

</vertical-slice-rules>

Give every ticket its **blocking edges**: the other tickets that must finish before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A wide refactor is a mechanical change with a codebase-wide blast radius, such as renaming a shared symbol or changing a column type. Sequence it as expand-contract:

1. **Expand:** add the new form beside the old without breaking callers.
2. **Migrate:** move call sites in blast-radius-sized batches (for example, by package or directory), with each batch blocked by expand and CI green between batches.
3. **Contract:** remove the old form after every migration batch completes.

If migration batches cannot remain green independently, use an integration branch and add a final integration-and-verification ticket blocked by all batches.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title:** a short descriptive name
- **Blocked by:** tickets that genuinely gate it, if any
- **What it delivers:** the end-to-end behavior made possible

Ask the user:

- Does the granularity feel right (too coarse or too fine)?
- Are the blocking edges correct?
- Should any tickets be merged or split?

Iterate until the user approves the breakdown.

### 5. Save the approved tickets

Write the approved tickets to `TICKETS.md` at the repository root, replacing an existing generated ticket backlog only after preserving or incorporating any user-authored content. Number tickets from `01` in dependency order, with blockers before the tickets they block. Do not create one file per ticket and do not publish to an external tracker unless the user explicitly asks.

Use this format:

```markdown
# Tickets

## 01 — <Ticket title>

**What to build:** The end-to-end behavior this ticket makes work from the user's perspective, not a layer-by-layer implementation list.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

## 02 — <Ticket title>

**What to build:** ...

**Blocked by:** 01 — <Ticket title>

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

Work the **frontier**: tickets whose blockers are all complete. For a linear chain, work top to bottom.

Avoid brittle file paths and code snippets in tickets. Exception: retain a compact prototype snippet when it records a decision more precisely than prose can, and note that it came from the prototype.

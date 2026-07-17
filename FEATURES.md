# Priority 0

- Application deadline capture — normalize a single `application_deadline` per listing,
  populated from Greenhouse's structured field where present and from AI extraction over
  `description_plain` otherwise (Lever, Ashby, and Greenhouse posts without the field).
  Core schema field; also feeds the freshness/quality score (passed deadline = likely
  dead listing). See DECISIONS.md Decision 7.

# Priority 1

- Deadline filter — let users filter listings by application deadline. Marked P1, not P0:
  low-usage/secondary facet by your own read ("most people don't filter by closing date").
  Bump to P0 if you want it in the first search cut.

# Priority 2

# Decisions to remember

- Deadlines have two confidence tiers: Greenhouse's structured field is authoritative;
  AI-extracted deadlines (from `description_plain`) are lower confidence. For now they are
  treated identically in filtering — revisit if false-positive rate is high.
- The extraction model must be prompted to return null (or set an uncertainty flag) when
  it is unsure about a date, to avoid false positives like mistaking a program end date
  ("program runs June 1 – Aug 15") for an application deadline.
- Null deadline is shown as "unknown". Rolling / open-ended deadlines are collapsed into
  the same "unknown" state — the rolling distinction is intentionally not preserved.
- Deadline extraction reuses the same local-model pipeline as grad-year extraction; don't
  build a second extraction path for it.

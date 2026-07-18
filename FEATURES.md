# Priority 0

- Application deadline capture — normalize a single `application_deadline` per listing,
  populated from Greenhouse's structured field where present and from AI extraction over
  `description_plain` otherwise (Lever, Ashby, and Greenhouse posts without the field).
  Core schema field; also feeds the freshness/quality score (passed deadline = likely
  dead listing). See DECISIONS.md Decision 7.

# Priority 1

- Deadline filter — let users filter listings by application deadline. Confirmed P1
  (low-usage/secondary facet — "most people don't filter by closing date").
- Citizenship / work-authorization filter — filter listings by work-auth requirement
  (sponsorship available / no sponsorship / US citizen required / unknown). The
  `citizenship_status` enum column is part of the v1 schema; the filter itself is P1.

# Priority 2

# Decisions to remember

- Deadlines have two confidence tiers: Greenhouse's structured field is authoritative;
  AI-extracted deadlines (from `description_plain`) are lower confidence. For now they are
  treated identically in filtering — revisit if false-positive rate is high.
- The extraction model must be prompted to return null when it is unsure about a date, to
  avoid false positives like mistaking a program end date ("program runs June 1 – Aug 15")
  for an application deadline. No estimated/uncertainty flag is stored — extracted and
  authoritative deadlines are treated identically (bets on ~90%+ extraction accuracy).
- Null deadline is shown as "unknown". Rolling / open-ended deadlines are collapsed into
  the same "unknown" state — the rolling distinction is intentionally not preserved.
- Deadline extraction reuses the same local-model pipeline as grad-year extraction; don't
  build a second extraction path for it.
- `citizenship_status` must be an ENUM, not a boolean — "US citizen required", "no
  sponsorship", "sponsorship available", and "unknown" are distinct states (citizenship ≠
  work authorization ≠ visa sponsorship); a boolean would mislead the international
  students the field is meant to help.
- Citizenship status is not a structured field in any ATS — it's extracted from
  `description_plain` via the same local-model pipeline as grad year / deadline.
- Null/unknown citizenship ≠ "no requirement" — most postings say nothing, and absence of
  a statement is not permission. High-stakes both directions (false "sponsors" wastes an
  application; false "citizens only" makes a qualified student skip a job).

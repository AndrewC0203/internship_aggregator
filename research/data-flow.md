# Data Flow: Common Crawl → Finished Listing

Traces the two jobs that make up ingestion — `discover` (finds boards) and `refresh`
(crawls boards into listings) — end to end through the source files. See Decisions
9–15 in `DECISIONS.md` for the rationale behind each stage; this doc is the shape, not
the why.

## 1. Discovery: Common Crawl → `crawl_targets`

Run via `npm run discover`. One-time/monthly job that finds candidate board tokens and
confirms they're live. This is upstream of and separate from `refresh` — it populates
`crawl_targets`, which `refresh` later reads.

```mermaid
flowchart TD
    CC[("Common Crawl CDX API\n(collinfo.json + host index)")]
    subgraph Discovery["src/discovery/greenhouse.ts"]
        A["cdxUrls()\npage through boards.greenhouse.io\n+ job-boards.greenhouse.io"]
        B["extractGreenhouseToken()\nparse board slug from URL"]
    end
    C{{"orchestrator.ts\nrunDiscovery()"}}
    D["validateToken()\nfetchBoard(token)"]
    E{"jobs.length > 0?"}
    F[("crawl_targets\nupsert on (source, token)")]
    G["dropped\n(404 or empty board)"]

    CC -->|"NDJSON, one page at a time"| A --> B -->|"dedup'd token set"| C
    C -->|"per token"| D --> E
    E -->|"yes: valid"| F
    E -->|"no: empty/404"| G
    E -->|"error: transient"| H["skip this run, log\n(no retry, no deactivation)"]
```

**Key points:** CDX paging is sequential and retried with backoff (transient 5xx/429
only — a 404 is a real answer, not retried). `--limit` caps token validation, not CDX
paging itself lets it stop paging early via `targetCount`. `isActive` is never flipped
false here — reactivation/pruning policy is still undecided (FIRST-DRAFT-MINE).

## 2. Refresh: `crawl_targets` → finished `listings` row

Run via `npm run refresh`. Reads active targets, fetches + normalizes per source, then
runs one shared tail across all three ATSes. `src/pipeline/orchestrator.ts` batches
this in `BOARD_BATCH_SIZE`-board chunks (default 10) so a crash mid-run only loses the
current chunk (Decision 15).

```mermaid
flowchart TD
    CT[("crawl_targets\nWHERE isActive")]

    subgraph PerBoard["per board, per source — error-isolated"]
        FETCH["fetch()\nGreenhouse / Lever / Ashby API"]
        NORM["normalize()\nRawJob → NormalizedListing\n(null → job dropped, board continues)"]
    end

    BATCH[["batch: NormalizedListing[]\n(accumulates until BOARD_BATCH_SIZE boards)"]]

    DEDUP["dedup()\nkey = company::title::location\nin-batch group + DB lookup vs isListed rows"]
    PART["partitionBySeen()\nsplit by listings/seen_listings membership"]

    UNSEEN["unseen\n→ full AI pipeline"]
    SEENKEEP["seenKeeps\n→ refresh source fields only"]
    SEENREJ["seenRejects\n→ bump lastSeenAt only"]

    subgraph Filter["filterInternships() — 4 tiers, cheapest first"]
        T1{"acceptRoute(title)\nCS + intern/co-op signal?"}
        T2{"rejectRoute(title)\nnon-CS or senior,\nno early-career veto?"}
        T3{"minYearsExperience(body)\n> 0?"}
        T4["classify() — local model\ncs_relevant + opportunity_type"]
    end

    KEEPS["keeps: ClassifiedListing[]"]
    MODELREJ["newRejects (model only)\ntitle/YoE drops are NOT recorded"]

    EXTRACT["extract()\nlocal model: gradYear*, citizenship,\napplicationDeadline (gap-fill only)"]

    ENRICHED["EnrichedListing[]"]

    PERSIST["persist()"]
    LISTINGS[("listings\nfull row, isListed=true")]
    SEENLISTINGS[("seen_listings\nkey-only, model rejects")]

    CT --> FETCH --> NORM --> BATCH
    BATCH -->|"flush every N boards"| DEDUP --> PART
    PART --> UNSEEN --> T1
    PART --> SEENKEEP
    PART --> SEENREJ

    T1 -->|"yes → keep, skip model"| KEEPS
    T1 -->|"no"| T2
    T2 -->|"yes → drop, unrecorded"| DROP1["titleDropped\n(re-evaluated next run)"]
    T2 -->|"no"| T3
    T3 -->|"yes → drop, unrecorded"| DROP2["yoeDropped\n(re-evaluated next run)"]
    T3 -->|"no"| T4
    T4 -->|"cs_relevant + type"| KEEPS
    T4 -->|"reject"| MODELREJ

    KEEPS --> EXTRACT --> ENRICHED --> PERSIST
    MODELREJ --> PERSIST
    SEENKEEP --> PERSIST
    SEENREJ --> PERSIST

    PERSIST -->|"keeps: full upsert"| LISTINGS
    PERSIST -->|"seenKeeps: source-field refresh,\nAI columns untouched"| LISTINGS
    PERSIST -->|"newRejects: createMany"| SEENLISTINGS
    PERSIST -->|"seenRejects: lastSeenAt bump"| SEENLISTINGS
```

**Key points:**

- **Two-pass AI, not one.** `classify()` (cs_relevant + opportunity_type) and
  `extract()` (grad year / citizenship / deadline) are separate model calls, run on
  different subsets — extract only ever sees `keeps`. Splitting them means a change to
  extraction prompts never risks the classification decision, and vice versa.
- **Title/YoE drops are deliberately un-memoized.** Only a *model* reject writes to
  `seen_listings`. The two regex tiers drop for free every run, so recording them would
  buy nothing and would make a future regex fix unable to recover a wrongly-dropped
  listing (`partitionBySeen` never re-checks `seen_listings` content, only membership).
- **`seenKeeps` still updates.** Skipping the AI re-classify for an already-known keep
  doesn't mean skipping the DB write — source fields (title, location, deadline,
  description) still refresh from the latest crawl, just without touching the AI-derived
  columns. This is the fix for the "content freeze" bug noted in the audit.
- **Dedup runs before partition**, on the in-batch `NormalizedListing[]`, so it has to
  resolve both an in-batch duplicate (e.g. six identical reqs from one crawl) and a
  duplicate of an already-persisted canonical in one pass — see `dedup.ts` for the
  three-way branch (new canonical / self / suppress-and-merge).

## 3. Zoom-in: the filter stage's per-listing decision waterfall

The four-tier filter is the part most worth being able to whiteboard — it's a cost
ladder, not just a filter. Sequence for one listing:

```mermaid
sequenceDiagram
    participant P as filterInternships()
    participant AR as acceptRoute()
    participant RR as rejectRoute()
    participant YE as minYearsExperience()
    participant M as classify() [Ollama]

    P->>AR: title
    alt CS signal AND intern/co-op signal in title
        AR-->>P: opportunity_type (no model call)
        Note over P: KEEP — high precision, skips everything below
    else no match
        AR-->>P: null
        P->>RR: title
        alt early-career veto matches
            RR-->>P: false (never reject on veto)
        else non-CS function OR seniority marker
            RR-->>P: true
            Note over P: DROP — titleDropped++, NOT recorded to seen_listings
        else no match
            RR-->>P: false
            P->>YE: descriptionPlain
            alt stated minimum > 0 years
                YE-->>P: min years
                Note over P: DROP — yoeDropped++, NOT recorded to seen_listings
            else no minimum stated, or min = 0
                YE-->>P: null or 0
                P->>M: title + company + description (truncated 6000 chars)
                M-->>P: {cs_relevant, opportunity_type}
                alt cs_relevant AND opportunity_type != null
                    Note over P: KEEP → extract() next
                else
                    Note over P: DROP — recorded to seen_listings (memoized)
                end
            end
        end
    end
```

# Financial assistant implementation and evaluation

This improves prompts, retrieval, structured intent extraction and backend financial tools. It does **not** retrain Gemini model weights. No paid fine-tuning, deployment or live provider evaluation is part of the default validation.

## Request flow

`POST /api/ai/chat` retains authentication, USER-only authorization, monthly plan quota, action preview/confirmation, financial-operation idempotency and auditing. Admins cannot use this endpoint to inspect another person's finances. Read-only planning runs before the transaction parser. Its strict Zod operation allowlist cannot write records or accept a user ID. Ownership comes from authentication; scenario context is bound to that owner and expires after 30 minutes. The next turn reloads financial records rather than reusing old balances.

`loadAdviceFacts` takes a repeatable-read owner-scoped snapshot, including current accessible account balances, current obligations/debt schedules, dedicated savings goals and aggregated spending history. Wallet relations are independently owner-filtered. Transaction descriptions, emails and record IDs are not sent to Gemini. Future-dated and reversed/deleted movements are excluded from received cash. The ledger has no separate pending-transaction status; pending bills are commitments rather than settled movements.

Gemini extracts a schema-constrained plan. Generated monetary inputs must match user-supplied literals; unsupported prices, loan terms and dates fall back to local interpretation and clarification. The backend, rather than the model, calculates authoritative figures. Read-only answers identify assumptions and dates; no automatic product-price lookup is configured, so unknown scenario costs are requested from the user. A supplied PHP price is sufficient for financial calculations; product variants are not required.

Savings follow-ups recognize labeled prices, saved balances, allocations, recurring contributions and explicit statements such as "I haven't saved anything yet." An allocation is a planned contribution; it is separate from money already saved. Corrections preserve the other scenario inputs, and generated extraction cannot replace a user's explicit correction with an old value. A matching recorded goal supplies its current saved balance, target and monthly allocation afresh each turn. Simple questions about income, spending, goals, wallets, bills and debts use their respective record summaries, including when asked during an unfinished plan.

Clear replies to an active savings question (including `iphone 18 pro max 2TB: ₱194,990.00`) fill its pending fields locally, without asking the model to choose a new operation. Product model and capacity numbers do not become prices. An explicit request such as "Review my budget" starts the requested topic instead. Recent owner-bound conversations that already misclassified a price reply as a budget review can reconstruct the savings context on the next turn; this recovery is in memory and does not rewrite old answers or financial records. Cancelled, expired or other-owner scenarios are not recovered.

Goal replies show the user's current received income, recorded spending, bill/debt/savings reserves and Safe-to-Spend before asking for missing information. Current-period Safe-to-Spend never silently becomes a recurring contribution, and unrelated goal balances are not used to fund a new purchase. Without a contribution frequency, the assistant can give a contribution count and asks how often the amount will be saved; it cannot claim a duration in months. The screenshot scenario (PHP 194990 price, PHP 1000 allocation, then no saved balance) therefore gives 195 contributions; if monthly is confirmed, that means about 16 years and 3 months, without an invented calendar completion date.

## Calculations

- New calculators use integer centavos, including rounded-up required contributions, calendar contribution counts, interest/fees and split allocations. Monthly schedules retain their original day through short months. Payday schedules require explicit dates; daily and weekly schedules require a first contribution date for completion dates.
- Existing Safe-to-Spend keeps its documented accounting: received period income minus unpaid bill reserves, savings reserves, due borrowed-debt reserves and recorded spending. The brief formula in the supplied prompt omitted the application's existing scheduled debt reserve; this implementation preserves that reserve. Paid bill/debt amounts are deducted as spending while only unpaid installments remain reserved. Contributions reduce outstanding savings reservations without being deducted twice. Transfers and loan principal do not become earned income.
- Cash affordability uses liquid CASH/BANK/EWALLET asset balances, protected cash, essential daily needs and scheduled bills/debts through the selected horizon. Investments, credit limits, future salary and promised loan repayments are excluded. Goal contributions have already left their source wallet, so saved goal balances are not subtracted from those wallets again.
- Interest scenarios distinguish interest-free, flat and reducing principal, with the rate and fees per payment period. Unknown terms cause clarification. Loans in the current database do not store interest; these terms remain explicit hypothetical inputs. Interest-bearing deadline questions can compare a proposed payment; the assistant asks for that payment rather than inventing one.
- Comparisons use equivalent month-to-date dates. Linear forecasts state their uncertainty and history coverage. School plans use user-supplied actual attendance days and costs. Data absence is not proof of zero real expenses.

The current account schema has no configurable timezone, confirmed payday schedule, goal deadline, essential-cost classification or protected-cash field. Stored financial dates use the existing Asia/Manila calendar. Missing planning fields are collected in the expiring scenario; they are not silently added to the ledger. If configurable timezones are added later, the shared calendar service must be extended before accepting them.

## Database-backed semantic RAG (2026-10-09)

Production guidance retrieval now uses PostgreSQL `pgvector`. `KnowledgeBase` stores question/answer guides and `KnowledgeDocument` stores product and financial guidance, each with an active flag, content hash, embedding version and a `vector(768)` column. HNSW cosine indexes support both corpora. The additive migration also adds `AiSession.context_metadata` for retrieved passage IDs/versions, accepted sources and calculation evidence. Owner-bound pending planning context remains in `pendingAction`; instructions themselves are maintained in source, while approved knowledge is stored in the database.

The indexer embeds all 150 original questions with general tool/input guidance, plus 17 Casha-Ba guides. Synthetic expected answers and private financial records are never seeded as shared knowledge. `gemini-embedding-2` produces real 768-dimensional embeddings. Documents use 2000-character chunks with 200-character overlap, averaged and normalized into one vector, matching the reference's document-vector pattern. Query/document prefixes follow Google's embedding guidance. Model, dimensions, prefixes and chunk settings are recorded in `EMBEDDING_VERSION`; incompatible vectors are excluded. Changed text is re-embedded before it atomically replaces an entry; failed embedding calls preserve the old entry.

Each assistant generation receives up to three semantically retrieved passages from the two database corpora, within 2400 characters. `AI_RAG_MAX_DISTANCE` is a maximum cosine distance (default `0.4`), **not** an accuracy percentage. The cutoff was narrowed after unrelated live queries matched at the initial `0.65` cutoff. Financial facts still come from fresh authenticated owner-scoped records and backend tools. Knowledge prose is untrusted data and cannot supply balances, issue actions or override calculations. Only validated IDs actually cited by an accepted response are returned as `knowledgeSources` and displayed under **Guidance sources**, including after history reload. Merely retrieved passages are retained as diagnostic metadata, not presented as accepted citations.

The query-vector cache holds at most 256 anonymized queries for ten minutes, with a fresh database search on every turn. It never caches wallet balances or retrieved document content. One bounded embedding call per chat request shares its deadline/disconnect signal and conservative daily token budget; generation keeps its existing separate two-attempt bound. An embedding/database outage preserves the deterministic calculation and missing-data question, with no invented sources. Lexical retrieval remains for explicitly injected offline test fixtures, not as the production semantic search path.

Admin-only authenticated endpoints at `/api/admin/knowledge/questions` and `/api/admin/knowledge/documents` list, upsert (`POST`) and deactivate (`DELETE /:id`) approved entries. Bodies cannot supply embeddings or user IDs. Private financial records are not exposed through these routes. Initial/repeated indexing has a separate atomic `AI_INDEXING_DAILY_TOKEN_CAP` (default 1,000,000 conservative token units); unchanged hashes are skipped.

```powershell
npx prisma migrate deploy
npm run db:generate
npm run ai:index
$env:AI_RAG_EVAL='1'
$env:AI_RAG_EVAL_OUTPUT='..\audit\2026-10-09\ai-rag-evaluation.json'
npm run ai:verify-rag
```

The retrieval evaluation runs real query embeddings and database searches for the 150 original questions plus labeled paraphrases and unrelated queries. It does not generate financial answers or inspect a real account. All live checks are opt-in; default unit tests use fixtures.

SDK verification on 2026-10-08: the installed `@google/genai` is **2.18.0**, with `abortSignal`, `httpOptions.timeout`, retry options and structured JSON support. Google's [model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) lists `gemini-3.5-flash-lite`; existing configured providers/models are retained. [Function calling](https://ai.google.dev/gemini-api/docs/function-calling) connects models to application tools; it does not train weights. [SDK timeout options](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html) and [embedding documentation](https://ai.google.dev/gemini-api/docs/embeddings) were checked.

Google's documented default dimension is 3072; this implementation explicitly selects 768, matching the reference and database column. `gemini-embedding-2` automatically normalizes reduced vectors; the averaged document vector is normalized again. A future embedding-model/dimension change requires re-indexing all knowledge and a matching database migration before queries switch spaces. The installed database extension and actual vector dimensions are verified by `ai:verify-rag`.

## Configuration and failure behavior

See `.env.example`; never commit real API keys. Defaults and hard bounds are enforced in `aiRuntime.ts`:

| Setting | Default |
| --- | ---: |
| `AI_QUESTION_CHARS` | 2000 |
| `AI_HISTORY_MESSAGES` | 6 |
| `AI_HISTORY_MESSAGE_CHARS` | 1500 |
| `AI_CONTEXT_CHARS` | 18000 |
| `AI_REQUEST_CHARS` | 32000 |
| `AI_OUTPUT_TOKENS` | 1200 |
| `AI_DEADLINE_MS` | 25000 |
| `AI_ATTEMPT_TIMEOUT_MS` | 8000 |
| `AI_MAX_ATTEMPTS` | 2 |
| `AI_DAILY_TOKEN_CAP` | 250000 |
| `AI_RAG_MAX_DISTANCE` | 0.4 |
| `AI_INDEXING_DAILY_TOKEN_CAP` | 1000000 |

The monthly user quota counts one completed answer, including a useful deterministic fallback. Handler failures preserve the existing quota-refund behavior. Confirm/cancel still work without another paid AI request. The authenticated rate limit is keyed by user rather than user-plus-IP, so switching IPs does not reset it. Production request protection already uses shared PostgreSQL buckets and the configured trusted-proxy hop count.

The SDK service deadline has a ten-second minimum because Gemini rejects shorter advertised deadlines. The client AbortController still enforces `AI_ATTEMPT_TIMEOUT_MS` and the remaining shared request deadline, including values below ten seconds. Explicit SQL parameter casts keep the shared token reservation compatible with PostgreSQL's type inference.

The global daily assistant provider budget is a conservative **token upper bound**, stored atomically in the existing `RateLimitBucket` table across workers. It reserves up to four tokens per input JS character plus the capped output for every attempt. Failed attempts retain that reservation because they may still have incurred provider cost. This is deliberately stricter than billable usage and can exhaust early; size it for the selected model and account budget. It is not a dollar-denominated billing meter. A database budget-store failure fails closed for provider calls, while sufficient-data deterministic calculations remain available. Receipt scanning and legacy dashboard/budget suggestion calls retain their separate existing quotas; their costs are outside this assistant token bucket.

Only HTTP 429/500/502/503/504 are retried, with bounded exponential backoff, jitter, Retry-After and the shared request deadline/attempt budget. SDK internal retries are disabled. Bad input/authentication, safety refusals, invalid schemas, expired budgets and cancellations do not cycle models. `GEMINI_FALLBACK_MODEL` is optional, must be explicitly allowed in `AI_ALLOWED_MODELS`, and shares the same bounds; there is no automatic Pro escalation. The deadline and client-disconnect signal abort actual provider requests. Diagnostic logs contain error classes rather than raw private questions, financial records or credentials.

Quota errors may provide Google RPC `RetryInfo.retryDelay` in the SDK's JSON error message instead of HTTP headers. The runtime now honors that interval as well. If it cannot fit within the shared deadline, it returns the deterministic fallback without spending another provider attempt in the same quota window. Invalid intervals do not suppress ordinary bounded backoff. Timeout defaults are unchanged; recovery of an externally overloaded provider is assessed separately. Google's [troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting) documents backoff for 429 and 503 responses.

## Evaluation

`src/evaluation/aiQuestions.v1.json` preserves all 150 original IDs and questions with an integrity digest, intent, required inputs, tools, edge cases, complete synthetic input, expected values and missing-data behavior. `planningFixtures.ts` contains synthetic data only. Complete scenarios include explicit supplemental answers where the original question is ambiguous. They must never become runtime defaults or substitute for a user's missing information.

Default tests cover all 150 complete calculator scenarios, all 150 incomplete-data scenarios, and all 150 orchestration paths with mocked extraction, plus calendar arithmetic, isolation, accounting overlap, languages, follow-ups, zero/negative funds, interest, retrieval rejection, input limits, actual cancellation, retries and budgets. These tests establish calculation/guard behavior. Mocked extraction intentionally does **not** prove Gemini reliably understands every original question or that a short answer exhausts every nuance of a broad coaching request.

Recurring planning statements share an amount/frequency parser with the financial-action router, so replies such as `1000, EVERY MONTH`, `₱1,000.00/month`, and `every month, 1000` retain their contribution role. Clear pending details bypass provider intent extraction. Existing recent owner-bound chats can recover explicit contribution facts omitted by an older parser. Handler regressions exercise the screenshot conversation through usage accounting, loading fresh financial facts, serialized session writes and a history reload using in-memory persistence; they do not contact the private database or Gemini.

The October 9 accuracy follow-up defines each planning tool in `planningIntent.ts` and supplies these definitions to Gemini. Clear question intents are preserved during provider validation: a maximum purchase budget stays `cash_available`, a required contribution by a deadline stays `goal_contribution`, and historical spending stays separate from a future forecast. These rules use financial concepts and wording, not question IDs or fixture lookup. Unmatched questions still allow validated provider interpretation.

Latest-turn planning inputs are retained before and after model extraction. Valid structured details can be supplied as a `Scenario:`, `Planning inputs:` or `Details:` JSON object, or a JSON code fence; they contain typed financial fields, not operations, user IDs or actions. Server validation rejects unknown fields, invalid amounts, dates and schedules. Natural-language zero saved, contribution periods and first/start dates are also recognized. An existing validated frequency supplies the schedule frequency for a short start-date follow-up. Model omissions cannot erase these explicit fields, and conflicting generated values are rejected. The original 150 complete scenario inputs and incomplete questions are covered through the actual local intent/input parser in addition to calculator and mocked-extraction coverage.

The October 10 live run found that a longer structured-input label could consume nested JSON before reaching the separator. The label now ends at its colon, preserving the whole validated object, including zero savings, nested schedules and start dates, even when provider extraction is malformed. The regression suite checks both short and long labels across all 150 complete scenarios. Live repaired-code checks are recorded separately from the frozen baseline batch.

The [reference adaptation](AI_REFERENCE_ADAPTATION.md) adds retrieved guidance to English planning explanations after deterministic calculation. Generated prose cannot replace amounts, timelines, assumptions or clarification questions. Accepted explanations carry validated source IDs; rejected responses preserve the built-in answer. Short follow-ups omit the repeated full record summary while retaining a zero Safe-to-Spend qualification. `AI_LIVE_CHECK=1 npx tsx src/scripts/check-ai-response.ts` is an opt-in synthetic provider check with the same configured budget and limits.

Run from the backend:

```powershell
npm test
npx tsc --noEmit
npm run lint
npm run build
npm run test:integration
```

Integration tests require an explicitly configured `TEST_DATABASE_URL`; they use a random isolated schema and skip when none is configured. Default tests do not need a provider or database. The frontend's chat input accepts up to 2000 characters; its existing tests and build remain applicable.

`test/ai-rag-session.integration.ts` additionally exercises RAG metadata persistence and authenticated history reload with real PostgreSQL/pgvector and a mocked provider. Use a disposable database whose test role can create the vector extension and isolated schemas. This test does not prove that a particular real account has saved a RAG conversation; verify that through normal sign-in and the history endpoint.

To regenerate the question mapping after intentionally updating fixtures:

```powershell
npx tsx src/scripts/import-ai-evaluation.ts 'C:\path\to\Casha_Ba_AI_Codex_Prompt_150_Questions.txt'
```

Live evaluation is separately opt-in, uses synthetic data, may incur provider charges, and requires explicit question and token caps:

```powershell
$env:AI_LIVE_EVAL='1'
$env:AI_LIVE_EVAL_QUESTIONS='10'
$env:AI_LIVE_EVAL_TOKEN_CAP='250000'
$env:AI_LIVE_EVAL_OUTPUT='ai-live-semantic-rag-evaluation.json'
npx tsx src/scripts/evaluate-ai-live.ts
```

The report distinguishes actual provider responses, accepted extraction/explanations and local fallback. Each question has complete and incomplete synthetic cases, with prompts, generated output, operation checks, expected-fact differences, missing-data handling, usage and unchanged-fixture checks. Supplemental scenario details omit the expected operation and answer. The evaluator checkpoints after every question. `AI_LIVE_EVAL_CONCURRENCY` defaults to one (maximum three), and `AI_LIVE_EVAL_SCENARIO_DELAY_MS` defaults to 6500 to avoid a burst of provider calls. `AI_LIVE_EVAL_OUTPUT` selects a report path. A conservative evaluation-only reservation cap is separate from the application's database token counter; this does not raise or reset application/user quotas. The shared request attempt/deadline and output bounds still apply. HTTP 400/401/403 stop the run instead of repeatedly issuing invalid requests. Optional `AI_LIVE_EVAL_DEBUG=1` prints bounded, redacted synthetic provider diagnostics only.

A live follow-up exposed HTTP 400 for the full Zod financial-plan response schema. Narrowing by calculation family worked for simple goals but still failed for goal changes. `planningProviderSchema` now uses a simple operation/language envelope with a parameter array. Each item contains a field name and JSON text for one typed value. The wire grammar uses plain strings; the server enforces field allowlists, length, duplicate fields and typed financial validation before the existing provenance, calendar and centavo checks. Every operation and input field remains available. Regressions round-trip all 150 supplemental scenarios and exercise this format through orchestration. `AI_SCHEMA_CHECK=1 npx tsx src/scripts/check-ai-schema.ts` checks the simple grammar using synthetic evidence only; add `AI_SCHEMA_INCLUDE_FULL=1` to also request the original grammar for comparison. The simple array grammar succeeded in the live diagnostic; the original full schema returned HTTP 400 with the same model and credentials. An intermediate single-string parameter list produced malformed inner JSON and was replaced by the per-value array.

`AI_LIVE_EVAL_RESUME=1` resumes a saved report only when its implementation digest, model, runtime limits and question count match. Prior reservations count against the cap. Reservations are checkpointed before generation. Older incomplete checkpoints add a conservative allowance for uncheckpointed calls. Changed source code requires a fresh evaluation rather than silently combining results from different versions. `AI_LIVE_EVAL_RETRY_UNANSWERED=1` retries only scenarios with no provider response, preserving their earlier availability failures in the report. Responded accuracy failures are retained, not retried for a better score. Rate-limit, high-demand and timeout errors introduce a cooldown outside the individual request scope. Three consecutive unanswered scenarios stop the run for provider unavailability.

Live interpretation, language quality, operator pricing/budget settings, real PostgreSQL behavior and production deployment must be assessed separately before claiming production readiness. When translation is unavailable or cannot preserve verified facts, the assistant retains its deterministic English calculation with a Filipino/Cebuano introduction.

Account identity questions are handled locally using only the authenticated owner's saved first and last name. They preserve pending previews/planning context and are excluded from future provider history. Safe-to-Spend explanation questions bypass purchase planning, and common Cebuano follow-ups preserve their topic. An explicit grouped price following a named purchase product is retained separately from its contribution and saved balance; model/capacity numbers do not become prices. Forecast output states accessible wallets, recorded spending pace, its last included calendar date and the no-future-income assumption, with clarification when history or accessible accounts are missing. See the [October 10 reported-question fixes](../../audit/2026-10-10/AI_USER_QUESTIONS_FIX.md) for offline verification and live/account limits.

October 11 live review adds cost-planning variants: full rental move-in total, comparable alternative costs, and job/business income-and-cost effects. A stated salary reduction is included rather than treating cheaper transport alone as an affordability answer. Missing or conflicting income is clarified; no new business revenue is inferred. Lower costs are worded as “less” and equal costs explicitly. The three reviewed supplemental oracles and their generator now reflect the original question meanings.

RAG explanation validation accepts direct denials of certainty such as “rather than guaranteed future expenses” and prerequisite descriptions such as needing “an affordable contribution rate,” retaining validated citations. The prerequisite exception excludes personal or predicate affordability claims. Positive guarantees, unknown sources, invented amounts and record-changing claims still fall back to the backend answer. The [after-reset verification report](../../audit/2026-10-11/AI_RAG_AFTER_QUOTA_RESET.md) separates 57/58 live passes before the last guard fix from 58/58 corrected-source offline replays, records 647 passing backend tests, and documents the remaining provider and actual-account checks. Start the separate qualified-inputs report after quota recovery; changed source must not be resumed against older reports.

The later October 11 screenshot review reproduced failures in the exact copied profile and contribution-count samples. Read-only question presentation is now normalized without changing the saved message or action confirmations. Complete contribution inputs and named first-contribution dates are preserved. Recorded wallet/monthly-total lookups bypass generic budget planning, and a clearly different calculation no longer inherits an unrelated previous topic. Product usage questions provide existing steps. Borrowed principal and separately recorded loan/credit/liability account balances are disclosed without assuming they are distinct debts. The [focused screenshot-fix report](../../audit/2026-10-11/AI_SCREENSHOT_COPY_PASTE_FIX.md) records browser verification, owner-bound saved planning/RAG metadata, and final checks. These scoped actual-account results do not replace the older versioned bulk evaluation.

The subsequent conversation follow-up fix stores the original core question alongside the topic in `AiSession.pendingAction`. Short retries and frustration continue that question using fresh facts; retrieval and generation receive the resolved question. Recent legacy core rows can reconstruct the question from user messages, stopping at expired context, cancellation or another workflow. Usage replies must provide concrete navigation rather than just a capabilities invitation or apology. A retry of a financial plan retains the validated plan without new provider intent extraction. Frustration never confirms a pending financial action. Historical replies are preserved. See the [follow-up verification report](../../audit/2026-10-11/AI_CONVERSATION_FOLLOW_UP_FIX.md) for scoped browser and persistence evidence.

Purchase effects on savings goals now preserve the purchase cost separately from goal targets and recurring contributions. An unknown price is clarified as a PHP scenario cost, without requiring a product variant. A known price asks only about an unknown funding choice: accessible cash, an identified saved goal, or reduced future contributions. Saved-goal withdrawals compare the original and reduced balance using fresh recorded targets and monthly allocations. Reduced contributions require their remaining monthly amount and duration; an unfunded remainder is clarified. Cash scenarios show the cash-balance effect without asserting affordability or changing goal balances. These read-only choices persist in the existing owner-bound planning JSON and survive a history reload. Provider extraction cannot invent the funding choice, and generated guidance cannot demand a product variant or a price already supplied. A clearly different question starts its own calculation. See the [purchase-impact verification report](../../audit/2026-10-11/AI_PURCHASE_GOAL_IMPACT_FIX.md) for 675 passing backend tests and scoped browser/database evidence; those browser replies used the built-in calculator because the application provider budget was exhausted.

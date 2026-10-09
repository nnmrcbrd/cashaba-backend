# Portfolio reference adapted to Casha-Ba — 2026-10-09

The requested target is Casha-Ba. The portfolio repository is a reference; its files were not changed or deployed. The local reference snapshot is commit `3fcf01e05bffd7d8fa4c8cbd233437d8b65fa7b9` from [portfolio-backend-api](https://github.com/arielmaestrodev/portfolio-backend-api).

## Reference findings

[`AskAIService`](https://github.com/arielmaestrodev/portfolio-backend-api/blob/3fcf01e05bffd7d8fa4c8cbd233437d8b65fa7b9/src/services/ai/chat/ask-ai-service.ts) embeds a question, searches knowledge and blog repositories, assembles their context, generates a Gemini answer and returns sources. [`gemini-service.ts`](https://github.com/arielmaestrodev/portfolio-backend-api/blob/3fcf01e05bffd7d8fa4c8cbd233437d8b65fa7b9/src/services/ai/core/gemini-service.ts) supplies the persona and restricts portfolio facts to retrieved context, with bounded recent history. It explicitly requests 768-dimensional embeddings and averages chunk embeddings into one document vector. The repositories select the nearest documents without a relevance cutoff. Its chat endpoint is public and accepts client-provided history.

For Casha-Ba, personal financial amounts require authenticated, current database reads and deterministic calculations. A public document search cannot supply an accurate account balance, infer dedicated savings from an unrelated goal, or authorize a financial entry.

## Adaptation

| Reference pattern | Casha-Ba implementation |
| --- | --- |
| Embed the query | `generateEmbedding` uses real `gemini-embedding-2`, 768 dimensions and search-query/document prefixes |
| Search knowledge and blog vectors | `KnowledgeBaseRepository` and `KnowledgeDocumentRepository` search persisted active, compatible vectors by cosine distance; product guides replace portfolio blogs |
| Chunk/average document embeddings | 2000-character chunks, 200-character overlap, normalized average and an explicit embedding version |
| Retrieve relevant context before answering | `retrieveRagContext` selects database knowledge; `loadAdviceFacts` independently reads the authenticated owner's fresh financial records and `executeFinancialPlan` calculates verified values |
| Give Gemini context and recent conversation | `explainFinancialPlan` supplies current verified evidence, the selected passages and server-loaded bounded history; entity names and obvious identifiers are minimized |
| Ground the generated answer | Gemini supplies a short qualitative explanation. Backend-authored amounts, timeline, qualifications and the next missing-data question remain authoritative |
| Report sources | Only validated passage IDs selected for an accepted explanation are returned as `knowledgeSources`, with server-owned source/version metadata |
| Save knowledge and conversation | Public knowledge and embeddings are stored in PostgreSQL. `AiSession` stores owner-bound planning context plus retrieval/citation/calculation metadata; history reload returns accepted sources |
| Handle provider failures | Provider, schema, budget and source-validation failures retain the calculated answer and pending question |

The vector extension, both knowledge tables, HNSW indexes and session metadata migration were actually applied to the configured database on October 9. The indexer stored all 150 question guides and 17 product/financial guides with real 768-dimensional vectors. Only general guidance is seeded: expected fixture values and personal ledgers are excluded. The approved knowledge can be maintained through admin-only endpoints; hash/version checks make repeated indexing resumable without replacing valid entries when embedding fails.

This matches the reference's RAG architecture, not every portfolio-specific behavior. Casha-Ba retains its own persona, authenticated financial endpoint, fresh owner-filtered calculations, action confirmation and bounded configured generation model. It deliberately adds active/version filters, a calibrated relevance cutoff and source-ID validation. It does not copy a public personal-finance endpoint or automatic Pro fallback. RAG retrieves knowledge at runtime; it does not retrain Gemini weights.

Live vector search and generated-answer accuracy are separate checks. See `../../audit/2026-10-09/AI_RAG_VERIFICATION.md` for database evidence and current results. The earlier 123-question generated-answer report belongs to the pre-vector implementation and must not be presented as full verification of this release. The live generation evaluator now invokes semantic retrieval explicitly, counts embedding responses separately and includes RAG source files in its digest; a changed implementation requires a fresh report.

English planning replies now have a Gemini explanation step. Clear monetary follow-ups still bypass intent extraction. Filipino/Cebuano replies retain the existing guarded translation path. The explanation uses the existing shared deadline, attempt limit, token cap and configured model. It does not automatically escalate to a more expensive model. Financial actions retain preview and confirmation.

## Historical runtime failures found before vector RAG

The first live check failed before reaching Gemini with PostgreSQL `42P08`, surfaced as Prisma `P2010`. The shared token-reservation SQL reused parameters in places with ambiguous inferred types. Explicit `text` and `integer` casts fix the query while retaining the atomic cap and rejection of over-cap first reservations.

After that fix, Gemini returned HTTP 400: the manually set eight-second service deadline was below its ten-second minimum. The SDK service deadline now has a ten-second floor. The existing AbortController still enforces the shorter configured client/request timeout, so this does not turn a short client cap into an unbounded wait.

At `2026-10-08T15:32:10Z`, a subsequent live synthetic check succeeded with the configured `gemini-3.5-flash-lite`, returned an accepted explanation supported by `savings:0`, and used 893 reported tokens. The calculator retained 200 daily contributions for a PHP 20000 target, zero saved and PHP 100 daily. Earlier blocked/rejected checks are not counted as successful generations. No private financial records were supplied to these checks; only the shared AI token-budget counter was used in the application database.

## User-visible changes

Short clarification replies keep the known target, savings and contribution without repeating the whole financial summary. A zero Safe-to-Spend qualification remains visible. The full financial evidence and assumptions remain available in calculation metadata.

The old “Cancel request” bar was a pending-clarification control, not a loading indicator. The frontend now explicitly says “Waiting for your answer” and uses “Cancel plan” for read-only plans. The response and reloaded history identify planning clarifications consistently; completed plans have no pending-clarification bar.

## Verification and limits

Regressions cover the exact screenshot conversation through the chat handler and history reload, fresh owner-scoped facts, source validation, unsupported generated amounts/actions/affordability claims, provider failure, unchanged financial calculations, bounded history, redaction, and the shared extraction/explanation attempt budget. A PostgreSQL-specific budget test uses only an isolated generated schema on `TEST_DATABASE_URL`, and skips when that URL is absent. It never falls back to the application database.

Run a small live synthetic check explicitly:

```powershell
$env:AI_LIVE_CHECK='1'
npx tsx src/scripts/check-ai-response.ts
```

The usual configured model, token reservations, output cap and retry bounds apply. Optional `AI_LIVE_CHECK_DEBUG=1` prints the synthetic model response and redacted provider errors; it must not be repurposed to log private conversations. The check does not inspect an actual user's account or establish all 150 questions' live interpretation accuracy. It is separate from the full opt-in live evaluation described in `AI_ASSISTANT.md`.

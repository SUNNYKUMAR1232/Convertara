# ADR: Splitting intent from guarantee in Convertara

**Status:** Accepted
**Date:** 2026-08-25
**Board:** Architect (adjudicating), Agentic AI Engineer, Performance, Security, DevOps, QA/Reliability, Product/UX

The Software Engineer seat was not filled. Its mandate — implementation correctness —
was just exercised directly: a smoke test against a running stack found four defects
that typecheck and 58 green unit tests had both missed. That seat would be
re-litigating findings already on the table.

## Context

Convertara accepts a file and a plain-language instruction and returns a file that
provably satisfies it. The load-bearing claim is the one in "compress to 300 KB ± 5%":
a language model can read that sentence, but it cannot be the thing that promises the
bytes.

Constraints treated as fixed going in:

- A recognised request must not pay for a model call. A conversion is ~40ms of work;
  a planner round trip is 600–900ms and would be 95% of the budget.
- Uploads are wholly untrusted and are fed to large C parsers (libvips, Ghostscript).
- Deployable by one person with `docker compose up`, and runnable locally with nothing
  installed.
- Provider choice is a user setting, not an architectural commitment.

Implementation is complete and verified end to end: a 2.6MB JPEG lands at 319,277
bytes inside a 285–315KB window in 2.5s, planned in 3ms with no model call.

## Decision

Keep the two-brain split as built — rule engine first, model only for genuinely
ambiguous input, and a deterministic optimizer that owns every numeric guarantee.
The board did not find the shape wrong. It found six places where the shape is
correct and the defaults are unsafe, and ruled on each below.

## Positions

**Agentic AI Engineer** — *Right call to route first; the coverage check is the weak
joint.* The system already does the thing most "AI features" get wrong: it classifies
cheaply and escalates rarely, with a schema-validated plan and a validator between the
model and any side effect. My objection is the mechanism that decides "understood".
`isFullyUnderstood` clears a prompt when every leftover word is in a hand-maintained
FILLER set. That set has already absorbed `zip` — which is *also* an operation trigger.
The failure mode is not a wrong plan, it is a **silently dropped instruction**: a
prompt whose second clause is quietly ignored and whose output looks plausible.
*Cost of my recommendation:* a stricter list sends more traffic to the model, so
latency and spend go up on exactly the requests the fast path exists to catch.

**Performance** — *The fast path is the budget; protect it, and fix the fan-out.*
Measured: plan 3ms, five encodes, 2.5s wall for a 2.6MB source. That fits. Two real
problems. First, `execute()` runs the optimize phase as `Promise.all` over every file
— a 64-file batch is up to 448 concurrent libvips encodes with no bound; the box dies
before the queue notices. Second, every upload is `part.toBuffer()`. At the shipped
defaults (200MB × 64 files) one request can ask for ~12.8GB of heap. Concurrency per
worker is set by (RAM ÷ largest input), and nothing states that number.
*Cost of my recommendation:* bounding the fan-out makes large batches slower in
wall-clock than the current unbounded version — when the current version survives.

**Security** — *Two findings at very different volumes.* High: `POST /v1/llm/test` and
the stored config accept an arbitrary `baseUrl` (`z.string().url()` and nothing else)
and the server then issues a request to it carrying headers, returning status and body
shape to the caller. On any cloud host that is a metadata-endpoint SSRF —
`http://169.254.169.254/` — and an internal port scanner. High: `ownerOf()` reads
`x-owner-id` off the request and trusts it. The comment says an auth proxy sits in
front; nothing enforces that, so a directly-exposed deployment lets any caller read any
tenant's files by setting a header. Lower, and I am not blocking on them: libvips runs
in-process with `failOn: 'none'`, so a parser exploit lands in the API process; and
there is no rate limit on a 200MB upload endpoint. The archive guards are genuinely
good — ratio, entry count and traversal are all checked before decompression, which is
the right place.
*Cost of my recommendation:* an endpoint allowlist breaks the local-Ollama story,
which is a real feature; and making the owner header opt-in adds a setup step.

**DevOps** — *The zero-infra fallbacks are a trap with no tripwire.* `MemoryRepository`
and `InlineQueue` are selected by the *absence* of `DATABASE_URL`/`REDIS_URL`. Deploy
three API replicas with a typo'd env var and you get three isolated in-memory stores
and jobs that vanish between requests, with `/health/ready` reporting green. Nothing
in the design distinguishes "developer laptop" from "misconfigured production". Also:
`InlineQueue.close()` is empty, so a SIGTERM during a deploy drops in-flight jobs
silently. Deployability is otherwise good — one image, config from environment,
Ghostscript baked in, readiness that actually probes dependencies.
*Cost of my recommendation:* a hard failure on boot will, at some point, page someone
for a deployment that would have limped along.

**QA/Reliability** — *The headline promise is tested; the promises around it are not.*
`pipeline.test.ts` compresses a real image into a ±5% window — that is the right test
and it exists. What has nothing attached: the fast path's refusal behaviour beyond six
enumerated phrases (the input space is enormous and the failure is silent), the
optimizer against real encoder curves rather than the synthetic monotonic one, and
every dependency's slow-but-successful case — no test covers a provider that answers
in 29 seconds against a 30s timeout. There is no ugly-input corpus: no truncated JPEG,
no zero-byte file, no file one byte over the limit.
*Cost of my recommendation:* a corpus and property tests are real work on a system
whose engine set will keep growing.

**Product/UX** — *One state machine bug, one honesty gap.* A job that misses its size
window is written `status: 'failed'` with the output file attached. The user sees
"failed" next to a working download; automation that branches on status throws away a
file it should have kept. That is the partial-success case and it should say so.
Second: progress is only ever persisted as 0 or 1. A client that polls `/v1/jobs/:id`
instead of holding the SSE stream sees 0% for the entire job and then done — which
reads as hung, and hung is what makes users retry. The UI showing the plan it ran is
the right instinct and should stay.
*Cost of my recommendation:* a third terminal state is a permanent addition to a
public contract, and persisted progress means a database write per progress tick.

## Tensions and rulings

### T1 — Arbitrary `baseUrl` is both the feature and the vulnerability

Security wants an allowlist on outbound LLM endpoints. Product points out that
"point it at your own Ollama or gateway" is a headline capability, and every useful
value there is private (`localhost:11434`, `http://api-gateway.internal`).

*What it turns on:* whether the deployment is multi-tenant. On a single-user
self-hosted box, reaching localhost is the point. On a shared host, it is an SSRF
primitive with a metadata endpoint at the other end.

**Ruling: Security wins, with the switch made explicit rather than absolute.** Block
link-local, loopback and private ranges by default, resolving the hostname before
connecting so a DNS-rebind name cannot walk past the check. Add
`LLM_ALLOW_PRIVATE_ENDPOINTS=true` for self-hosted, documented as "only on a host you
control". This is not a case where simplicity beats the objection: the default has to
be the safe one, because the person who gets this wrong is the one who never read the
setting. Cost: local Ollama needs one env var. *Revisit if* an allowlist proves too
coarse for real gateway topologies.

### T2 — `x-owner-id` is a documented seam or an unauthenticated tenant switch

Architect: the seam is deliberate and correct — auth belongs in front, and baking a
user system into this would be the expensive-to-reverse decision. Security: an
undefended default is not a seam, it is a vulnerability with a comment above it.

*What it turns on:* what happens when nobody puts the proxy in front — which is the
common case for a `docker compose up` deployment.

**Ruling: keep the seam, change the default to fail closed.** The header is honoured
only when `TRUST_OWNER_HEADER=true`; otherwise every request resolves to the single
`public` owner. The system is then either explicitly single-tenant or explicitly
behind something that sets the header — and never accidentally multi-tenant with
client-controlled identity. Cost: multi-tenant deployments need one more env var, and
it will be missed at least once. *Revisit when* real auth lands.

### T3 — Zero-infra fallbacks: a feature in dev, a silent outage in prod

DevOps wants the fallbacks gone or gated. Product and Architect both want
`npm run dev` with nothing installed — it is the difference between a project someone
tries and one they don't.

*What it turns on:* whether the failure is loud. The fallbacks are not wrong; being
selected silently is.

**Ruling: keep both fallbacks, refuse to boot on them in production.** With
`NODE_ENV=production` and no `DATABASE_URL`, exit with a message naming the variable,
unless `ALLOW_EPHEMERAL_STATE=true` is set. Also give `InlineQueue.close()` a real
drain so SIGTERM finishes in-flight work. Cost: a production deploy that would have
half-worked now fails at boot — which is the outcome we want, on the day it happens.

### T4 — A third job state versus a stable two-state contract

Product wants `partial` for "we produced a file but missed the constraint". Architect's
instinct is that fewer terminal states is a better contract and clients can read
`evaluation.pass`.

*What it turns on:* what a client that only reads `status` does today — and the answer
is that it deletes a perfectly good file, because `failed` is the honest reading of
`failed`.

**Ruling: Product wins.** Add `partial`: constraints unmet, output present and
downloadable. `failed` means no output exists. The distinction is load-bearing for
exactly the case this system is built around — a size target it could not quite reach
without going below the quality floor. Cost: a permanent third state in a public
contract, and the UI must render it as a warning rather than an error.

### T5 — Fast-path coverage: how conservative is conservative enough

Agentic AI wants the FILLER list constrained, arguing a dropped instruction is a
silent wrong answer. Performance notes every word removed from FILLER pushes more
traffic to a 900ms model call.

*What it turns on:* the asymmetry between the two failure modes. A false reject costs
900ms and a fraction of a cent. A false accept silently ignores something the user
asked for and returns a plausible-looking file. Those are not comparable.

**Ruling: Agentic AI wins on the invariant, Performance keeps the fast path.** The
rule engine stays and stays first. FILLER may contain determiners, pronouns and format
nouns only — **never a word that any matcher also treats as an operation**. `zip` is
currently in both and must come out of FILLER. Encode the invariant as a test that
fails when a future contributor adds an operation-bearing word. Cost: a slightly
higher deferral rate. *Revisit if* the deferral rate exceeds ~25% of traffic.

### T6 — Unbounded fan-out in the optimize phase

No disagreement; recorded so the fix has a home. `Promise.all` over files, each running
up to 15 encodes, has no ceiling. **Ruling: bound it to `WORKER_CONCURRENCY`,** and
state the memory model in the config comment: peak ≈ concurrency × largest input × ~3.

## Consequences

**Accepted:**

- Six new environment variables, four of which exist only to make an unsafe default
  safe. That is real configuration burden, and each one is a thing someone can get
  wrong in the other direction.
- Bounded fan-out makes big batches slower in wall-clock than the unbounded version
  does when the unbounded version happens to survive.
- `partial` is permanent. Every future client has to handle three terminal states.
- Boot-time refusal will page someone for a deploy that would have limped.

**Rejected alternatives:**

- *LLM-first with caching* (rejected in T5): would fold the rule engine into a cache
  layer and put a model call in the cold path of every new phrasing. The measured 3ms
  versus 600–900ms is not a margin worth trading for uniformity.
- *Removing the zero-infra fallbacks* (T3): the "clone and run" property is worth more
  than the config-error class it creates, once that class fails loudly.
- *Per-job container isolation* for parser exploits: correct in principle, and the
  operational surface exceeds the application's at the scale this will actually see.
  Recorded as the mitigation to reach for if this is ever exposed to the open internet.

**Revisit when:** the system goes multi-tenant with real users (T2 becomes real auth,
and in-process libvips becomes a sandbox question), or the fast-path deferral rate
crosses 25% (T5's list is too strict), or a second non-image domain registers a size
optimizer (the knobs interface was designed against image and PDF only, and two
examples is thin evidence for a shape).

# Convertara

Chat with it about a file. The system guarantees the result.

"Compress this to 300 KB ± 5%" is not a prompt for a language model — it is an
optimisation problem with a checkable answer. Convertara splits those jobs in
two: a model (any model, or none) decides *what* you meant, and a deterministic
engine makes sure the bytes that come back actually satisfy it.

---

## The two ideas this is built on

**1. Most requests never reach a model.**

"Convert to WebP" needs a lookup table, not inference. A rule engine parses the
request first and only defers when it genuinely cannot account for every word —
so "convert to webp and add a watermark" goes to the model (watermarking is a
real instruction it cannot express), while "compress to 300kb ±5%" does not.
Fast-path requests answer in tens of milliseconds and cost nothing.

**2. The model never decides whether the result is correct.**

A plan is a fixed list of capability calls plus a constraint block. Once it
exists, no LLM is reachable from the execution path. A `300 KB ± 5%` target
becomes a byte window exactly once, in one function, and the optimizer, the
validator and the error message all read from it — so they cannot disagree.

```
                             ┌──────────────┐
   request ────────────────► │   ROUTER     │
                             └──────┬───────┘
                       understood?  │
                    ┌───────────────┴───────────────┐
                    ▼ yes                        no ▼
             ┌─────────────┐                ┌──────────────┐
             │  RULE ENGINE│                │ LLM MANAGER  │
             │   ~0 ms     │                │ any provider │
             └──────┬──────┘                └──────┬───────┘
                    └───────────────┬──────────────┘
                                    ▼
                            STRUCTURED PLAN          ◄── the only contract
                                    │
                       ┌────────────┴────────────┐
                       ▼                         ▼
              CONSTRAINT ENGINE          CAPABILITY ROUTER
              300KB ±5% → 292–323KB      image.resize → engine
                       └────────────┬────────────┘
                                    ▼
                        ENGINES  (image · pdf · archive)
                                    │
                                    ▼
                        DETERMINISTIC SIZE SEARCH
                        binary search, ~7 encodes
                                    │
                                    ▼
                              VALIDATOR
                     magic bytes + every constraint
                                    │
                                    ▼
                               RESULT
```

---

## Run it

### Locally, with nothing installed

```bash
npm install && npm run dev
```

The API comes up on `:4000` with in-memory metadata, local-disk storage and an
in-process queue. In another terminal:

```bash
npm run dev:web
```

Open <http://localhost:3000>. Drop in an image, say "compress to 300kb ±5%",
and watch it land inside the window without a model being called. Then say
"now convert it to png" with nothing attached - the follow-up picks up the file
the last turn produced.

### Production, with Docker

```bash
cp .env.example .env
```

Set `SECRET_KEY` (`openssl rand -hex 32`) — it encrypts stored provider keys and
compose refuses to start without it. Then:

```bash
docker compose up -d --build
```

That brings up Postgres, Redis, MinIO, the API, a worker and the web UI. Scale
processing independently of the API:

```bash
docker compose up -d --scale worker=4
```

---

## It is a conversation, not a form

A turn is classified before anything else happens, and most turns never reach a
model at all:

| You type | What happens |
|---|---|
| "hi", "thanks" | Answered directly. No model. |
| "what can you do" | Generated from the live capability registry, so it cannot go stale. No model. |
| "compress to 300kb ±5%" (file attached) | Rule engine plans it, engine runs it, validator checks it. No model. |
| "now convert it to png" (nothing attached) | Same, against whatever the last turn produced. No model. |
| "which is smaller, webp or avif?" | Goes to your configured model, streamed token by token. |
| "do" / "ok" | Says it does not know what you meant and gives examples. A file being attached does not make a message an instruction. |

## Crop, resize and rotate are dragged, not described

"Crop a bit off the left" is a bad sentence and a good drag. Any image the
assistant produces carries an **Adjust** button that opens a direct-manipulation
editor:

- **Crop** - drag a box on the image, or drag the box to move it. The readout
  is in real pixels, and what you apply is exactly what you drew.
- **Resize** - width and height with an aspect lock and 25/50/75% presets. An
  explicit number here is allowed to enlarge, unlike a typed instruction.
- **Rotate** - 90° either way, flips, or any angle.

Applying lands in the thread as an ordinary turn - a user message saying what
was asked for, an assistant message with the result - so you can keep talking
to it afterwards, and each adjustment runs against the file shown rather than a
re-compressed copy.

A measured six-turn session - compress, resize, shrink under a ceiling, convert,
thanks - made **zero model calls**.

Replies about work done are templated rather than generated. Every fact is
already in hand, and a template that knows them writes a better sentence than a
model guessing at them, for no latency and no cost:

> Compressed that - 2.6 MB to 312 KB. That is inside your 285 KB-315 KB (target 300 KB).

## Choosing a model

Nothing is hard-coded. Open **Settings**, pick a provider, paste a key, name any
model:

| Provider | Structured output via | Key needed |
|---|---|---|
| Anthropic | forced tool call (official SDK) | yes |
| OpenAI | `response_format: json_schema` | yes |
| Google Gemini | `responseSchema` | yes |
| Ollama | `format` (JSON Schema) | no — runs locally |
| Custom | any OpenAI-compatible endpoint | optional |

Keys are encrypted with AES-256-GCM before storage and never returned to the
browser — the settings screen only ever sees `sk-•••abcd`.

`AI_MODE` decides how much the planner is used at all:

- `auto` (default) — rules first, model only when needed
- `always` — always ask the model
- `never` — rules only; ambiguous requests are refused with an explanation
  rather than guessed at

---

## What it can do

| Domain | Capabilities |
|---|---|
| Image | convert · resize · compress · crop · rotate · greyscale · strip metadata |
| PDF | merge · split · extract pages · rotate · metadata · images→PDF · compress\* |
| Archive | create · extract · inspect |

\* `pdf.compress` needs Ghostscript on the host. If it is missing the capability
reports itself unavailable and the planner is never told about it — the system
does not accept work it cannot do. The Docker image installs it.

Adding a domain is a plugin, not a refactor:

```ts
export const videoEngine: EnginePlugin = {
  domain: 'video',
  title: 'Video engine',
  capabilities: [trim, transcode],
  optimizer,           // registering one gives video size targets for free
};
```

Register it in `bootstrap.ts` and it appears in the API, in the planner's schema
and in the UI. Nothing else changes.

---

## API

```bash
# one round trip: upload, plan, process
curl -F 'files=@photo.jpg' -F 'prompt=compress to 300kb ±5%' \
  http://localhost:4000/v1/process/upload
```

| Route | Purpose |
|---|---|
| `POST /v1/chat` | One conversational turn, streamed as SSE |
| `GET /v1/conversations` | Conversation list |
| `GET /v1/conversations/:id` | Full thread with attachments |
| `POST /v1/files` | Upload, returns ids |
| `POST /v1/process` | Plan + run against uploaded ids |
| `POST /v1/process/upload` | Upload and process in one call |
| `GET /v1/jobs/:id` | Job state, plan, evaluation, outputs |
| `GET /v1/jobs/:id/events` | SSE progress stream |
| `GET /v1/files/:id/content` | Download a result |
| `GET /v1/capabilities` | What this deployment can actually do |
| `GET/POST/DELETE /v1/llm/configs` | Model configuration |
| `POST /v1/llm/test` | Verify a provider round trip |
| `GET /health`, `/health/ready` | Liveness and readiness |

Small work finishes inside the request (`200`). Anything expensive is queued
(`202`) and followed on the SSE stream — the cost estimator decides, based on
input size and the capabilities in the plan.

Every response carries the plan that produced it, including which route chose
it, so a model's decision is always inspectable.

---

## Safety

Uploads are identified by magic bytes, never by extension or `Content-Type`.
Archives are checked for path traversal, entry count and expansion ratio
*before* anything is decompressed. Outputs are re-sniffed before download.
Artifacts expire (24h by default) and a sweeper deletes both the row and the
blob — the safest thing to hold onto is nothing.

## Layout

```
apps/api/src/
  chat/         turn classification · reply writing · conversation service
  agent/        router · rule engine · LLM planner · prompt
  llm/          manager · adapters · encryption
  constraints/  the byte-window engine
  router/       capability registry
  engines/      image · pdf · archive
  execution/    pipeline · executor · size search
  validation/   integrity + constraint checks
  storage/      local · s3 · retention
  db/           postgres · in-memory
  queue/        bullmq · inline fallback
  security/     sniffing · archive guards
apps/web/       Next.js UI
```

## Tests

```bash
npm test
```

Covers the constraint window arithmetic, rule-engine coverage (including the
cases it must *refuse* to handle), archive guards, the search strategy, and an
end-to-end run that compresses a real image into a ±5% window.

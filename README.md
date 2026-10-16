# @27colab/instagram-dm

Typed building blocks for Instagram DM bots: webhook verification, event parsing, OAuth with token refresh, a window-aware Send API client, and a fake Graph API for tests.

[![CI](https://github.com/27colab/instagram-dm/actions/workflows/ci.yml/badge.svg)](https://github.com/27colab/instagram-dm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@27colab/instagram-dm)](https://www.npmjs.com/package/@27colab/instagram-dm)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

Built on Meta's **Instagram API with Instagram Login**. It covers the plumbing, not the product: no LLM, no prompts, no storage, no framework. You plug a `ConversationHandler` into it. Not affiliated with or endorsed by Meta.

## Why

- **The easy-to-get-wrong parts are done.** Constant-time `X-Hub-Signature-256` check over the raw body, redelivery dedupe, echo-loop filtering, and retry with backoff on throttling.
- **Window rules enforced client-side.** The client refuses to send after the 24-hour window (`WindowClosedError`) before Meta does.
- **Testable without Meta.** `FakeGraphApi` validates tokens, enforces the window, serves the OAuth endpoints and can inject failures. 47 offline tests.

## Install

```bash
npm install @27colab/instagram-dm
```

Node 20+, ESM, zero runtime dependencies, TypeScript types included.

## Quickstart

Runs offline against the fake Graph API: a signed webhook is answered, a redelivery is not answered twice, a tampered body is rejected.

```ts
import { createWebhookHandler, InstagramClient } from '@27colab/instagram-dm';
import { FakeGraphApi, textEvent } from '@27colab/instagram-dm/testing';

const [accountId, userId] = ['1000000000001', '2000000000002'];   // invented ids
const fake = new FakeGraphApi({ appSecret: 'test' });              // stands in for Meta's Graph API
const client = new InstagramClient({ accessToken: fake.issueToken(accountId), fetch: fake.fetch });
const webhook = createWebhookHandler({
  appSecret: 'test',
  verifyToken: 'verify-me',
  resolveClient: () => client,
  conversation: { onMessage: ({ event }) => `You said: ${event.text}` },  // your logic (or LLM) here
});
fake.recordInbound(accountId, userId);                             // user messaged just now: 24h window open
const { rawBody, headers } = fake.buildWebhook(
  [textEvent({ accountId, userId, mid: 'm1', text: 'hi' })], accountId);
const ok = await webhook.handle({ method: 'POST', headers, rawBody });
console.log(ok.status, fake.sent.map((m) => m.text));              // 200 [ 'You said: hi' ]
await webhook.handle({ method: 'POST', headers, rawBody });        // redelivery: acknowledged, not answered twice
console.log('replies:', fake.sent.length);                         // 1
const bad = await webhook.handle({ method: 'POST', headers, rawBody: rawBody.replace('hi', 'yo') });
console.log(bad.status);                                           // 401: bad signature, your code never runs
```

Output:

```
200 [ 'You said: hi' ]
replies: 1
401
```

For real use, drop the fake: pass `appSecret` and `verifyToken` from your Meta app, load per-account tokens in `resolveClient`, and expose the handler via `webhook.fetch` (Next.js) or `webhook.handle` (Express/Fastify, with the **raw** body).

## Bring your own keys

You need your own Meta app (type Business, Instagram product): App ID and App Secret, a webhook verify token you choose, and an access token per connected Instagram account (via the OAuth helpers here). The setup walkthrough, App Review notes and a "if nothing arrives" checklist are in the docs.

## API

| Area | Exports |
|---|---|
| Webhook security | `verifySignature`, `verifyChallenge`, `signBody`, `InMemoryDedupe` / `DedupeStore` |
| Events | `parseWebhook` → `message` (text, attachments, story reply), `echo`, `read`, `delivery`, `reaction`, `postback` |
| Windows | `evaluateWindow`, `WindowTracker` (24h standard, 7-day `HUMAN_AGENT`) |
| OAuth | `buildAuthorizeUrl`, `exchangeCode`, `exchangeLongLived`, `refreshLongLived`, `shouldRefresh`, `subscribeToWebhooks`, `fetchProfile` |
| Send API | `InstagramClient.sendText` (chunking, window guard, retry), `sendAction`, `InstagramApiError` |
| Handler | `createWebhookHandler` (`handle` and Web `fetch` adapter), `ConversationHandler` |
| `/testing` | `FakeGraphApi`, `textEvent` |

Full reference and Meta setup walkthrough: **[docs.27colab.com/packages/instagram-dm](https://docs.27colab.com/packages/instagram-dm/)**

## Limits

- The Meta-facing endpoints and behaviours it encodes come from Meta's public docs and manual testing; Meta can change them. Re-check the current docs.
- A retried send can duplicate a DM if the first attempt reached Meta; set `retry: { maxRetries: 0 }` for at-most-once.
- In development mode only accounts with a role on your app can message. App Review is yours to obtain; **this project has not been approved by Meta for anything and makes no claim of review status.**
- Pre-1.0: pin the exact version.

## Not for you if…

- You want a chatbot framework, a hosted service or an official Meta SDK. This is none of those.
- You want to drive an account with unofficial or reverse-engineered APIs. Don't; it risks the business's account.
- You need Facebook Messenger or WhatsApp. This targets Instagram messaging only.

## Develop

```bash
npm ci && npm test && npm run typecheck
```

MIT, see [LICENSE](LICENSE).

---

Built by [Jesus Vasquez](https://github.com/vasquezjesus2710) · [27 Colab](https://27colab.com)

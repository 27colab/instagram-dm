# @27colab/instagram-dm

[![CI](https://github.com/27colab/instagram-dm/actions/workflows/ci.yml/badge.svg)](https://github.com/27colab/instagram-dm/actions/workflows/ci.yml)

Small, dependency-free TypeScript building blocks for Instagram DM bots, built on Meta's **Instagram API with Instagram Login**. It covers the plumbing, not the product: webhook verification, typed event parsing, OAuth and token refresh, a Send API client that respects the 24-hour window, and a fake Graph API so you can test all of it without touching Meta.

It contains no LLM, no prompts, no storage and no framework. You plug a `ConversationHandler` into it.

## What it is, and is not

- **Is:** the parts that are tedious and easy to get subtly wrong: raw-body HMAC checks, echo loops, redelivery, token expiry, window rules, retry on throttling.
- **Is not:** a hosted service, a chatbot framework, or an official Meta SDK. It is not affiliated with or endorsed by Meta.
- **Extracted** from a private multi-tenant product. Tenancy, prompts and anything vertical were left behind. It has been exercised against its own test suite and a fake Graph API; the Meta-facing endpoints and behaviors it encodes come from Meta's public docs and manual testing, and Meta can change them. Re-check the current docs.
- Node 20+, ESM only, zero runtime dependencies.

## Install

```bash
npm install @27colab/instagram-dm
```

## Quick start

```ts
import { createWebhookHandler, InstagramClient } from '@27colab/instagram-dm';

const clients = new Map<string, InstagramClient>(); // IG account id -> client; load tokens from YOUR store

export const webhook = createWebhookHandler({
  appSecret: process.env.META_APP_SECRET!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
  resolveClient: (accountId) => clients.get(accountId),
  conversation: {
    async onMessage({ event, window }) {
      if (event.storyReply) return 'Thanks for replying to our story!';
      if (!event.text) return 'I can only read text for now.';
      return `You said: ${event.text}`; // your logic (or LLM) goes here
    },
  },
});
```

Next.js route handler (`app/api/instagram/route.ts`):

```ts
export const GET = webhook.fetch;
export const POST = webhook.fetch;
```

Fastify / Express: pass the **raw** body, not re-serialised JSON.

```ts
// Express: app.post('/hook', express.raw({ type: '*/*' }), async (req, res) => {
const r = await webhook.handle({ method: req.method, query: req.query, headers: req.headers, rawBody: req.body });
res.status(r.status).set(r.headers).send(r.body);
```

## Modules

| Area | Exports |
|---|---|
| Webhook security | `verifySignature`, `verifyChallenge`, `signBody`, `InMemoryDedupe` / `DedupeStore` |
| Events | `parseWebhook` -> `message` (text, attachments, story reply, reply-to), `echo`, `read`, `delivery`, `reaction`, `postback` |
| Windows | `evaluateWindow`, `WindowTracker`, 24h standard and 7-day `HUMAN_AGENT` rules |
| OAuth | `buildAuthorizeUrl`, `signState`/`verifyState`, `exchangeCode`, `exchangeLongLived`, `refreshLongLived`, `shouldRefresh`, `subscribeToWebhooks`, `fetchProfile` |
| Send API | `InstagramClient.sendText` (chunking, window guard, retry), `sendAction`, `InstagramApiError`, `WindowClosedError` |
| Handler | `createWebhookHandler` (`handle` and Web `fetch` adapter), `ConversationHandler` |
| Testing | `@27colab/instagram-dm/testing`: `FakeGraphApi`, `textEvent` |

### Things the code does for you

- **Signature:** constant-time check of `X-Hub-Signature-256` over the raw bytes. Invalid -> 401, your code never runs.
- **Replay:** an HMAC cannot tell a fresh delivery from a captured or redelivered one, so message ids are deduped (in memory by default; supply a shared `DedupeStore` for multiple instances).
- **Echo loops:** messages your own account sent arrive as `echo` events and never reach `onMessage`.
- **Window:** the client can refuse to send after 24 hours (`WindowClosedError`) before Meta does. Pass `lastInboundAt`. `humanAgent: true` uses the 7-day `HUMAN_AGENT` tag, which is for humans replying, not bots, and needs that feature approved for your app.
- **Retry:** network errors, 5xx and throttling (codes 4, 17, 32, 613, 80002, HTTP 429) back off exponentially and honor `Retry-After`. Client errors (bad token, closed window) fail immediately. A retried send can duplicate a DM if the first attempt reached Meta; set `retry: { maxRetries: 0 }` for at-most-once.
- **Handler errors:** logged via `onError` and still answered 200, so Meta does not retry-storm you.
- **Serverless:** pass `waitUntil` to reply 200 immediately and process in the background.

### Token refresh

Long-lived tokens last about 60 days. Refresh needs a token at least 24 hours old that has not expired; an expired token requires the user to re-authorize.

```ts
if (shouldRefresh({ expiresAt: row.expiresAt })) {
  const fresh = await refreshLongLived(oauthCfg, row.token);
  await save(fresh.accessToken, fresh.expiresAt);
}
```

Run that from a daily job.

## Testing your bot without Meta

```ts
import { FakeGraphApi, textEvent } from '@27colab/instagram-dm/testing';

const fake = new FakeGraphApi({ appSecret: 'test' });
const client = new InstagramClient({ accessToken: fake.issueToken('1000000000001'), fetch: fake.fetch });
fake.recordInbound('1000000000001', '2000000000002');
const { rawBody, headers } = fake.buildWebhook([textEvent({ accountId: '1000000000001', userId: '2000000000002', mid: 'm1', text: 'hi' })], '1000000000001');
```

The fake validates tokens, enforces the window (error 10 / subcode 2534022), supports the OAuth and refresh endpoints, and can inject failures with `failNext`. All ids in this repo's fixtures are invented.

## Meta setup walkthrough

1. Create an app at developers.facebook.com, type **Business**. Note the App ID and App Secret.
2. Add the **Instagram** product and open "API setup with Instagram login".
3. Add the OAuth redirect URI you will use for `buildAuthorizeUrl` / `exchangeCode`.
4. Under Webhooks, set the callback URL to your handler and the verify token to your `verifyToken`; subscribe to the **`messages`** field.
5. Connect an account through your OAuth flow, then call `subscribeToWebhooks`. With Instagram Login the app-level callback alone delivers nothing; each account must be subscribed individually.
6. Permissions requested by default: `instagram_business_basic`, `instagram_business_manage_messages`.

### App Review and development mode

While your app is in **development mode**, you can only message with accounts that have a role on the app (add them as Instagram Testers and accept the invite in Instagram). To serve arbitrary businesses you need **App Review** for Advanced Access to the permissions above and, typically, business verification. **This project has not been approved by Meta for anything and makes no claim of review status;** your app's approval is separate and yours to obtain.

### If nothing arrives

- Account not subscribed (step 5), or the `messages` field not toggled on in the dashboard.
- Account has "connected tools" access to messages switched off in Instagram's message controls.
- Dev-mode app and the sender has no role on it.
- Wrong `appSecret` (every event 401s) or unset `verifyToken` (handshake 403s).

## Platform rules you still own

Only reply to people who messaged you, inside the window. Disclose automation where Meta's terms or local law require it. Never drive an account with unofficial or reverse-engineered APIs; that risks the business's account.

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT, see [LICENSE](LICENSE).

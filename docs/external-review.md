# Running reviews in external services

Each review (for example the security review) can run in its own external service: a GRC tool, a ticket system or your own microservice such as `review.testx.com`. You register the service once as a **review service** (a connection). Then you choose, per review, that it runs there. When a request needs that review, [Product name] sends the service a signed event. The service reviews in its own way and with its own database, and reports the status back to a signed endpoint. In [Product name] the stage only shows that status. Reviewers do not use the form, checklist or decision buttons here.

## Setup in the UI

1. **Admin → Integrations → Review services → Add.** Enter a name, the service's HTTPS address and the data mode (see below), then save.
2. **Copy the signing secret.** It is shown **once**. Store it in the external service's secret store. Each service has its own secret.
3. **Test connection.** We send a signed `ping` event and show the HTTP status and the time it took.
4. **Admin → Reviews → (the review) → When needed and checklist → Where does this review happen: in an external service**, then choose the service.
5. Requests submitted from then on send that review to the service. Requests already submitted keep how they started.

Every review service has a **delivery log**: the events we sent, attempts, the last error and when the next retry is due.

Server setting: **Admin → Integrations → Server address** (`PUBLIC_API_URL`) must be the address where the service can reach our API. It is used in the callback links.

## Data modes

| Mode | What we send | What the service does |
| --- | --- | --- |
| `push` | The request data the review needs, inside `stage.started` | Uses the data from the event |
| `pull` | Only ids and links | Reads the data from our API (`GET stage_url`) when it needs it, and keeps its own review data in its own database |

In both modes we never send attachments or the names of people (owners). `push` sends the answers relevant to the review, or every answer when "send all answers" is on.

## What we send

`POST <service address>` with a JSON body and these headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Service-Id` | The id of the review service, for example `grc-tool` |
| `X-Event-Id` | The `event_id` of the body |
| `X-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` |

Answer with any `2xx` within 10 seconds. Anything else, or no answer, is retried with exponential backoff, up to 8 attempts. The delivery log then shows the event as failed. Handle each `event_id` once: a retry carries the same id.

### `ping` (Test connection)

```json
{ "type": "ping", "event_id": "8b1c…", "created_at": "2026-11-22T10:00:00Z", "organization": { "id": "1f0e…" }, "service": { "id": "grc-tool" } }
```

### `stage.started`, push mode

```json
{
  "type": "stage.started",
  "data_mode": "push",
  "event_id": "4a7d…",
  "created_at": "2026-11-22T10:00:00Z",
  "organization": { "id": "1f0e…" },
  "service": { "id": "grc-tool" },
  "request": {
    "id": "9c2b…",
    "title": "Acme Analytics",
    "vendor": "Acme Inc.",
    "website": "https://acme.example",
    "request_type": "New vendor",
    "risk_tier": "High",
    "risk_score": 7,
    "risk_reasons": ["Data classification: Confidential (+3)"],
    "confidential": false,
    "submitted_at": "2026-11-22T09:59:58Z",
    "answers": { "dataClassification": { "label": "Data classification", "value": "Confidential" } },
    "config_requirements": [{ "id": "sso", "title": "Sign-in through our identity provider (SSO)", "level": "required" }]
  },
  "stage": { "id": "77aa…", "name": "Security review", "due_at": "2026-11-29T09:59:58Z" },
  "callback": {
    "status_url": "https://api.example.com/v1/external/stages/77aa…/status",
    "stage_url": "https://api.example.com/v1/external/stages/77aa…?org_id=1f0e…"
  }
}
```

### `stage.started`, pull mode

```json
{
  "type": "stage.started",
  "data_mode": "pull",
  "event_id": "4a7d…",
  "created_at": "2026-11-22T10:00:00Z",
  "organization": { "id": "1f0e…" },
  "service": { "id": "grc-tool" },
  "request": { "id": "9c2b…" },
  "stage": { "id": "77aa…", "name": "Security review", "due_at": "2026-11-29T09:59:58Z" },
  "callback": { "status_url": "…/status", "stage_url": "…?org_id=1f0e…" }
}
```

## What the service sends back

### Status

`POST {status_url}`, signed with the **same service secret** the same way (`X-Signature` over `"<t>.<raw body>"`).

```json
{
  "event_id": "testx-2026-0042-1",
  "org_id": "1f0e…",
  "status": "approved_with_conditions",
  "comment": "Pilot only",
  "conditions": "Enable SSO before rollout",
  "external_id": "TESTX-42",
  "external_url": "https://review.testx.com/cases/42"
}
```

`status` is one of `in_review`, `waiting_for_requester` (pauses the clock), `approved`, `approved_with_conditions` (needs `conditions`), `rejected` (needs `comment`). `external_url` must be HTTPS.

| Response | Meaning |
| --- | --- |
| `200 {"ok": true}` | Applied |
| `200 {"ok": true, "duplicate": true}` | This `event_id` was already applied; nothing changed |
| `401` | Signature missing, wrong, or more than 5 minutes old |
| `404` | No external stage with this id for this organization |
| `409` | The stage is already decided |
| `413` / `415` / `422` | Body too large, not JSON, or invalid fields |
| `429` | Too many calls; retry after `Retry-After` seconds |

### Reading the data (pull mode, or to reconcile)

`GET {stage_url}`, signed over `"<t>."` (the timestamp, a dot, and an empty body). It returns the push-mode `stage.started` body with the current state.

The full format as OpenAPI: `GET {PUBLIC_API_URL}/v1/external/spec`. No sign-in is needed.

## Reference receiver (Node.js)

```js
// npm i express ; SECRET and API_ORIGIN from your secret store.
import crypto from 'node:crypto';
import express from 'express';

const SECRET = process.env.REVIEW_SECRET;
const app = express();
app.use(express.raw({ type: 'application/json', limit: '256kb' }));

const sign = (t, body) => crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
function verify(header, body) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(sign(m[1], body), 'hex'));
}

const seen = new Set(); // use your database in production
app.post('/events', async (req, res) => {
  const body = req.body.toString('utf8');
  if (!verify(req.get('X-Signature'), body)) return res.sendStatus(401);
  const event = JSON.parse(body);
  res.sendStatus(200); // answer fast; work afterwards
  if (event.type !== 'stage.started' || seen.has(event.event_id)) return;
  seen.add(event.event_id);
  // ... create the case in your own database, then report back:
  const update = JSON.stringify({ event_id: `${event.event_id}:in_review`, org_id: event.organization.id, status: 'in_review' });
  const t = Math.floor(Date.now() / 1000);
  await fetch(event.callback.status_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': `t=${t},v1=${sign(t, update)}` },
    body: update,
  });
});
app.listen(3000);
```

## Verify a signature (Python)

```python
import hashlib, hmac, re, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    m = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", header or "")
    if not m or abs(time.time() - int(m.group(1))) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{m.group(1)}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m.group(2))
```

## What the external service needs

- [ ] An HTTPS endpoint that accepts `POST` JSON and answers `2xx` quickly.
- [ ] The signing secret, kept in a secret store, used to verify our `X-Signature` and to sign its own calls.
- [ ] Each `event_id` handled once (retries repeat it); its own unique `event_id` for every status it sends.
- [ ] A clock within 5 minutes of real time.
- [ ] Reachability of `{PUBLIC_API_URL}` for status updates (and for `GET stage_url` in pull mode).
- [ ] For the confidential flag: do not show confidential requests to people who should not see them.

## Security notes

- TLS only. Addresses on the local or private network (localhost, 10.x, 192.168.x, `.local`, `.internal`) are refused, so the API cannot be used to reach internal machines; for local testing set `ALLOW_LOCAL_SERVICE_URLS=true` in `apps/api/.env`. Redirects are not followed.
- **New signing secret** replaces a secret at once; the old one stops working. Rotate it when people with access leave, or if it may have leaked.
- Secrets are write-only in the UI, stored encrypted (AES-256-GCM), and never written to the audit log.
- We never send attachments or owner names.

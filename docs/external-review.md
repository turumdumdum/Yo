# Running a review in an external service

A check (for example the security review) can run in another tool — a GRC platform, a ticket system, your own service. [Product name] then sends the request data to that service and only shows the status it reports back. Reviewers do not use the review form, checklist or decision buttons for that check here.

## Enable it

1. **Admin → Integrations → External review service**: name the service, enter its HTTPS endpoint, and save. One **signing secret** is created. Both sides use it: we sign what we send, and the service signs what it sends back. Copy it into the external service: it is shown once and stored encrypted. "New signing secret" replaces it; the old one stops working at once.
2. **Admin → Reviews → (the check) → When needed and checklist → Where the review happens: in an external service.**
3. Requests submitted from then on send that check to the service. Requests already submitted are not changed.

Set `PUBLIC_API_URL` in `apps/api/.env` to the address where the service can reach the API (used in the callback URLs).

## 1. We send: `stage.started`

When a request is submitted and the check is required, we POST this JSON to your endpoint.

```json
{
  "type": "stage.started",
  "event_id": "8a1f3c0e-6c3a-4b7f-9f43-2f0d7e2a9c11",
  "created_at": "2026-11-20T10:15:00.000Z",
  "organization": { "id": "5d0e…" },
  "request": {
    "id": "b2c4…",
    "title": "Acme Analytics",
    "vendor": "Acme Inc.",
    "website": "https://acme.example",
    "request_type": "New vendor",
    "risk_tier": "High",
    "risk_score": 7,
    "risk_reasons": ["Data classification: Confidential (+3)", "Access to production systems?: Yes (+2)"],
    "confidential": false,
    "submitted_at": "2026-11-20T10:14:58.000Z",
    "answers": {
      "dataClassification": { "label": "Data classification", "value": "Confidential" },
      "platforms": { "label": "Planned platform", "value": ["Web", "API"] }
    },
    "config_requirements": [
      {
        "id": "sso",
        "title": "Sign-in through our identity provider (SSO)",
        "requirement": "People sign in through our identity provider …",
        "verification": "Screenshot or export of the SSO settings …",
        "category": "Identity & access",
        "level": "required"
      }
    ]
  },
  "stage": { "id": "e91d…", "name": "Security review", "due_at": "2026-11-27T10:14:58.000Z" },
  "callback": {
    "status_url": "https://api.example.com/v1/external/stages/e91d…/status",
    "stage_url": "https://api.example.com/v1/external/stages/e91d…"
  }
}
```

What is sent:

- `answers`: the answers of the request, with the question label. Answers naming people (owners) are left out.
- `confidential`: `true` when the request is confidential. Treat it with the same care in your tool.
- Attachments are never sent.

### Delivery

- `POST` to your HTTPS endpoint, `Content-Type: application/json`.
- Header `X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing secret, "<t>.<raw body>")>`.
- Answer with any `2xx` within 10 seconds; do the work afterwards.
- Anything else is retried with exponential backoff, up to 8 attempts. The same `event_id` may therefore arrive more than once: process each `event_id` once.

## 2. You send: status updates

`POST {PUBLIC_API_URL}/v1/external/stages/{stageId}/status`

```json
{
  "event_id": "c7d9…",
  "org_id": "5d0e…",
  "status": "approved_with_conditions",
  "comment": "Reviewed against policy SEC-01.",
  "conditions": "Enable SSO before rollout.",
  "external_id": "GRC-1042",
  "external_url": "https://grc.example.com/reviews/1042"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `event_id` | yes | Unique per update, at most 200 characters. A repeated id is ignored |
| `org_id` | yes | From `organization.id` |
| `status` | yes | `in_review`, `waiting_for_requester`, `approved`, `approved_with_conditions`, `rejected` |
| `comment` | for `rejected` | Why it was rejected; at most 2000 characters |
| `conditions` | for `approved_with_conditions` | What must be done; at most 2000 characters |
| `external_id` | no | Your reference |
| `external_url` | no | Link to the review in your tool; must start with `https://` |

- `waiting_for_requester` pauses the check's clock; `in_review` resumes it and moves the due date by the paused time.
- A decision closes the check. When it was the last open check, the request is approved or rejected.

Sign it the same way, with the same **signing secret**: `X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing secret, "<t>.<raw body>")>`. Timestamps more than 5 minutes off are refused.

| Response | Meaning |
| --- | --- |
| `200 {"ok": true}` | Applied |
| `200 {"ok": true, "duplicate": true}` | This `event_id` was already applied; nothing changed |
| `401` | Missing or wrong signature, or timestamp out of range |
| `404` | Unknown stage, or not an external stage of this organization |
| `409` | The check is already decided |
| `422` | Invalid body (unknown status, missing comment or conditions, bad URL) |
| `429` | Too many requests; retry later |

### Re-reading the data

`GET {stage_url}` returns the same `stage.started` payload with the current state, for reconciliation. Sign it over `"<t>."` (timestamp, dot, empty body) with the signing secret.

## Verifying our signature

Node.js:

```js
import crypto from 'node:crypto';

export function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === 32 && crypto.timingSafeEqual(given, Buffer.from(expected, 'hex'));
}
```

Python:

```python
import hashlib, hmac, time

def verify(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

Always verify against the raw request body, before parsing it.

## Sending a status with curl

```sh
BODY='{"event_id":"c7d9-1","org_id":"5d0e…","status":"approved","comment":"OK"}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$INBOUND_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST "$PUBLIC_API_URL/v1/external/stages/$STAGE_ID/status" \
  -H 'Content-Type: application/json' \
  -H "X-Signature: t=$T,v1=$SIG" \
  --data "$BODY"
```

## Security notes

- HTTPS only, both ways. Keep both secrets in a secret store; rotate them in Admin → Integrations (old ones stop working at once).
- We never send attachments or owner names. Respect the `confidential` flag in your tool.
- Only the stages marked as external can be changed through this API, only for the organization of the signing secret, and only while they are open.
- Every update is written to the audit log.

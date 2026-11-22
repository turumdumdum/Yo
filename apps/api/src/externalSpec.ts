import { EXTERNAL_STATUSES } from '@app/shared';

// OpenAPI 3.1 description of the exchange with a review service, served at
// GET /v1/external/spec. Public: it holds no organization data and no secrets.

const signature = {
  name: 'X-Signature',
  in: 'header',
  required: true,
  description:
    't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the service secret>. Requests older than 5 minutes are refused. GET requests sign an empty body.',
  schema: { type: 'string', example: 't=1767225600,v1=5f2b…' },
};

const outboundHeaders = {
  'X-Signature': { description: signature.description, schema: { type: 'string' } },
  'X-Service-Id': { description: 'The id of the review service in Admin → Integrations.', schema: { type: 'string' } },
  'X-Event-Id': { description: 'Unique per event. Deliveries are retried; ignore an id you have seen.', schema: { type: 'string' } },
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const error = { description: 'Error', content: { 'application/json': { schema: ref('Error') } } };

export function externalReviewSpec(publicApiUrl?: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: '[Product name] review service exchange',
      version: '1.0.0',
      description:
        'How a review service (for example a security review tool running elsewhere) receives reviews and reports decisions. Add the service in Admin → Integrations → Review services, copy its secret, and pick it for a review in Admin → Reviews. Every request in both directions is signed with that secret.',
    },
    servers: [{ url: `${(publicApiUrl ?? 'https://api.example.com').replace(/\/+$/, '')}/v1` }],
    paths: {
      '/external/stages/{stageId}/status': {
        post: {
          summary: 'Report the status or decision of a review',
          description: 'Repeating an event_id changes nothing. A decided review cannot be changed (409).',
          parameters: [{ name: 'stageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, signature],
          requestBody: { required: true, content: { 'application/json': { schema: ref('StatusUpdate') } } },
          responses: {
            '200': { description: 'Applied, or a duplicate event', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, duplicate: { type: 'boolean' } } } } } },
            '400': error,
            '401': { ...error, description: 'Missing, wrong or stale signature, or unknown organization or review' },
            '404': error,
            '409': { ...error, description: 'The review is already decided' },
            '422': { ...error, description: 'Invalid body' },
            '429': { ...error, description: 'Too many requests' },
          },
        },
      },
      '/external/stages/{stageId}': {
        get: {
          summary: 'Read the request behind a review',
          description: 'This is how a service in pull mode reads the answers. Sign an empty body.',
          parameters: [
            { name: 'stageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'org_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
            signature,
          ],
          responses: {
            '200': { description: 'The full stage.started payload plus the current status', content: { 'application/json': { schema: { allOf: [ref('StageStartedPush'), { type: 'object', properties: { stage_status: { type: 'string' } } }] } } } },
            '401': { ...error, description: 'Missing, wrong or stale signature, or unknown organization or review' },
            '404': error,
          },
        },
      },
    },
    webhooks: {
      ping: {
        post: {
          summary: 'Test sent from Admin → Integrations. Answer 2xx.',
          parameters: [],
          requestBody: { content: { 'application/json': { schema: ref('Ping') } } },
          responses: { '200': { description: 'Received' } },
          'x-headers': outboundHeaders,
        },
      },
      'stage.started (push)': {
        post: {
          summary: 'A review started; the answers are included. Answer 2xx; other answers are retried with backoff for about a day.',
          requestBody: { content: { 'application/json': { schema: ref('StageStartedPush') } } },
          responses: { '200': { description: 'Received' } },
          'x-headers': outboundHeaders,
        },
      },
      'stage.started (pull)': {
        post: {
          summary: 'A review started; no answers are sent. Read them with GET /external/stages/{stageId} (callback.stage_url) and keep your own copy only if you need one.',
          requestBody: { content: { 'application/json': { schema: ref('StageStartedPull') } } },
          responses: { '200': { description: 'Received' } },
          'x-headers': outboundHeaders,
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
        StatusUpdate: {
          type: 'object',
          additionalProperties: false,
          required: ['event_id', 'org_id', 'status'],
          properties: {
            event_id: { type: 'string', minLength: 1, maxLength: 200 },
            org_id: { type: 'string', format: 'uuid' },
            status: { enum: [...EXTERNAL_STATUSES] },
            comment: { type: 'string', maxLength: 2000, description: 'Shown to the requester' },
            conditions: { type: 'string', maxLength: 2000, description: 'For approved_with_conditions' },
            external_id: { type: 'string', maxLength: 200 },
            external_url: { type: 'string', format: 'uri', pattern: '^https://' },
          },
        },
        Ping: {
          type: 'object',
          required: ['type', 'event_id', 'created_at', 'organization', 'service'],
          properties: {
            type: { const: 'ping' },
            event_id: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            organization: ref('Id'),
            service: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
        Id: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        Stage: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, due_at: { type: ['string', 'null'], format: 'date-time' } } },
        Callback: {
          type: 'object',
          properties: {
            status_url: { type: ['string', 'null'], description: 'POST status updates here' },
            stage_url: { type: ['string', 'null'], description: 'GET the request here' },
          },
        },
        StageStartedPush: {
          type: 'object',
          properties: {
            type: { const: 'stage.started' },
            event_id: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            data_mode: { const: 'push' },
            organization: ref('Id'),
            service: { type: 'object', properties: { id: { type: 'string' } } },
            request: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                title: { type: ['string', 'null'] },
                vendor: { type: ['string', 'null'] },
                website: { type: ['string', 'null'] },
                request_type: { type: ['string', 'null'] },
                risk_tier: { enum: ['Low', 'Medium', 'High', 'Critical'] },
                risk_score: { type: 'number' },
                risk_reasons: { type: 'array', items: { type: 'string' } },
                confidential: { type: 'boolean' },
                submitted_at: { type: 'string', format: 'date-time' },
                answers: {
                  type: 'object',
                  description: 'Answers by question id. Owners and personal details only when "send all answers" is on.',
                  additionalProperties: { type: 'object', properties: { label: { type: 'string' }, value: {} } },
                },
                config_requirements: { type: 'array', items: {} },
              },
            },
            stage: ref('Stage'),
            callback: ref('Callback'),
          },
        },
        StageStartedPull: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { const: 'stage.started' },
            event_id: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            data_mode: { const: 'pull' },
            organization: ref('Id'),
            request: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' }, confidential: { type: 'boolean' } } },
            stage: ref('Stage'),
            callback: ref('Callback'),
          },
        },
      },
    },
  };
}

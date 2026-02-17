# tls-upgrader

Automated Cloudflare Worker that upgrades zones to TLS 1.3 and sends email notifications using Cloudflare Queues.

## Architecture

Single Cloudflare Worker with three handlers:
- fetch(): Authenticated HTTP endpoint for manual triggering
- scheduled(): Runs on cron to check and upgrade zone TLS settings
- queue(): Processes upgrade notifications and sends emails via Cloudflare Email Routing

Uses Cloudflare Queues to connect the scheduled and queue handlers, and the send_email binding with allowed_destination_addresses for notifications.

## How It Works

### Scheduled Handler

Runs on cron schedule (default: daily at 2 AM UTC):

1. Fetches all zones in the account via Cloudflare API
2. Checks current minimum TLS version for each zone
3. Upgrades zones not on TLS 1.3 via API PATCH request
4. Sends message to queue for each upgraded zone
5. Logs summary statistics

### Queue Handler

Processes messages from the queue:

1. Receives batch of upgrade notifications from queue
2. Sanitizes all values (HTML escaping, header injection prevention)
3. Constructs raw RFC 5322 email with HTML body
4. Sends email using Cloudflare send_email binding and EmailMessage class
5. Acknowledges successful sends or retries failures

### Fetch Handler

Provides an authenticated HTTP endpoint for manual triggering:

1. Validates Authorization header against AUTH_SECRET
2. Returns 401 for unauthenticated requests
3. Calls the scheduled handler on success
4. Returns generic error messages (no internal details leaked)

## API Endpoints Used

- List Zones: GET /client/v4/zones
- Get TLS Setting: GET /client/v4/zones/{zone_id}/settings/min_tls_version
- Update TLS Setting: PATCH /client/v4/zones/{zone_id}/settings/min_tls_version

## Prerequisites

- Node.js and npm installed
- Wrangler CLI installed: npm install -g wrangler
- Cloudflare account
- API token with Zone Settings Edit permission
- Verified destination email address in Cloudflare Email Routing

## Deployment From Scratch

### Step 1: Create API Token

Create Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens

Required permission:
- Zone > Zone Settings > Edit

Zone Resources:
- Include > All zones from an account (select your account)
  OR
- Include > Specific zone (select individual zones)

### Step 2: Verify Email Address

1. Go to Cloudflare dashboard and select your domain
2. Navigate to Email Routing > Destination addresses
3. Add your destination email address
4. Check inbox for verification email and click the link
5. Confirm status shows "Verified" in the dashboard

### Step 3: Clone and Configure

```bash
git clone https://github.com/nkuntz1934/tls-upgrader.git
cd tls-upgrader
npm install
```

Copy template and configure:

```bash
cp wrangler.jsonc.template wrangler.jsonc
```

Edit wrangler.jsonc:
- Replace YOUR_ACCOUNT_ID with your Cloudflare account ID
- Replace YOUR_EMAIL@example.com with your verified email address

### Step 4: Create Queues

```bash
wrangler queues create tls-upgrade-notifications
wrangler queues create tls-upgrade-notifications-dlq
```

### Step 5: Set Secrets

```bash
echo "YOUR_API_TOKEN" | wrangler secret put CF_API_TOKEN
openssl rand -hex 32 | wrangler secret put AUTH_SECRET
```

Save the AUTH_SECRET value for manual triggering.

### Step 6: Deploy Worker

```bash
wrangler deploy
```

### Step 7: Verify Deployment

```bash
wrangler deployments list --name tls-upgrade-worker
wrangler tail tls-upgrade-worker
```

## Configuration

### Cron Schedule

Modify in wrangler.jsonc:

```jsonc
"triggers": {
  "crons": ["0 2 * * *"]
}
```

Common cron patterns:
- "0 2 * * *" - Daily at 2 AM UTC
- "0 */6 * * *" - Every 6 hours
- "0 0 * * 0" - Weekly on Sunday at midnight

### Email Recipient

Modify in wrangler.jsonc send_email section:

```jsonc
"send_email": [
  {
    "name": "EMAIL",
    "allowed_destination_addresses": ["your-email@example.com"]
  }
]
```

The destination address must be verified in Email Routing.

### Queue Settings

Adjust in wrangler.jsonc consumers section:
- max_batch_size: Messages processed per batch (default: 10)
- max_batch_timeout: Seconds before processing partial batch (default: 30)
- max_retries: Retry attempts for failed messages (default: 3)

## Monitoring

### View Logs

```bash
wrangler tail tls-upgrade-worker
```

### Queue Stats

```bash
wrangler queues list
wrangler queues info tls-upgrade-notifications
```

### Manual Trigger

Requires the AUTH_SECRET set during deployment:

```bash
curl -H "Authorization: Bearer YOUR_AUTH_SECRET" \
  https://YOUR-WORKER-URL.workers.dev
```

Unauthenticated requests return 401.

## Error Handling

- Failed zone upgrades are logged but don't stop processing other zones
- Failed email sends retry up to 3 times automatically
- Messages exceeding max retries go to dead letter queue
- All errors logged server-side to Cloudflare Workers Analytics
- HTTP error responses return generic messages (no internal details exposed)

## Files

- tls-upgrade-worker.js: Worker with fetch, scheduled, and queue handlers
- wrangler.jsonc: Worker configuration (gitignored, contains account info)
- wrangler.jsonc.template: Configuration template for deployment
- package.json: Project metadata
- .gitignore: Excludes sensitive configuration files
- README.md: This file

## Queue Flow Diagram

```
Cron Trigger (daily 2 AM UTC)
  |
  v
scheduled() handler
  |
  +-- Fetch all zones
  |     |
  |     +-- Get current TLS version
  |     |
  |     +-- If not 1.3: Upgrade via API
  |           |
  |           v
  |         Send message to queue
  |           |
  v           v
queue() handler
  |
  +-- Receive batch of messages
  |
  +-- For each message:
        |
        +-- Sanitize values (HTML escape, header injection prevention)
        |
        +-- Construct raw RFC 5322 email
        |
        +-- Send via EmailMessage + send_email binding
        |
        +-- Acknowledge or retry
```

## Security

- Fetch handler requires Bearer token authentication (AUTH_SECRET)
- API token and AUTH_SECRET stored as Wrangler secrets (never in code or config)
- Email body values are HTML-escaped to prevent injection
- Email subject is sanitized to prevent header injection (CRLF stripped)
- Error responses return generic messages; details logged server-side only
- Email binding uses allowed_destination_addresses to restrict recipients
- Queue messages encrypted at rest
- Dead letter queue captures failed messages for investigation
- No credentials or account IDs committed to git

## Troubleshooting

### Email not sending

1. Verify email address shows "Verified" in Email Routing > Destination addresses
2. Confirm send_email binding uses allowed_destination_addresses (not destination_address)
3. Ensure the from address domain has Email Routing enabled
4. View logs: wrangler tail tls-upgrade-worker

### TLS upgrades not happening

1. Verify API token has Zone > Zone Settings > Edit permission
2. Ensure token is scoped to correct zones or account
3. Check secrets are set: wrangler secret list
4. View logs for API errors: wrangler tail tls-upgrade-worker

If you get 403 errors, recreate the token with Zone > Zone Settings > Edit permission.

### Queue messages not processing

1. Check queue consumer is configured: wrangler queues info tls-upgrade-notifications
2. Verify worker has both producer and consumer bindings in wrangler.jsonc
3. Check dead letter queue: wrangler queues info tls-upgrade-notifications-dlq

### Manual trigger returning 401

1. Verify AUTH_SECRET is set: wrangler secret list
2. Ensure Authorization header format is: Bearer YOUR_AUTH_SECRET

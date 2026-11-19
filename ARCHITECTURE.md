# Architecture Overview

## System Flow

```
┌─────────────┐
│   ClickUp   │
│  Workspace  │
└──────┬──────┘
       │ (Webhook event)
       │ POST /webhook/clickup
       ▼
┌──────────────────────────────────────┐
│   Node.js Webhook Service            │
│  ┌────────────────────────────────┐  │
│  │ 1. Receive Webhook Event       │  │
│  │    - Validate Signature        │  │
│  │    - Parse JSON                │  │
│  └───────────┬────────────────────┘  │
│              │                       │
│  ┌───────────▼────────────────────┐  │
│  │ 2. Route to Handler            │  │
│  │    - taskUpdated               │  │
│  │    - taskStatusUpdated         │  │
│  │    - taskCommentAdded          │  │
│  │    - listUpdated               │  │
│  └───────────┬────────────────────┘  │
│              │                       │
│  ┌───────────▼────────────────────┐  │
│  │ 3. Check Custom Fields         │  │
│  │    - Is field completed?       │  │
│  │    - Which field changed?      │  │
│  └───────────┬────────────────────┘  │
│              │                       │
│  ┌───────────▼────────────────────┐  │
│  │ 4. Call ClickUp API            │  │
│  │    - Update Task Status        │  │
│  │    - Log Changes               │  │
│  └───────────┬────────────────────┘  │
│              │                       │
│  ┌───────────▼────────────────────┐  │
│  │ 5. Return 200 OK               │  │
│  │    (Prevent webhook retry)     │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
       │
       │ (ClickUp API calls)
       ▼
┌─────────────────────────────┐
│   ClickUp API v2            │
│  - Update Task Status       │
│  - Get Task Details         │
│  - Fetch Custom Fields      │
└─────────────────────────────┘
```

## Project Structure

```
clickup-webhook-service/
├── src/
│   ├── index.js                 # Main Express server
│   ├── routes/
│   │   └── webhook.js           # Webhook route handler
│   ├── services/
│   │   ├── clickupClient.js     # ClickUp API client
│   │   └── webhookHandler.js    # Webhook event processing logic
│   └── utils/
│       ├── logger.js            # Logging utility
│       └── security.js          # Webhook signature validation
├── .env                         # Environment variables (keep secret!)
├── .gitignore                   # Git ignore file
├── package.json                 # NPM dependencies & scripts
├── README.md                    # Full documentation
├── QUICKSTART.md                # 5-minute setup guide
├── WEBHOOK_EXAMPLES.md          # Example payloads for testing
└── ARCHITECTURE.md              # This file
```

## Key Components

### Express Server (index.js)
- Sets up HTTP server on configurable port
- Registers routes and middleware
- Provides health check endpoint
- Handles errors globally

### Webhook Route (routes/webhook.js)
- Accepts POST requests at `/webhook/clickup`
- Validates webhook signature for security
- Passes event to handler asynchronously
- Returns 200 immediately (prevents retries)

### ClickUp Client (services/clickupClient.js)
- Abstracts ClickUp API v2 calls and the v3 home-List move endpoint
- Handles authentication with API token
- Methods: updateTaskStatus, getTask, getCustomField, isFieldCompleted
- Includes error handling and logging

### Webhook Handler (services/webhookHandler.js)
- Routes events to specific handlers
- Implements field change detection
- Decides when to update task status
- Currently: Updates task when any custom field is marked as "completed"

### Security (utils/security.js)
- Validates webhook signatures with HMAC-SHA256
- Ensures requests come from ClickUp
- Uses webhook secret from environment

### Logger (utils/logger.js)
- Consistent timestamp logging
- Levels: info, error, warn, debug
- Debug logs only in development mode

## Event Handling Flow

```
Webhook Event Received
    │
    ├─► Signature Validation
    │   ├─► Valid ✓
    │   │   └─► Continue
    │   └─► Invalid ✗
    │       └─► Return 401 (Unauthorized)
    │
    ├─► Event Type Routing
    │   ├─► taskUpdated
    │   │   └─► Check Custom Fields
    │   │       └─► Is field completed?
    │   │           ├─► Yes → Update Task Status
    │   │           └─► No → Log & Continue
    │   │
    │   ├─► taskStatusUpdated
    │   │   └─► Log Status Change
    │   │
    │   ├─► taskCommentAdded
    │   │   └─► Log Comment
    │   │
    │   └─► listUpdated
    │       └─► Log List Update
    │
    └─► Return 200 OK
        (Webhook complete, don't retry)
```

## Security Model

1. **Webhook Signature Validation**
   - ClickUp signs each webhook with HMAC-SHA256
   - Service validates signature using webhook secret
   - Only valid signatures are processed

2. **API Token Security**
   - Stored in environment variables only
   - Never exposed in code or logs
   - Should be rotated regularly

3. **HTTPS Only (Production)**
   - Use HTTPS URLs for ClickUp webhook settings
   - Protects data in transit

4. **Error Handling**
   - No sensitive data in error messages
   - Errors logged but not sent to client

## Deployment Architecture

```
Local Development:
├─ http://localhost:3000
├─ Direct testing
└─ Uses ngrok for public access

Production Cloud:
├─ Heroku: https://your-app.herokuapp.com/webhook/clickup
├─ AWS Lambda: https://abc123.execute-api.region.amazonaws.com/webhook/clickup
├─ DigitalOcean App Platform: https://your-app.ondigitalocean.app/webhook/clickup
├─ Docker Container: Custom domain/IP
└─ Traditional VPS: Custom domain with reverse proxy
```

## Data Flow for Task Status Update

```
1. ClickUp User Action
   └─ User changes status, Effort Estimate, or Assigned Sprint

2. ClickUp Webhook
   └─ Sends event: taskUpdated (taskStatusUpdated is also supported)
      └─ Includes: history_items with field details

3. Node.js Service
   └─ Receives webhook
   └─ Validates signature
   └─ Serializes work per task and verifies a positive estimate
   └─ Resolves explicit scheduling intent or reconciles the permanent assignment
   └─ Protects testing/later statuses; reads completion IDs from src/config.js
   └─ Calls ClickUp API: setCustomFieldValue / updateTask, only when needed

4. ClickUp API Response
   └─ Updates status to READY TO SCHEDULE, SPRINT 0/+1/+2, or IN TESTING
   └─ Synchronizes sprint dates; clears them when unassigned
   └─ Returns updated task object

5. ClickUp UI Update
   └─ Task appears in the resolved status (refresh the view if needed)
   └─ Notification sent to assignee (if configured)
```

The 00:05 America/New_York daily check calls the same sprint reconciliation
service without scheduling intent, so relative status rollover never reassigns
tasks to a different sprint. `npm run sprints:preview` uses the same logic without
writes. Native Complete Sprint must also be recorded by List ID in configuration;
dates and archive flags are not treated as completion.

### Linked Sprint Item Lifecycle

`services/sprintTasks.js` is called by `SprintRouting`, not by a separate
scheduler or duplicate automation rule. The resolver selects the sprint once.
The item planner preflights destination statuses before any backlog
assignment/date writes. Sprint tasks carry no custom fields. Preview returns
the plan without calling its applying methods.

Creation uses API v2 with the source name, description, Sprint Points, priority
(from Backlog Priority), Item Type and Product tags, the initial
`backlog` status (`sprintTasks.initialStatus`), a native task
link, and a `Backlog task: <url>` line that doubles as the ownership marker.
Restoring or moving refreshes the copied description, points, priority, and tags.
Rescheduling uses API v3 to change the same item's home List. Existing
development status is preserved by matching destination status names and mapping
status IDs when necessary; no progress is copied back to Master Backlog.
Names and the Product tag flow only from backlog to sprint.

Discovery prefers native links and falls back to a per-run inventory of sprint
Lists, including archived tasks, matched by exact source-ID markers. This also
recovers creation whose response was lost. Successful writes are checked with
fresh task reads. Do not remove ownership markers or clone managed descriptions.
Ambiguous ownership and incompatible fields/statuses fail explicitly.

Metadata-only events synchronize existing items without scheduling. Protected
backlog stages can receive this metadata sync without changing backlog dates or
status. An explicit READY TO SCHEDULE status event clears Assigned Sprint and
backlog dates rather than reconciling to the previous assignment. Unassigned
items are archived using API v2; scheduling again restores the same item before
moving it, preserving its development status. Archived inventory participates
in discovery, so restart recovery does not create a replacement task. Metadata
events do not restore archived items; protected or completed/archived assignments
do not backfill or restore them.

The workflow is not an atomic transaction: a later API failure can leave earlier
writes applied. Reconciliation repairs partial results using the same linked
task instead of intentionally making another copy. Locks are in-process only;
run a single service instance and avoid overlapping applying CLI sweeps.

## Extension Points

Future enhancements can be added at:

1. **More Event Handlers**
   - Add cases in webhookHandler.js for new event types

2. **Custom Business Logic**
   - Complex field value checking
   - Multiple field combinations
   - Conditional status updates

3. **Integrations**
   - Slack notifications
   - Email alerts
   - Database logging
   - Third-party APIs

4. **Advanced Features**
   - Queue system for high volume
   - Webhook retry logic
   - Request throttling
   - Analytics/metrics

## Environment Configuration

```
Production Requirements:
├─ CLICKUP_API_TOKEN: Valid ClickUp API token
├─ CLICKUP_WEBHOOK_SECRET: Webhook secret from ClickUp
├─ PORT: Usually 443 or 80 (or higher number if behind proxy)
├─ NODE_ENV: "production"
└─ Optional: Logging service credentials, database URLs, etc.
```

For more details, see [README.md](./README.md) and [QUICKSTART.md](./QUICKSTART.md)

# Squarespace → Chatwoot webhook relay

This example service receives Squarespace form submissions and relays them to a Chatwoot inbox using the Chatwoot REST API. It is designed to run alongside the existing `docker-compose` stack or on a lightweight serverless platform.

## Overview

Squarespace form storage supports sending submissions to an arbitrary HTTPS endpoint. Because Chatwoot requires authenticated API requests, a small middleware service is necessary to translate the unauthenticated Squarespace webhook into Chatwoot API calls. This project provides:

- An Express server with a `/webhooks/squarespace` endpoint that accepts Squarespace form payloads.
- Mapping logic that extracts common fields (name, email, phone, message) and preserves any additional form fields.
- API calls to create/find the Chatwoot contact, open a conversation in the specified inbox, and append the submission as the first message.

## Prerequisites

- Node.js 18 or newer.
- An existing Chatwoot deployment (see the repository root for Docker-based instructions).
- A Chatwoot API access token with permission to create contacts and conversations.
- A Squarespace site on a plan that supports form submission webhooks.

## Setup

1. Install dependencies:

   ```bash
   cd integrations/squarespace-chatwoot-webhook
   npm install
   ```

2. Copy the example environment file and edit it with your configuration:

   ```bash
   cp .env.example .env
   ```

   | Variable | Description |
   | --- | --- |
   | `PORT` | Local port to expose the Express server (default `8080`). |
   | `CHATWOOT_BASE_URL` | Base URL of your Chatwoot instance (e.g. `https://support.mie.ngo`). |
   | `CHATWOOT_ACCOUNT_ID` | Numeric Chatwoot account ID (visible under *Settings → Account*. |
   | `CHATWOOT_INBOX_ID` | Numeric ID of the Chatwoot inbox that should receive submissions. |
   | `CHATWOOT_API_TOKEN` | Chatwoot API access token (create under *Settings → API Access Tokens*). |
   | `CHATWOOT_SOURCE_ID` | (Optional) Label for the `source_id` field recorded on the conversation. |

3. Start the server:

   ```bash
   npm start
   ```

   Deploy behind HTTPS when hosting publicly (Squarespace requires HTTPS endpoints).

## Squarespace configuration

1. In Squarespace, open **Settings → Advanced → Developer API Keys** and ensure you have access to manage webhooks.
2. Navigate to the form block that should be relayed to Chatwoot and open **Storage** settings.
3. Add a new **Webhook** storage option with the public URL to your server's `/webhooks/squarespace` endpoint (for example, `https://hooks.mie.ngo/webhooks/squarespace`).
4. Submit a test entry and confirm the Express server logs the request and responds with `{"status":"ok"}`.

Squarespace sends a JSON payload that looks like:

```json
{
  "formSubmission": {
    "id": "1f04d5bb-...",
    "formName": "Contact us",
    "timestamp": 1706131200000,
    "fields": [
      { "name": "Name", "value": "Ada Lovelace" },
      { "name": "Email", "value": "ada@example.com" },
      { "name": "Message", "value": "Please call me." }
    ]
  },
  "eventType": "SUBMISSION",
  "website": {
    "id": "YourSiteId"
  }
}
```

The relay extracts common fields automatically. Any additional fields are appended to the Chatwoot message body under "Submission details" so that agents can view the entire form.

## Security considerations

- Configure a unique, secret URL or reverse-proxy the endpoint behind basic authentication and IP restrictions.
- Optionally validate the Squarespace `X-Signature` header if you store the shared secret (see Squarespace docs) to prevent spoofed submissions.
- Keep the Chatwoot API token secret; never embed it directly in Squarespace.

## Deployment tips

- Run the service with a process manager such as `pm2` or Docker. A sample Docker command:

  ```bash
  docker run -d \
    --name squarespace-chatwoot-webhook \
    --restart always \
    --env-file .env \
    -p 8080:8080 \
    mie-tech/squarespace-chatwoot-webhook:latest
  ```

  Build the image locally with `docker build -t mie-tech/squarespace-chatwoot-webhook .` if you maintain your own registry.

- When hosting behind the existing Chatwoot reverse proxy, add a location block in Nginx that forwards `https://hooks.mie.ngo` to this service.
- Monitor logs or connect the service to observability tooling so failed submissions trigger alerts.

## Next steps

- Extend `buildMessageContent` in `index.js` to format complex fields (checkboxes, multi-line answers) or to attach files using the Chatwoot attachments API.
- Map Squarespace campaign source data into Chatwoot custom attributes for richer reporting.
- Combine with Chatwoot automation (workflows, auto-assignment) to route Squarespace leads to the right team.

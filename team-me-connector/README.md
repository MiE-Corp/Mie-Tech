# Team Me connector

A Claude connector (a remote MCP server) and a small shared backend for the **Team Me Command Center** at `ai.mie.ngo`.

The Command Center runs on ChatGPT's hosting behind "Sign in with ChatGPT" and calls Claude through an API key. Those calls start fresh every time, and Claude in claude.ai (projects, chats, Claude Code) has no way into the Command Center. This service is the shared place both sides use:

- **Claude** connects at `https://mcp.mie.ngo/mcp`. It can read the six workspaces, pick up queued assignments, save deliverables (final output, draft and review), queue its own assignments, and put external actions in the approval queue.
- **The Command Center** uses the REST API under `https://mcp.mie.ngo/api` with a private key. It queues assignments, saves its own deliverables, shows the approval queue, and records the owner's approve or decline decisions.

Only the owner can approve. The connector has no tool that approves, publishes or sends anything.

## Add it to Claude

Once the service is running at `https://mcp.mie.ngo`:

1. In Claude, open **Settings > Connectors** and choose **Add custom connector**.
2. Name it `Team Me` and paste `https://mcp.mie.ngo/mcp` as the URL. Leave the advanced OAuth fields empty.
3. Choose **Add**, then **Connect**. A "Connect to Team Me" page opens.
4. Enter the Team Me passphrase and choose **Allow**.

To use it in a project or chat, turn **Team Me** on from the tools menu. For Claude Code:

```sh
claude mcp add --transport http team-me https://mcp.mie.ngo/mcp
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_workspaces` | The workspaces, with queued assignments and pending approvals per workspace |
| `list_assignments` | Assignments, filtered by workspace and status |
| `get_assignment` | One assignment with its deliverables and approvals |
| `create_assignment` | Queue a Research, Build or Action assignment |
| `update_assignment_status` | Mark an assignment in progress, completed or cancelled, with a note |
| `submit_deliverable` | Save a deliverable (Markdown), optionally with its draft and review; completes the assignment |
| `list_deliverables` / `get_deliverable` | Read deliverables |
| `request_approval` | Add an external action to the approval queue |
| `list_approvals` | Read the queue and the owner's decisions |

## How sign-in works

The service is its own OAuth 2.1 authorization server, built on the MCP TypeScript SDK's auth router:

- Claude registers itself through dynamic client registration. Only Claude's callbacks (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) and local loopback callbacks (Claude Code) are accepted.
- The sign-in page asks for the owner passphrase. Five wrong tries end that sign-in, and the page is rate limited.
- Access tokens last an hour and are signed with `TOKEN_SIGNING_SECRET`. Refresh tokens last 30 days, are stored only as hashes, and change on every use.
- Tokens are bound to `https://mcp.mie.ngo/mcp` (RFC 8707) and the `team-me` scope.

To sign every app out at once, change `TOKEN_SIGNING_SECRET` and delete the `refreshTokens` entries in the data file.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | yes | Public origin, e.g. `https://mcp.mie.ngo` |
| `OWNER_PASSPHRASE_HASH` | yes | Output of `npm run hash-passphrase` |
| `TOKEN_SIGNING_SECRET` | yes | At least 32 random characters, e.g. `openssl rand -base64 48` |
| `COMMAND_CENTER_API_KEY` | for `/api` | At least 32 random characters, e.g. `openssl rand -hex 32`. Unset turns `/api` off |
| `COMMAND_CENTER_ORIGINS` | no | Browser origins allowed to call `/api` (default `https://ai.mie.ngo`) |
| `DATA_FILE` | yes in production | JSON data file, e.g. `/data/team-me.json`. Unset keeps everything in memory |
| `ALLOWED_REDIRECT_URIS` | no | Comma-separated OAuth callbacks (default: Claude's two) |
| `ALLOW_LOOPBACK_REDIRECTS` | no | Accept `http://localhost` callbacks for Claude Code (default `true`) |
| `ACCESS_TOKEN_TTL_SECONDS` | no | Default `3600` |
| `REFRESH_TOKEN_TTL_DAYS` | no | Default `30` |
| `TRUST_PROXY` | no | Proxy hops in front of the app (default `1` for Azure Container Apps; `2` behind Cloudflare's proxy as well) |
| `PORT` | no | Default `8080` |

All state is one JSON file, so run exactly one replica.

## Deploy on Azure Container Apps

The Mie-Tech repo already deploys Chatwoot to Azure Container Apps (resource group `TeamMe-WestUS`, registry `azcrfinal27341`). These steps add the connector next to it. Run them once with the Azure CLI, replacing `<environment>` with the Container Apps environment name (`az containerapp env list -g TeamMe-WestUS -o table`).

1. Make the three secrets and keep them somewhere safe:

   ```sh
   cd team-me-connector && npm ci && npm run build
   npm run hash-passphrase            # OWNER_PASSPHRASE_HASH
   openssl rand -base64 48            # TOKEN_SIGNING_SECRET
   openssl rand -hex 32               # COMMAND_CENTER_API_KEY
   ```

2. Build the image in the registry:

   ```sh
   az acr build --registry azcrfinal27341 --image team-me-connector:0.1.0 team-me-connector
   ```

3. Create a file share for the data file and attach it to the environment:

   ```sh
   # <account> is a new lowercase name, e.g. teammedata2026
   az storage account create -g TeamMe-WestUS -n <account> --sku Standard_LRS
   az storage share-rm create -g TeamMe-WestUS --storage-account <account> -n team-me
   az containerapp env storage set -g TeamMe-WestUS -n <environment> --storage-name team-me \
     --azure-file-account-name <account> \
     --azure-file-account-key "$(az storage account keys list -g TeamMe-WestUS -n <account> --query [0].value -o tsv)" \
     --azure-file-share-name team-me --access-mode ReadWrite
   ```

4. Create the app with one replica:

   ```sh
   az containerapp create -g TeamMe-WestUS -n team-me-connector --environment <environment> \
     --image azcrfinal27341.azurecr.io/team-me-connector:0.1.0 --registry-server azcrfinal27341.azurecr.io \
     --ingress external --target-port 8080 --min-replicas 1 --max-replicas 1 \
     --secrets owner-hash='<OWNER_PASSPHRASE_HASH>' signing-secret='<TOKEN_SIGNING_SECRET>' cc-key='<COMMAND_CENTER_API_KEY>' \
     --env-vars PUBLIC_BASE_URL=https://mcp.mie.ngo DATA_FILE=/data/team-me.json \
       OWNER_PASSPHRASE_HASH=secretref:owner-hash TOKEN_SIGNING_SECRET=secretref:signing-secret COMMAND_CENTER_API_KEY=secretref:cc-key
   ```

5. Mount the share at `/data`: export the app with `az containerapp show -g TeamMe-WestUS -n team-me-connector -o yaml > app.yaml`, add the volume below, then `az containerapp update -g TeamMe-WestUS -n team-me-connector --yaml app.yaml`.

   ```yaml
   properties:
     template:
       containers:
         - name: team-me-connector
           volumeMounts:
             - volumeName: data
               mountPath: /data
       volumes:
         - name: data
           storageType: AzureFile
           storageName: team-me
           mountOptions: uid=1000,gid=1000,dir_mode=0700,file_mode=0600
   ```

6. Point `mcp.mie.ngo` at the app. In Cloudflare DNS for `mie.ngo`, add a `CNAME` from `mcp` to the app's address (`az containerapp show -g TeamMe-WestUS -n team-me-connector --query properties.configuration.ingress.fqdn -o tsv`), set to **DNS only**, and a `TXT` record `asuid.mcp` with the value of `--query properties.customDomainVerificationId`. Then:

   ```sh
   az containerapp hostname add -g TeamMe-WestUS -n team-me-connector --hostname mcp.mie.ngo
   az containerapp hostname bind -g TeamMe-WestUS -n team-me-connector --hostname mcp.mie.ngo \
     --environment <environment> --validation-method CNAME
   ```

7. Check `https://mcp.mie.ngo/healthz` answers `{"ok":true,...}`, then add the connector in Claude.

To ship a new version, run step 2 with a new tag and `az containerapp update -g TeamMe-WestUS -n team-me-connector --image azcrfinal27341.azurecr.io/team-me-connector:<tag>`. The Chatwoot workflows ignore changes in this folder.

## Develop

```sh
npm ci
npm test          # type-checks, then runs the OAuth, MCP and API tests
PUBLIC_BASE_URL=http://localhost:8080 OWNER_PASSPHRASE_HASH=... TOKEN_SIGNING_SECRET=... npm run build && npm start
```

[COMMAND-CENTER-HANDOFF.md](COMMAND-CENTER-HANDOFF.md) describes the REST API for whoever updates the Command Center.

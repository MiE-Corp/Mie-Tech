# Team Me backend: notes for updating the Command Center

These notes are for whoever updates the Team Me Command Center at `ai.mie.ngo` (for example ChatGPT). They connect its "Team Me backend" to the shared service at `https://mcp.mie.ngo`, so the Command Center and Claude see the same assignments, deliverables and approvals.

## What changes in the Command Center

1. **Run Team Me** saves the request with `POST /api/assignments` before the run starts, and keeps the returned `id`.
2. When the run finishes (Claude, then ChatGPT), save the result with `POST /api/deliverables`: the final output as `content`, the first pass as `draft`, the independent review as `review`, and the assignment id. That marks the assignment completed.
3. **Deliverable** and **Refresh** read `GET /api/deliverables?workspace_id=...` (newest first, each with a 400-character `preview`), and show the full text from `GET /api/deliverables/{id}`. Deliverables Claude adds through the connector show up here too, with `author: "claude"`.
4. **Approval queue** reads `GET /api/approvals?status=pending`. Each item gets Approve and Decline buttons that call `POST /api/approvals/{id}/decision`. This is the only way anything gets approved.
5. **Recent work** reads `GET /api/recent`.
6. Optionally show queued assignments Claude created (`GET /api/assignments?status=queued`, `source: "claude"`), so the owner can run them.

Keep "Research and drafts never publish automatically": an Action run should create an approval with `POST /api/approvals` instead of acting.

## Calling the API

- Base URL: `https://mcp.mie.ngo/api`
- Every request: `Authorization: Bearer <COMMAND_CENTER_API_KEY>` and, with a body, `Content-Type: application/json`.
- The key is a secret. Keep it in the Command Center's server-side settings (next to the OpenAI and Claude keys), never in browser JavaScript. If the Command Center has no server-side code, stop and tell the owner rather than putting the key in the page.
- Browser calls are only accepted from `https://ai.mie.ngo`.
- Errors come back as `{"error": "...", "message": "..."}` with status 400 (bad input, including a deliverable or approval with neither `assignment_id` nor `workspace_id`), 401 (missing or wrong key), 404 (unknown id), 409 (conflict, e.g. deciding an approval twice) or 503 (the API key isn't set on the server).
- `limit` is 1 to 100. Lists return 20 by default (approvals 50).

## Endpoints

| Method and path | Body or query | Returns |
| --- | --- | --- |
| `GET /workspaces` | | Workspaces |
| `PUT /workspaces/{id}` | `name`, `subtitle?`, `description?`, `url?` | The workspace (creates it if new; id is lowercase with dashes) |
| `GET /assignments` | `workspace_id?`, `status?` (`queued`, `in_progress`, `completed`, `cancelled`), `limit?` | Assignments, newest first |
| `POST /assignments` | `workspace_id`, `mode` (`research`, `build`, `action`), `request`, `review_depth?` | The assignment (201) |
| `GET /assignments/{id}` | | `{assignment, deliverables, approvals}`, with deliverables as in the list |
| `PATCH /assignments/{id}` | `status?`, `note?` | The assignment |
| `GET /deliverables` | `workspace_id?`, `assignment_id?`, `limit?` | Deliverables, newest first, with `preview`, `hasDraft` and `hasReview` instead of the full text |
| `POST /deliverables` | `assignment_id?` or `workspace_id`, `title`, `content`, `draft?`, `review?`, `complete_assignment?` | The deliverable (201) |
| `GET /deliverables/{id}` | | The deliverable with its full `content`, and `draft` and `review` if it has them |
| `GET /approvals` | `workspace_id?`, `status?` (`pending`, `approved`, `declined`), `limit?` | Approvals, newest first |
| `POST /approvals` | `assignment_id?` or `workspace_id`, `title`, `details` | The approval (201) |
| `POST /approvals/{id}/decision` | `decision` (`approved` or `declined`), `note?` | The approval |
| `GET /recent` | `limit?` | Assignments, deliverables and approvals, newest first |

Workspace ids: `beat-on-me`, `mie-website`, `conservatory`, `chief-of-staff`, `communications`, `funding-compliance`.

## Example

```http
POST https://mcp.mie.ngo/api/assignments
Authorization: Bearer <COMMAND_CENTER_API_KEY>
Content-Type: application/json

{"workspace_id": "mie-website", "mode": "build", "request": "Homepage audit for www.mie.ngo", "review_depth": "standard"}
```

```json
{
  "id": "asg_Q2x8...",
  "workspaceId": "mie-website",
  "mode": "build",
  "request": "Homepage audit for www.mie.ngo",
  "reviewDepth": "standard",
  "status": "queued",
  "source": "command_center",
  "createdAt": "2026-10-17T18:40:00.000Z",
  "updatedAt": "2026-10-17T18:40:00.000Z"
}
```

```http
POST https://mcp.mie.ngo/api/deliverables
Authorization: Bearer <COMMAND_CENTER_API_KEY>
Content-Type: application/json

{"assignment_id": "asg_Q2x8...", "title": "Homepage audit", "content": "# Homepage audit\n...", "draft": "...", "review": "..."}
```

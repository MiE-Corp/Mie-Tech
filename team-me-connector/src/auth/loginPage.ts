import type { Response } from 'express';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const STYLE = `
:root { color-scheme: dark; --bg: #0f1424; --panel: #171d31; --line: #2a3350; --text: #eef1f8; --muted: #a3acc4; --accent: #ffc93c; --danger: #ff8a7a; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 28px; }
.eyebrow { color: var(--accent); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; font-weight: 600; margin: 0 0 4px; }
h1 { font-size: 22px; margin: 0 0 12px; }
p { color: var(--muted); margin: 0 0 16px; }
dl { margin: 0 0 20px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
label { display: block; font-size: 14px; margin-bottom: 6px; }
input[type=password] { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 16px; }
.row { display: flex; flex-direction: row-reverse; gap: 10px; margin-top: 18px; }
button { flex: 1; padding: 12px; border-radius: 10px; border: 1px solid var(--line); font-size: 16px; cursor: pointer; background: transparent; color: var(--text); }
button.primary { background: var(--accent); color: #1a1400; border-color: var(--accent); font-weight: 600; }
.error { color: var(--danger); font-size: 14px; margin: 10px 0 0; }
`;

export interface LoginPageOptions {
  requestId: string;
  clientName: string;
  redirectUri: string;
  error?: string;
}

// The page Claude opens when someone adds the connector. Only the owner's
// passphrase lets it continue.
export function sendLoginPage(res: Response, opts: LoginPageOptions, status = 200): void {
  const redirectOrigin = new URL(opts.redirectUri).origin;
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // form-action must allow the redirect target too: browsers check it on the
  // redirect that follows the form post.
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect to Team Me</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Music In Everything</p>
<h1>Connect to Team Me</h1>
<p>An app is asking to read and add to your Team Me workspaces, assignments, deliverables and approval queue. It can't approve anything.</p>
<dl>
<dt>App</dt><dd>${escapeHtml(opts.clientName)}</dd>
<dt>Returns to</dt><dd>${escapeHtml(redirectOrigin)}</dd>
</dl>
<form method="post" action="/oauth/login">
<input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
<label for="passphrase">Team Me passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" maxlength="1024" autofocus>
${opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : ''}
<!-- Allow comes first so pressing Enter in the passphrase field allows; row-reverse shows it on the right. -->
<div class="row">
<button type="submit" name="action" value="approve" class="primary">Allow</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>
</main>
</body>
</html>`);
}

export function sendMessagePage(res: Response, status: number, title: string, message: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><p class="eyebrow">Team Me</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}

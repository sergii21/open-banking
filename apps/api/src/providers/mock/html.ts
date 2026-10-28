import type { MockInstitution, Persona } from './institutions';

/** Escapes text for HTML element and attribute context. Every dynamic value goes through this. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const BANK_CSS = `
:root { color-scheme: light dark; --bg: #eef2f6; --card: #ffffff; --ink: #14202b; --muted: #526270; --line: #d5dde5; --brand: #0e7490; --brand-ink: #ffffff; --danger: #b3261e; --warn-bg: #fff4d6; --warn-ink: #5c4100; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e1418; --card: #172028; --ink: #e8eef3; --muted: #9db0bf; --line: #2b3945; --brand: #4fc3dc; --brand-ink: #062a33; --danger: #ffb4ab; --warn-bg: #3a2f10; --warn-ink: #ffe3a0; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: start center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { width: 100%; max-width: 460px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; box-shadow: 0 8px 28px rgb(0 0 0 / 0.08); }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.brand img { border-radius: 10px; }
.brand strong { display: block; font-size: 1.05rem; }
.brand span { color: var(--muted); font-size: 0.85rem; }
.notice { background: var(--warn-bg); color: var(--warn-ink); border-radius: 10px; padding: 8px 12px; font-size: 0.85rem; margin: 0 0 16px; }
h1 { font-size: 1.35rem; margin: 0 0 8px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 0.9rem; }
fieldset { border: 0; padding: 0; margin: 0 0 16px; }
legend { font-weight: 600; margin-bottom: 8px; padding: 0; }
.persona { display: flex; gap: 12px; align-items: flex-start; padding: 12px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; cursor: pointer; }
.persona:has(input:checked) { border-color: var(--brand); outline: 2px solid var(--brand); }
.persona input { margin-top: 4px; accent-color: var(--brand); }
.persona strong { display: block; }
.persona span { color: var(--muted); font-size: 0.88rem; }
ul.perms { list-style: none; padding: 0; margin: 0 0 16px; }
ul.perms li { padding: 10px 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; }
ul.perms li:last-child { border-bottom: 0; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
button, .button { appearance: none; border: 0; border-radius: 999px; padding: 12px 22px; font: inherit; font-weight: 600; cursor: pointer; background: var(--brand); color: var(--brand-ink); text-decoration: none; display: inline-block; }
button.secondary, .button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }
.spinner { width: 36px; height: 36px; border-radius: 50%; border: 4px solid var(--line); border-top-color: var(--brand); animation: spin 1s linear infinite; margin: 8px 0 16px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.error { color: var(--danger); font-weight: 600; }
`;

export function logoSvg(institution: Pick<MockInstitution, 'name' | 'color' | 'initials'>): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${esc(institution.name)}"><rect width="64" height="64" rx="16" fill="${esc(institution.color)}"/><text x="32" y="40" text-anchor="middle" font-family="system-ui,sans-serif" font-size="24" font-weight="700" fill="#fff">${esc(institution.initials)}</text></svg>`;
}

function layout(title: string, institution: MockInstitution, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(institution.name)}</title>
<link rel="stylesheet" href="/mock-bank/static/bank.css">
${extraHead}
</head>
<body>
<main>
<header class="brand">
<img src="/mock-bank/static/logo/${esc(institution.slug)}.svg" width="40" height="40" alt="">
<div><strong>${esc(institution.name)}</strong><span>Online banking</span></div>
</header>
<p class="notice" role="note">This is a simulated bank for the Ledger Lens demo. No real money or data is involved.</p>
${body}
</main>
</body>
</html>`;
}

/** Carries the OAuth request through the multi-step bank pages. */
export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  institution: string;
}

export function hiddenFields(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('\n');
}

export function authFields(request: AuthRequest): Record<string, string> {
  return {
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.codeChallenge,
    scope: request.scope,
    institution: request.institution,
  };
}

export function signInPage(
  institution: MockInstitution,
  request: AuthRequest,
  personas: readonly Persona[],
): string {
  const options = personas
    .map(
      (persona, index) => `<label class="persona">
<input type="radio" name="persona" value="${esc(persona.id)}"${index === 0 ? ' checked' : ''}>
<div><strong>${esc(persona.name)}</strong><span>${esc(persona.blurb)}</span></div>
</label>`,
    )
    .join('\n');
  return layout(
    'Sign in',
    institution,
    `<h1>Sign in</h1>
<p>Ledger Lens would like to read your account information. Choose who you are signing in as; the customer decides what happens next.</p>
<form method="post" action="/mock-bank/auth/signin">
${hiddenFields(authFields(request))}
<fieldset>
<legend>Demo customer</legend>
${options}
</fieldset>
<div class="actions">
<button type="submit">Continue</button>
<button type="submit" class="secondary" formaction="/mock-bank/auth/decision" name="decision" value="deny">Cancel</button>
</div>
</form>`,
  );
}

export interface ConsentAccountSummary {
  name: string;
  masked: string | null;
}

export function consentPage(
  institution: MockInstitution,
  request: AuthRequest,
  persona: Persona,
  accounts: readonly ConsentAccountSummary[],
  validUntil: string,
): string {
  const accountRows = accounts
    .map(
      (a) =>
        `<li><span>${esc(a.name)}</span><span class="muted">${esc(a.masked ?? '')}</span></li>`,
    )
    .join('\n');
  return layout(
    'Review access',
    institution,
    `<h1>Review access request</h1>
<p><strong>Ledger Lens</strong> is asking to read the following from ${esc(persona.name)}'s accounts. It cannot move money.</p>
<form method="post" action="/mock-bank/auth/decision">
${hiddenFields({ ...authFields(request), persona: persona.id })}
<ul class="perms" aria-label="Data requested">
<li><span>Account details</span><span class="muted">names and masked numbers</span></li>
<li><span>Balances</span><span class="muted">current and available</span></li>
<li><span>Transactions</span><span class="muted">up to 13 months</span></li>
</ul>
<p class="muted">Accounts shared</p>
<ul class="perms" aria-label="Accounts shared">
${accountRows}
</ul>
<p>Access is valid until <strong>${esc(validUntil)}</strong>. You can withdraw consent at any time.</p>
<div class="actions">
<button type="submit" name="decision" value="allow">Allow access</button>
<button type="submit" class="secondary" name="decision" value="deny">Deny</button>
</div>
</form>`,
  );
}

export function scaWaitPage(
  institution: MockInstitution,
  timeoutUrl: string,
  seconds: number,
): string {
  return layout(
    'Approve in your app',
    institution,
    `<h1>Approve in your banking app</h1>
<div class="spinner" aria-hidden="true"></div>
<p role="status">We sent a request to your phone. Waiting for your approval…</p>
<p class="muted">This simulated customer never approves. The session ends in ${seconds} seconds.</p>`,
    `<meta http-equiv="refresh" content="${seconds};url=${esc(timeoutUrl)}">`,
  );
}

export function outagePage(institution: MockInstitution, returnUrl: string): string {
  return layout(
    'Service unavailable',
    institution,
    `<h1>We're having technical difficulties</h1>
<p class="error" role="alert">Online banking is temporarily unavailable (503).</p>
<p>Please try again in a few minutes.</p>
<div class="actions"><a class="button secondary" href="${esc(returnUrl)}">Return to Ledger Lens</a></div>`,
  );
}

export function errorPage(institution: MockInstitution | undefined, message: string): string {
  const fallback: MockInstitution = institution ?? {
    slug: 'mock-bank',
    name: 'Mock Bank',
    country: 'DE',
    currency: 'EUR',
    locale: 'de',
    healthy: true,
    color: '#0e7490',
    initials: 'MB',
  };
  return layout(
    'Request problem',
    fallback,
    `<h1>We can't continue</h1><p class="error" role="alert">${esc(message)}</p>`,
  );
}

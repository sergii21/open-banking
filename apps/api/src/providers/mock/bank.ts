import type { FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import type { App, CoreContext } from '../../types';
import { buildDataset, type Dataset } from './dataset';
import {
  BANK_CSS,
  consentPage,
  errorPage,
  logoSvg,
  outagePage,
  scaWaitPage,
  signInPage,
  type AuthRequest,
} from './html';
import {
  findMockInstitution,
  findPersona,
  PERSONAS,
  type MockInstitution,
  type Persona,
} from './institutions';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, type MockBankStore, type MockConsent } from './store';

const PAGE_SIZE = 100;
const SCA_TIMEOUT_SECONDS = 6;

const AuthQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string(),
  redirect_uri: z.string(),
  state: z.string().min(8).max(200),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().default('accounts balance transactions'),
  provider: z.string(),
});

const AuthForm = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  state: z.string(),
  code_challenge: z.string(),
  scope: z.string(),
  institution: z.string(),
  persona: z.string().optional(),
  decision: z.enum(['allow', 'deny']).optional(),
});

const TokenForm = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string(),
    redirect_uri: z.string(),
    client_id: z.string(),
    client_secret: z.string(),
    code_verifier: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string(),
    client_id: z.string(),
    client_secret: z.string(),
  }),
]);

/** The dataset is a pure function of (profile, bank, day): cache it per day. */
class DatasetCache {
  private readonly entries = new Map<string, Dataset>();

  get(institution: MockInstitution, persona: Persona, today: Date): Dataset {
    const key = `${persona.profile}|${institution.slug}|${today.toISOString().slice(0, 10)}`;
    let dataset = this.entries.get(key);
    if (!dataset) {
      dataset = buildDataset({
        seed: `${persona.profile}:${institution.slug}`,
        institution,
        profile: persona.profile,
        today,
      });
      if (this.entries.size > 40) this.entries.clear();
      this.entries.set(key, dataset);
    }
    return dataset;
  }
}

const money = (minor: number): number => Number((minor / 100).toFixed(2));

const callbackUrl = (redirectUri: string, params: Record<string, string>): string => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
};

/**
 * Registers the fake bank under `/mock-bank`: a hosted consent journey for the browser and a TrueLayer-shaped
 * OAuth + data API for the BFF. It is deliberately a separate "service" (own routes, own tables, own error
 * format) so the MockProvider adapter exercises the same code paths a real aggregator would.
 */
export async function registerMockBank(
  app: App,
  ctx: Pick<CoreContext, 'config' | 'clock'>,
  store: MockBankStore,
): Promise<void> {
  const datasets = new DatasetCache();
  const allowedRedirect = `${ctx.config.publicUrl}/api/connections/callback`;

  await app.register(
    (bank, _options, done) => {
      bank.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, parsed) => {
          parsed(null, Object.fromEntries(new URLSearchParams(body as string)));
        },
      );

      const html = (reply: FastifyReply, status: number, body: string): FastifyReply =>
        reply
          .code(status)
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(body);

      // ------------------------------------------------------------------------------------ static
      bank.get('/static/bank.css', (_request, reply) =>
        reply
          .header('cache-control', 'public, max-age=300')
          .type('text/css; charset=utf-8')
          .send(BANK_CSS),
      );
      bank.get<{ Params: { file: string } }>('/static/logo/:file', (request, reply) => {
        const institution = findMockInstitution(request.params.file.replace(/\.svg$/, ''));
        if (!institution) return reply.code(404).send({ error: 'not_found' });
        return reply
          .header('cache-control', 'public, max-age=3600')
          .type('image/svg+xml')
          .send(logoSvg(institution));
      });

      // ------------------------------------------------------------------------------------ authorize
      const validRequest = (request: AuthRequest): string | null => {
        if (request.clientId !== MOCK_CLIENT_ID) return 'Unknown client.';
        if (request.redirectUri !== allowedRedirect)
          return 'The redirect URI is not registered for this client.';
        if (!findMockInstitution(request.institution)) return 'Unknown bank.';
        return null;
      };

      bank.get('/auth/', (request, reply) => {
        const parsed = AuthQuery.safeParse(request.query);
        if (!parsed.success) {
          return html(
            reply,
            400,
            errorPage(undefined, 'The authorisation request is incomplete or malformed.'),
          );
        }
        const q = parsed.data;
        const authRequest: AuthRequest = {
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          state: q.state,
          codeChallenge: q.code_challenge,
          scope: q.scope,
          institution: q.provider,
        };
        const problem = validRequest(authRequest);
        const institution = findMockInstitution(q.provider);
        if (problem || !institution) {
          return html(reply, 400, errorPage(institution, problem ?? 'Unknown bank.'));
        }
        return html(reply, 200, signInPage(institution, authRequest, PERSONAS));
      });

      const readAuthForm = (
        request: FastifyRequest,
        reply: FastifyReply,
      ): {
        form: z.infer<typeof AuthForm>;
        auth: AuthRequest;
        institution: MockInstitution;
      } | null => {
        const parsed = AuthForm.safeParse(request.body);
        if (!parsed.success) {
          html(reply, 400, errorPage(undefined, 'The form could not be read.'));
          return null;
        }
        const form = parsed.data;
        const auth: AuthRequest = {
          clientId: form.client_id,
          redirectUri: form.redirect_uri,
          state: form.state,
          codeChallenge: form.code_challenge,
          scope: form.scope,
          institution: form.institution,
        };
        const problem = validRequest(auth);
        const institution = findMockInstitution(auth.institution);
        if (problem || !institution) {
          html(reply, 400, errorPage(institution, problem ?? 'Unknown bank.'));
          return null;
        }
        return { form, auth, institution };
      };

      bank.post('/auth/signin', (request, reply) => {
        const read = readAuthForm(request, reply);
        if (!read) return reply;
        const { form, auth, institution } = read;
        const persona = findPersona(form.persona ?? '');
        if (!persona)
          return html(reply, 400, errorPage(institution, 'Choose a customer to continue.'));

        if (!institution.healthy || persona.outcome === 'outage') {
          const back = callbackUrl(auth.redirectUri, {
            error: 'temporarily_unavailable',
            error_description: 'The bank is temporarily unavailable',
            state: auth.state,
          });
          return html(reply, 503, outagePage(institution, back));
        }

        // The consent does not exist until the customer allows access; only account names are needed here.
        const dataset = datasets.get(institution, persona, ctx.clock.now());
        const validUntil = new Date(ctx.clock.now().getTime() + persona.consentDays * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const accounts = dataset.accounts.map((account) => ({
          name: account.name,
          masked: account.iban
            ? `${account.iban.slice(0, 2)}•• •••• ${account.iban.slice(-4)}`
            : account.accountNumber
              ? `•••• ${account.accountNumber.slice(-4)}`
              : null,
        }));
        return html(reply, 200, consentPage(institution, auth, persona, accounts, validUntil));
      });

      bank.post('/auth/decision', (request, reply) => {
        const read = readAuthForm(request, reply);
        if (!read) return reply;
        const { form, auth, institution } = read;

        if (form.decision !== 'allow') {
          return reply.redirect(
            callbackUrl(auth.redirectUri, {
              error: 'access_denied',
              error_description: 'The user denied access',
              state: auth.state,
            }),
            302,
          );
        }

        const persona = findPersona(form.persona ?? '');
        if (!persona)
          return html(reply, 400, errorPage(institution, 'Choose a customer to continue.'));

        if (persona.outcome === 'sca_timeout') {
          const timeoutUrl = callbackUrl(auth.redirectUri, {
            error: 'access_denied',
            error_description: 'sca_timeout: strong customer authentication was not completed',
            state: auth.state,
          });
          return html(reply, 200, scaWaitPage(institution, timeoutUrl, SCA_TIMEOUT_SECONDS));
        }

        const consent = store.createConsent({
          institution: institution.slug,
          persona: persona.id,
          seed: `${persona.profile}:${institution.slug}`,
          validDays: persona.consentDays,
          clientId: auth.clientId,
        });
        const code = store.createAuthCode(consent.id, auth.redirectUri, auth.codeChallenge);
        return reply.redirect(callbackUrl(auth.redirectUri, { code, state: auth.state }), 302);
      });

      // ------------------------------------------------------------------------------------ token API
      const oauthError = (
        reply: FastifyReply,
        status: number,
        error: string,
        description: string,
      ): FastifyReply =>
        reply
          .code(status)
          .header('cache-control', 'no-store')
          .send({ error, error_description: description });

      bank.post('/auth/connect/token', { config: { rateLimit: false } }, (request, reply) => {
        const parsed = TokenForm.safeParse(request.body);
        if (!parsed.success)
          return oauthError(reply, 400, 'invalid_request', 'Missing or invalid parameters');
        const form = parsed.data;
        if (form.client_id !== MOCK_CLIENT_ID || form.client_secret !== MOCK_CLIENT_SECRET) {
          return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
        }

        let consent: MockConsent;
        if (form.grant_type === 'authorization_code') {
          const redeemed = store.redeemAuthCode(form.code, form.redirect_uri, form.code_verifier);
          if (!redeemed.ok)
            return oauthError(
              reply,
              400,
              redeemed.error,
              'The authorisation code is invalid or expired',
            );
          consent = redeemed.consent;
        } else {
          const redeemed = store.redeemRefreshToken(form.refresh_token);
          if (!redeemed.ok)
            return oauthError(
              reply,
              400,
              'invalid_grant',
              'The refresh token is invalid, expired or revoked',
            );
          consent = redeemed.consent;
        }

        const tokens = store.issueTokens(consent.id);
        return reply.header('cache-control', 'no-store').send({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: tokens.expiresInSeconds,
          token_type: 'Bearer',
          scope: 'accounts balance transactions',
        });
      });

      // The TPP deletes its stored credentials (consent withdrawal initiated from our side).
      bank.delete('/auth/api/delete', { config: { rateLimit: false } }, (request, reply) => {
        const token = bearer(request);
        const resolved = token ? store.resolveAccessToken(token) : ({ state: 'unknown' } as const);
        if (resolved.state === 'ok') store.revoke(resolved.consent.id);
        return reply.code(resolved.state === 'ok' ? 204 : 401).send();
      });

      // ------------------------------------------------------------------------------------ data API
      const bearer = (request: FastifyRequest): string | null => {
        const header = request.headers.authorization;
        const match = header ? /^Bearer (.+)$/i.exec(header) : null;
        return match?.[1] ?? null;
      };

      interface Session {
        consent: MockConsent;
        institution: MockInstitution;
        persona: Persona;
        dataset: Dataset;
      }

      const authenticate = (request: FastifyRequest, reply: FastifyReply): Session | null => {
        const token = bearer(request);
        if (!token) {
          oauthError(reply, 401, 'invalid_token', 'Missing bearer token');
          return null;
        }
        const resolved = store.resolveAccessToken(token);
        if (resolved.state !== 'ok') {
          oauthError(
            reply,
            401,
            'invalid_token',
            resolved.state === 'expired'
              ? 'The access token has expired'
              : 'The access token is invalid',
          );
          return null;
        }
        const { consent } = resolved;
        if (consent.expiresAt <= ctx.clock.now().toISOString()) {
          oauthError(
            reply,
            403,
            'access_denied',
            'consent_expired: the customer consent has ended',
          );
          return null;
        }
        const failure = store.takeFailNext(consent.id);
        if (failure === 'unavailable') {
          reply.code(503).send({
            error: 'temporarily_unavailable',
            error_description: 'The bank is not responding',
          });
          return null;
        }
        if (failure === 'rate_limit') {
          reply.code(429).header('retry-after', '30').send({
            error: 'too_many_requests',
            error_description: 'Unattended access limit reached; try again later',
          });
          return null;
        }
        const institution = findMockInstitution(consent.institution);
        const persona = findPersona(consent.persona);
        if (!institution || !persona) {
          oauthError(reply, 401, 'invalid_token', 'Unknown consent');
          return null;
        }
        return {
          consent,
          institution,
          persona,
          dataset: datasets.get(institution, persona, ctx.clock.now()),
        };
      };

      const findAccount = (session: Session, request: FastifyRequest<{ Params: { id: string } }>) =>
        session.dataset.accounts.find((account) => account.id === request.params.id);

      bank.get('/api/data/v1/me', { config: { rateLimit: false } }, (request, reply) => {
        const session = authenticate(request, reply);
        if (!session) return reply;
        const { consent, institution } = session;
        return {
          results: [
            {
              client_id: consent.clientId,
              credentials_id: consent.id,
              consent_status: 'Authorised',
              consent_created_at: consent.createdAt,
              consent_expires_at: consent.expiresAt,
              scopes: ['accounts', 'balance', 'transactions'],
              provider: { provider_id: institution.slug, display_name: institution.name },
            },
          ],
          status: 'Succeeded',
        };
      });

      bank.get('/api/data/v1/accounts', { config: { rateLimit: false } }, (request, reply) => {
        const session = authenticate(request, reply);
        if (!session) return reply;
        const { institution, dataset } = session;
        return {
          results: dataset.accounts.map((account) => ({
            update_timestamp: ctx.clock.now().toISOString(),
            account_id: account.id,
            account_type: account.type,
            display_name: account.name,
            currency: account.currency,
            account_number: {
              iban: account.iban,
              swift_bic: account.bic,
              number: account.accountNumber,
              sort_code: account.sortCode,
            },
            provider: { provider_id: institution.slug, display_name: institution.name },
          })),
          status: 'Succeeded',
        };
      });

      bank.get<{ Params: { id: string } }>(
        '/api/data/v1/accounts/:id/balance',
        { config: { rateLimit: false } },
        (request, reply) => {
          const session = authenticate(request, reply);
          if (!session) return reply;
          const account = findAccount(session, request);
          const balance = account ? session.dataset.balances.get(account.id) : undefined;
          if (!account || !balance)
            return reply
              .code(404)
              .send({ error: 'account_not_found', error_description: 'No such account' });
          return {
            results: [
              {
                currency: account.currency,
                available: money(balance.availableMinor),
                current: money(balance.currentMinor),
                overdraft: money(account.headroomMinor),
                update_timestamp: ctx.clock.now().toISOString(),
              },
            ],
            status: 'Succeeded',
          };
        },
      );

      const TransactionQuery = z.object({
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        cursor: z.string().max(64).optional(),
      });

      const transactionResponse = (
        session: Session,
        accountId: string,
        pending: boolean,
        query: z.infer<typeof TransactionQuery>,
      ) => {
        const rows = session.dataset.transactions.filter(
          (t) =>
            t.accountId === accountId &&
            t.pending === pending &&
            (!query.from || t.date >= query.from) &&
            (!query.to || t.date <= query.to),
        );
        const offset = query.cursor
          ? Number(Buffer.from(query.cursor, 'base64url').toString('utf8'))
          : 0;
        const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
        const page = pending ? rows : rows.slice(start, start + PAGE_SIZE);
        const nextOffset = start + PAGE_SIZE;
        return {
          results: page.map((t) => ({
            ...(t.id ? { transaction_id: t.id } : {}),
            timestamp: t.timestamp,
            description: t.description,
            transaction_type: t.amountMinor < 0 ? 'DEBIT' : 'CREDIT',
            transaction_category: t.category,
            transaction_classification: [],
            merchant_name: t.merchant,
            amount: money(t.amountMinor),
            currency: t.currency,
          })),
          ...(!pending && nextOffset < rows.length
            ? { next_cursor: Buffer.from(String(nextOffset), 'utf8').toString('base64url') }
            : {}),
          status: 'Succeeded',
        };
      };

      for (const pending of [false, true]) {
        bank.get<{ Params: { id: string }; Querystring: unknown }>(
          `/api/data/v1/accounts/:id/transactions${pending ? '/pending' : ''}`,
          { config: { rateLimit: false } },
          (request, reply) => {
            const session = authenticate(request, reply);
            if (!session) return reply;
            const account = findAccount(session, request);
            if (!account)
              return reply
                .code(404)
                .send({ error: 'account_not_found', error_description: 'No such account' });
            const query = TransactionQuery.safeParse(request.query);
            if (!query.success)
              return oauthError(reply, 400, 'invalid_request', 'Invalid query parameters');
            return transactionResponse(session, account.id, pending, query.data);
          },
        );
      }

      done();
    },
    { prefix: '/mock-bank' },
  );
}

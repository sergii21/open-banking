import {
  currencyExponent,
  isValidIban,
  maskAccountNumber,
  maskIdentifier,
  MAX_PAYMENT_MINOR,
  normalizeIban,
} from '@ledger-lens/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { sha256Hex } from '../../domain/crypto';
import type { App } from '../../types';
import { payClosedPage, payPage, outagePage, errorPage, type PayOutcomeOption } from './html';
import {
  findMockInstitution,
  findMockInstitutionByPaymentProvider,
  PAYING_PERSONAS,
  type MockInstitution,
} from './institutions';
import type { MockPaymentsEngine } from './payments';
import type { MockOutcome, MockPayment } from './payments-store';

const CreateBody = z.object({
  amount_in_minor: z.number().int().positive().max(MAX_PAYMENT_MINOR),
  currency: z.string().regex(/^[A-Z]{3}$/),
  payment_method: z.looseObject({
    type: z.literal('bank_transfer'),
    provider_selection: z.looseObject({
      filter: z.looseObject({ provider_ids: z.array(z.string()).min(1) }),
    }),
    beneficiary: z.looseObject({
      type: z.literal('external_account'),
      account_holder_name: z.string().min(1).max(100),
      account_identifier: z.discriminatedUnion('type', [
        z.looseObject({ type: z.literal('iban'), iban: z.string() }),
        z.looseObject({
          type: z.literal('sort_code_account_number'),
          sort_code: z.string(),
          account_number: z.string(),
        }),
      ]),
      reference: z.string().min(1).max(18),
    }),
  }),
  hosted_page: z.looseObject({ return_uri: z.string().min(1) }),
  metadata: z.looseObject({ customer_ref: z.string().min(1).max(100) }),
});

const DecisionForm = z.object({
  payment_id: z.string(),
  resource_token: z.string(),
  decision: z.enum(['approve', 'cancel']),
  persona: z.string().optional(),
  outcome: z.string().optional(),
});

const OUTCOMES: readonly (PayOutcomeOption & { value: MockOutcome })[] = [
  {
    value: 'test_executed',
    label: 'Approve and execute',
    hint: 'The payment is authorised and the bank executes it.',
  },
  {
    value: 'test_authorisation_failed',
    label: 'Fail authentication',
    hint: 'The customer cannot complete strong customer authentication.',
  },
  {
    value: 'test_execution_rejected',
    label: 'Bank rejects the payment',
    hint: 'Authorised, then refused when the bank tries to execute it. A payment larger than the account holds is always refused for insufficient funds.',
  },
];

export interface MockPaymentRoutesDeps {
  engine: MockPaymentsEngine;
  publicUrl: string;
  allowedReturnUri: string;
  html: (reply: FastifyReply, status: number, body: string) => FastifyReply;
  oauthError: (
    reply: FastifyReply,
    status: number,
    error: string,
    description: string,
  ) => FastifyReply;
}

/** A problem document in the shape the payments API uses: RFC 7807 with a field-keyed `errors` object. */
function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  errors?: Record<string, string[]>,
): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .type('application/problem+json')
    .send({
      type: `https://docs.mockbank.example/errors#${title.toLowerCase().replaceAll(' ', '_')}`,
      title,
      status,
      detail,
      ...(errors ? { errors } : {}),
    });
}

const displayAmount = (amountMinor: number, currency: string): string => {
  const value = amountMinor / 10 ** currencyExponent(currency);
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(currencyExponent(currency))} ${currency}`;
  }
};

const returnUrl = (payment: MockPayment, extra: Record<string, string> = {}): string => {
  const url = new URL(payment.returnUri);
  url.searchParams.set('payment_id', payment.id);
  for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
  return url.toString();
};

/** The mock bank's payments API (TrueLayer-shaped) and the hosted page where the customer approves. */
export function registerMockPaymentRoutes(bank: App, deps: MockPaymentRoutesDeps): void {
  const { engine, html } = deps;

  const bearer = (request: FastifyRequest): string | null => {
    const header = request.headers.authorization;
    return (header ? /^Bearer (.+)$/i.exec(header)?.[1] : null) ?? null;
  };

  const authorised = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const token = bearer(request);
    const state = token ? engine.checkApiToken(token) : 'invalid';
    if (state === 'ok') return true;
    problem(
      reply,
      401,
      'Unauthorized',
      state === 'expired' ? 'The access token has expired.' : 'A valid payments token is required.',
    );
    return false;
  };

  // ------------------------------------------------------------------------------------------ API

  bank.post('/api/payments/v1/payments', { config: { rateLimit: false } }, (request, reply) => {
    if (!authorised(request, reply)) return reply;

    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 64) {
      return problem(reply, 400, 'Invalid Parameters', 'An Idempotency-Key header is required.');
    }
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        (errors[issue.path.join('.') || 'body'] ??= []).push(issue.message);
      }
      return problem(reply, 400, 'Invalid Parameters', 'The request body is not valid.', errors);
    }
    const body = parsed.data;
    const method = body.payment_method;

    const institution = method.provider_selection.filter.provider_ids
      .map(findMockInstitutionByPaymentProvider)
      .find((candidate): candidate is MockInstitution => candidate !== undefined);
    if (!institution) {
      return problem(reply, 400, 'Invalid Parameters', 'None of the requested providers exists.', {
        'payment_method.provider_selection.filter.provider_ids': ['Unknown provider'],
      });
    }
    if (body.currency !== institution.currency) {
      return problem(reply, 400, 'Invalid Parameters', 'The currency is not supported here.', {
        currency: [`${institution.name} pays in ${institution.currency}`],
      });
    }
    if (body.hosted_page.return_uri !== deps.allowedReturnUri) {
      return problem(reply, 400, 'Invalid Parameters', 'The return URI is not registered.', {
        'hosted_page.return_uri': ['Not registered for this client'],
      });
    }

    const identifier = method.beneficiary.account_identifier;
    let beneficiaryIdentifier: string;
    if (identifier.type === 'iban') {
      if (institution.currency !== 'EUR' || !isValidIban(identifier.iban)) {
        return problem(reply, 400, 'Invalid Parameters', 'The beneficiary account is not valid.', {
          'payment_method.beneficiary.account_identifier.iban': ['Not a valid IBAN for this bank'],
        });
      }
      beneficiaryIdentifier = maskIdentifier(normalizeIban(identifier.iban));
    } else {
      if (
        institution.currency !== 'GBP' ||
        !/^\d{6}$/.test(identifier.sort_code) ||
        !/^\d{8}$/.test(identifier.account_number)
      ) {
        return problem(reply, 400, 'Invalid Parameters', 'The beneficiary account is not valid.', {
          'payment_method.beneficiary.account_identifier': ['Not a valid UK account for this bank'],
        });
      }
      beneficiaryIdentifier = `${identifier.sort_code} ${maskAccountNumber(identifier.account_number)}`;
    }

    const result = engine.create({
      institution,
      idempotencyKey: key,
      requestHash: sha256Hex(JSON.stringify(body)),
      amountMinor: body.amount_in_minor,
      currency: body.currency,
      beneficiaryName: method.beneficiary.account_holder_name,
      beneficiaryIdentifier,
      reference: method.beneficiary.reference,
      returnUri: body.hosted_page.return_uri,
      customerRef: body.metadata.customer_ref,
    });
    if (result.kind === 'conflict') {
      return problem(
        reply,
        422,
        'Idempotency Key Conflict',
        'This Idempotency-Key was used with a different request.',
      );
    }
    const page = new URL('/mock-bank/pay', deps.publicUrl);
    page.search = new URLSearchParams({
      payment_id: result.payment.id,
      resource_token: result.resourceToken,
    }).toString();
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({
        id: result.payment.id,
        user: { id: 'usr_mock_customer' },
        resource_token: result.resourceToken,
        status: 'authorization_required',
        hosted_page: { uri: page.toString() },
      });
  });

  bank.get<{ Params: { id: string } }>(
    '/api/payments/v1/payments/:id',
    { config: { rateLimit: false } },
    (request, reply) => {
      if (!authorised(request, reply)) return reply;
      const payment = engine.get(request.params.id);
      if (!payment) return problem(reply, 404, 'Not Found', 'There is no such payment.');
      const failed = payment.status === 'failed';
      return reply.header('cache-control', 'no-store').send({
        id: payment.id,
        amount_in_minor: payment.amountMinor,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.createdAt,
        ...(payment.status === 'authorized' ? { authorized_at: payment.updatedAt } : {}),
        ...(payment.executedAt ? { executed_at: payment.executedAt } : {}),
        ...(payment.settledAt ? { settled_at: payment.settledAt } : {}),
        ...(failed
          ? {
              failed_at: payment.failedAt,
              failure_stage: payment.failureStage,
              failure_reason: payment.failureReason,
            }
          : {}),
      });
    },
  );

  // ------------------------------------------------------------------------------------------ hosted page

  /** Finds the payment a hosted-page request is about, or answers with an error page. */
  const open = (
    reply: FastifyReply,
    paymentId: string,
    token: string,
  ): { payment: MockPayment; institution: MockInstitution } | null => {
    const payment = engine.get(paymentId);
    const institution = payment ? findMockInstitution(payment.institution) : undefined;
    if (!payment || !institution || !engine.hasValidResourceToken(payment, token)) {
      html(reply, 400, errorPage(undefined, 'This payment link is not valid or has expired.'));
      return null;
    }
    return { payment, institution };
  };

  const closed = (reply: FastifyReply, payment: MockPayment, institution: MockInstitution) =>
    html(
      reply,
      200,
      payClosedPage(
        institution,
        payment.status === 'failed'
          ? 'It did not go through, and nothing was paid.'
          : 'It has already been approved.',
        returnUrl(payment),
      ),
    );

  const PayQuery = z.object({ payment_id: z.string(), resource_token: z.string() });

  bank.get('/pay', (request, reply) => {
    const query = PayQuery.safeParse(request.query);
    if (!query.success) {
      return html(reply, 400, errorPage(undefined, 'The payment link is incomplete.'));
    }
    const found = open(reply, query.data.payment_id, query.data.resource_token);
    if (!found) return reply;
    let { payment } = found;
    const { institution } = found;

    if (payment.status !== 'authorization_required' && payment.status !== 'authorizing') {
      return closed(reply, payment, institution);
    }
    if (!institution.healthy) {
      engine.fail(payment, 'authorization_required', 'provider_error');
      return html(reply, 503, outagePage(institution, returnUrl(payment)));
    }
    payment = engine.opened(payment);
    return html(
      reply,
      200,
      payPage(
        institution,
        {
          paymentId: payment.id,
          resourceToken: query.data.resource_token,
          amount: displayAmount(payment.amountMinor, payment.currency),
          beneficiaryName: payment.beneficiaryName,
          beneficiaryIdentifier: payment.beneficiaryIdentifier,
          reference: payment.reference,
        },
        PAYING_PERSONAS,
        OUTCOMES,
      ),
    );
  });

  bank.post('/pay/decision', (request, reply) => {
    const form = DecisionForm.safeParse(request.body);
    if (!form.success) return html(reply, 400, errorPage(undefined, 'The form could not be read.'));
    const found = open(reply, form.data.payment_id, form.data.resource_token);
    if (!found) return reply;
    const { payment, institution } = found;

    // A second click, or a back-button replay: the answer is already decided, so just send the customer back.
    if (payment.status !== 'authorization_required' && payment.status !== 'authorizing') {
      return reply.redirect(returnUrl(payment), 302);
    }

    if (form.data.decision === 'cancel') {
      engine.cancel(payment);
      return reply.redirect(returnUrl(payment, { error: 'tl_hpp_abandoned' }), 302);
    }

    const persona = PAYING_PERSONAS.find((candidate) => candidate.id === form.data.persona);
    const outcome = OUTCOMES.find((candidate) => candidate.value === form.data.outcome);
    if (!persona || !outcome) {
      return html(
        reply,
        400,
        errorPage(institution, 'Choose who is paying and what should happen.'),
      );
    }
    engine.approve(payment, persona, outcome.value, institution);
    return reply.redirect(returnUrl(payment), 302);
  });
}

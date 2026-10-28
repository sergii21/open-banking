import * as z from 'zod';
import { Id, IsoDateTime, ProviderId } from './common';

const Headers = z.record(z.string(), z.string());

/** One outbound call to a provider, as shown in the API Inspector. Everything here is already redacted. */
export const InspectorCall = z.object({
  id: Id,
  at: IsoDateTime,
  provider: ProviderId,
  /** Human label such as `Fetch accounts` or `Create payment`. */
  label: z.string(),
  /** `inbound` for webhooks the provider sent us; everything else is a call we made. */
  direction: z.enum(['outbound', 'inbound']),
  method: z.string(),
  /** Full URL with sensitive query values masked. */
  url: z.string(),
  /** Null when the request never produced a response (network error, timeout). */
  status: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  request: z.object({ headers: Headers, body: z.unknown().nullable() }),
  response: z.object({ headers: Headers, body: z.unknown().nullable() }).nullable(),
  error: z.string().nullable(),
  /** The response body was cut to keep the buffer small. */
  truncated: z.boolean(),
  connectionId: z.string().nullable(),
});
export type InspectorCall = z.infer<typeof InspectorCall>;

export const InspectorCallList = z.object({ items: z.array(InspectorCall) });
export type InspectorCallList = z.infer<typeof InspectorCallList>;

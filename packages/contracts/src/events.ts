import { z } from 'zod';
import { Connection } from './connections';
import { InspectorCall } from './inspector';
import { Payment } from './payments';

/** Server-sent events on `GET /api/events`. The SSE `event:` field is the `type`. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('payment.updated'), payment: Payment }),
  z.object({ type: z.literal('connection.updated'), connection: Connection }),
  z.object({ type: z.literal('inspector.call'), call: InspectorCall }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const SERVER_EVENT_TYPES = [
  'payment.updated',
  'connection.updated',
  'inspector.call',
] as const;

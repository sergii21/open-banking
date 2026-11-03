import { AppError } from '../../errors';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

/** A year of one person's card statements is a few hundred kilobytes; this is generous and still a hard stop. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export function registerImportRoutes(api: App, ctx: AppContext): void {
  // The browser sends the file's bytes as they are. This parser exists only inside the API scope, for this content type.
  api.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES },
    (_request, body, done) => done(null, body),
  );

  /** Reads a Privat24 statement (.xlsx or CSV). Nothing is stored but the rows. */
  api.post(
    '/imports/privat24',
    { bodyLimit: MAX_IMPORT_BYTES, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    (request) => {
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(
          'validation_failed',
          400,
          'Send the statement file as the request body.',
        );
      }
      return ctx.imports.privat24(requireSession(request), body);
    },
  );
}

import { D1RelayStore, type D1Like } from './d1-store';
import { Relay } from './relay';

/**
 * The relay as a Cloudflare Worker: the same `Relay` as under Node, with D1 for storage. Cloudflare terminates HTTPS
 * and names the caller's address in `CF-Connecting-IP`, which is used to count requests and never stored. Nothing is
 * logged. The request limit is counted per running instance, so it is a brake, not an exact meter.
 */
let relay: Relay | null = null;

export default {
  fetch(request: Request, env: { DB: D1Like }): Promise<Response> {
    relay ??= new Relay({ store: new D1RelayStore(env.DB), now: () => Date.now() });
    return relay.handle(request, request.headers.get('cf-connecting-ip') ?? 'unknown');
  },
};

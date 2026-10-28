import * as z from 'zod';

// Zod compiles object parsers with `new Function` when the page allows it. Under a strict Content-Security-Policy
// (no 'unsafe-eval', which is what the BFF sends) the browser logs a violation even though the probe is caught, so
// turn the compiler off up front. Runs before any schema exists, so main.ts imports this module first.
z.config({ jitless: true });

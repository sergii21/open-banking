/**
 * The web app's `zod`. `tsconfig.json` points the bare specifier `zod` here, so every import of it (the contracts package
 * included) goes through this module.
 *
 * Zod compiles object parsers with `new Function` when the page allows it. Under the strict Content-Security-Policy the BFF
 * sends (no 'unsafe-eval') the browser logs a violation for that probe even though it is caught, so the compiler is turned
 * off. It has to be off *before any schema is created*: a module that builds schemas in a shared chunk is evaluated before
 * the code that imports it, so a `config()` call in `main.ts` is too late. A module every schema file imports is not.
 */
import { config } from 'zod/v4';

config({ jitless: true });

export * from 'zod/v4';

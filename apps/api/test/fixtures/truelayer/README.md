# TrueLayer fixtures

Response bodies the TrueLayer adapter is tested against, offline. **They are written from TrueLayer's published API
reference (checked 2026-10-28), not recorded from a live sandbox call** — no sandbox credentials were available when the
adapter was built. Treat them as the documented contract.

When you have sandbox credentials, replace a file with a real response (`curl` the endpoint with your token, or copy
the body from the API Inspector) and keep the test green. A fixture that no longer parses is exactly the drift these
tests exist to catch.

Account ids, merchant account ids and payment ids here are made up.

`payments/` holds the Payments v3 shapes (create response, payment objects per status, the RFC 7807 errors, webhook
events). The webhook key set and every signature are generated per test run with a throwaway P-521 key, so no key
material is committed.

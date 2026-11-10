# color-fn-utils (LADON DEMO CANARY)

Harmless demo package. Exists only on the local Verdaccio registry used by the Ladon demo.
Its postinstall imitates a token-stealer's *shape* (env access + network) but only writes
`/tmp/ladon-canary-pwned` and pings `127.0.0.1`. Never publish to a public registry.

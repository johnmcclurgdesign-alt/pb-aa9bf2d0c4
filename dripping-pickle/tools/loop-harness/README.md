# loop-harness

Collectivus's **web class**, which you run yourself, on your own payload, on your own machine. It writes
`HARNESS.md`. When every row is PASS, attach that file to your GitHub Release beside `SHA256SUMS.txt`.
The intake shows it on your release issue. It is Chromium only, so since 2026-09-28 it is no longer
the `web` surface's evidence on its own: our web leg must pass in Chromium and WebKit.

Read **[`../../35-harness.md`](../../35-harness.md)** first: how to install it, run it, and read the table.

| File | What it is | May you edit it? |
| --- | --- | --- |
| `harness.mjs` | the runner: serves your payload (and, with `--media`, your media), drives Chromium at two viewports, writes `HARNESS.md` | no, send changes upstream |
| `harness-self-test.mjs` | `node harness.mjs --self-test`: every row watched failing on a planted payload | no |
| `host.html` | the site's web player, cut down to what a Loop can observe | no |
| `web-leg-verdicts.mjs` | **a byte-identical copy of our instrument**, the code that decides every row | **never.** The monorepo gate compares its bytes |
| `loop-runtime-sw.js` | **a byte-identical copy of the site's service-worker shim**, which injects `window.collectivus` and serves `media/` | **never.** Same gate |
| `package.json` | no dependencies, only two scripts | — |

Copy the whole folder into your Loop repository, for example as `tools/loop-harness/`. Re-copy it
whenever loops-docs' CHANGELOG names it. An old copy measures with an old instrument.

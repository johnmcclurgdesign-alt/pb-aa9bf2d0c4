// POLYFILLS FOR THE APPLE TV BINDING — evaluated BEFORE anything else (#121, CMP2 2026-09-13).
//
// Ported from Vibes: Collectivus `src/core/polyfills.js` (VC-058, 2026-09-09), which is the
// copyable one loops-docs 30-engines/web/00-status.md §6 item 1 names.
//
// ⚠ THIS MUST BE THE FIRST IMPORT IN loops/dripping-pickle/index.html's module, and nothing
// here may import anything. ES modules evaluate depth-first in import order, so a module that
// is first in the entry's import list runs before `three` and before every vendored addon —
// which is the whole point: three.js's own DRACOLoader.js and KTX2Loader.js (from r0.185)
// evaluate `new URL('../libs/…', import.meta.url)` at MODULE SCOPE, so any Loop that merely
// imports them statically dies during module evaluation, before its entry module runs, on an
// environment with no `URL`.
//
// That environment is real: Apple TV runs a web Loop through the app's own JavaScriptCore +
// WebGL2 binding, not WebKit. It shimmed `URLSearchParams` and not `URL`, and on 2026-09-09
// Vibes v1.1.1 black-screened at entry on every Apple TV 4K with
// `ReferenceError: Can't find variable: URL` (collectivus#122).
//
// ⚠ THE BINDING GAINED `URL` AT APP ROW TVB1 (2026-09-11) AND THIS FILE STILL SHIPS. It reaches
// a television only in the build that CARRIES TVB1 (app row TVS1); every installed build before
// that one still has none, and the Loop Pool is served to whatever is installed. This file goes
// when that build is Live and not before — loops-docs §6 item 1 says so in those words.
//
// ⚠ Measured here (CMP1, 2026-09-12): the vendored r169 loaders have NO module-scope
// `new URL(` — `grep -rn "import.meta.url" vendor/` is empty — so today's graph evaluates
// without `URL` even unpolyfilled. That is a property of the PIN, not of this Loop, and a
// bump to r0.185 reintroduces it silently. `tools/vendor-deps.mjs --check` asserts the property
// directly from CMP2 on, so the bump cannot land unnoticed.
//
// ⚠ GUARDED, MINIMAL, AND ONLY WHAT THE LOADERS NEED. Where `URL` exists this file does nothing
// at all — a browser's `URL` is never replaced. Where it does not, this provides the subset
// three.js's loaders and this Loop actually use: `new URL(relative, base)` resolving `.`/`..`
// against an absolute base, and the `.href` / `.toString()` / `.pathname` / `.protocol` /
// `.origin` / `.search` / `.hash` reads. It deliberately does NOT provide `createObjectURL` /
// `revokeObjectURL`: a loader that reaches for them must fail BY NAME rather than be handed a
// string that points at nothing.
//
// ⚠ Not a general WHATWG URL. No IDNA, no percent-encoding normalisation, no username:password,
// no special-scheme port defaults — the same subset the binding itself implements. This Loop
// never builds a URL from user input; every caller resolves a payload-relative path against
// `import.meta.url`, which the module loader hands over already absolute.

/**
 * Which polyfills THIS load installed (empty in a browser). Exported so a rig can see from
 * outside that the file ran — `window.__polyfills` carries the same array.
 *
 * ⚠ A NAMED export, imported BY NAME, on purpose: the Apple TV binding's module loader
 * rejected the bare side-effect form `import './x.js';` with a SyntaxError at COMPILE time
 * (it read the specifier as the import clause and emitted `var './x.js'; = …`). Fixed in the
 * binding at TVB1, and still the right form regardless — it also gives the rig a readout.
 */
export const POLYFILLS = [];

if (typeof globalThis.URL === 'undefined') {
  const ABSOLUTE = /^([a-z][a-z0-9+.-]*:)(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i;

  const resolvePath = (basePath, relPath) => {
    const segments = relPath.startsWith('/') ? [] : basePath.split('/').slice(0, -1);
    for (const seg of relPath.split('/')) {
      if (seg === '..') { if (segments.length > 1 || (segments.length === 1 && segments[0] !== '')) segments.pop(); }
      else if (seg !== '.') segments.push(seg);
    }
    let out = segments.join('/');
    if (!out.startsWith('/')) out = `/${out}`;
    return out;
  };

  class URL {
    constructor(input, base) {
      const text = String(input);
      const m = text.match(ABSOLUTE);
      if (m) {
        this.protocol = m[1];
        this.hasAuthority = m[2] !== undefined;
        this.host = m[3] ?? '';
        this.pathname = m[4] || (m[2] ? '/' : '');
        this.search = m[5] ?? '';
        this.hash = m[6] ?? '';
      } else {
        if (base === undefined) throw new TypeError(`URL: '${text}' is not absolute and no base was given`);
        const b = base instanceof URL ? base : new URL(String(base));
        // Split the relative reference into path / query / fragment.
        const rel = text.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
        const relPath = rel[1];
        this.protocol = b.protocol;
        this.hasAuthority = b.hasAuthority;
        this.host = b.host;
        this.pathname = relPath ? resolvePath(b.pathname || '/', relPath) : (b.pathname || '/');
        this.search = rel[2] ?? (relPath ? '' : b.search);
        this.hash = rel[3] ?? '';
      }
      this.origin = this.host ? `${this.protocol}//${this.host}` : 'null';
      this.hostname = this.host.split(':')[0];
    }
    get href() {
      const authority = this.hasAuthority ? `//${this.host}` : '';
      return `${this.protocol}${authority}${this.pathname}${this.search}${this.hash}`;
    }
    get searchParams() { return new URLSearchParams(this.search); }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  globalThis.URL = URL;
  POLYFILLS.push('URL');
}

// A readout for the rigs, matching the other window handles this Loop exposes.
if (typeof globalThis.window !== 'undefined') globalThis.window.__polyfills = POLYFILLS;

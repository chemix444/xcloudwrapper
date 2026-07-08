'use strict';

// URL policy for the app. Pure Node module (no Electron imports) so it can be
// unit-tested with `node --test`.
//
// Three tiers:
//   - internal:  allowed to load inside our BrowserWindows (xbox.com itself
//                plus the Microsoft auth hosts the login flow redirects
//                through as full-page navigations).
//   - auth popup: hosts that Microsoft OAuth opens via window.open(); these
//                get a child window instead of the main window or an
//                external browser tab.
//   - external:  everything else is handed to the default browser (https
//                links only) or dropped.

const PLAY_HOME_URL = 'https://www.xbox.com/play';

// Full-page stream URLs look like https://www.xbox.com/<locale>/play/launch/<slug>/<id>
const STREAM_PATH_RE = /\/play\/launch(\/|$)/;

// Suffix-matched domains that may render inside the app.
const INTERNAL_DOMAINS = [
  'xbox.com',
  'xboxlive.com',
  'microsoft.com'
];

// Exact hosts used by Microsoft account sign-in (window.open popups and
// full-page redirects). Deliberately exact — we must not allow all of
// live.com.
const AUTH_HOSTS = new Set([
  'login.live.com',
  'account.live.com',
  'signup.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'account.microsoft.com',
  'sisu.xboxlive.com'
]);

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

function isInternalUrl(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  if (AUTH_HOSTS.has(u.hostname)) return true;
  return INTERNAL_DOMAINS.some((d) => hostMatches(u.hostname, d));
}

function isAuthPopupUrl(url) {
  const u = parse(url);
  return !!u && u.protocol === 'https:' && AUTH_HOSTS.has(u.hostname);
}

// Only these schemes may be forwarded to shell.openExternal(). Never file:,
// smb:, or other app-invoking schemes coming from web content.
function isSafeExternalUrl(url) {
  const u = parse(url);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:');
}

function isStreamUrl(url) {
  const u = parse(url);
  return !!u && STREAM_PATH_RE.test(u.pathname);
}

// A single path segment of a deep link: product IDs and slugs only.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

// Resolve a CLI argument or xcloud:// protocol URL to an https URL we are
// willing to load. Returns null for anything that does not strictly match.
//
//   xcloud://game/<productId>       -> https://www.xbox.com/play/launch/<productId>
//   xcloud://play/<path...>         -> https://www.xbox.com/play/<path...>
//   https://www.xbox.com/play/...   -> passed through (host normalized)
function resolveDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  const u = parse(raw);
  if (!u) return null;

  if (u.protocol === 'xcloud:') {
    // Non-special scheme: "xcloud://game/id" parses host="game",
    // pathname="/id"; "xcloud:game/id" parses host="", pathname="game/id".
    // Normalize both shapes into a flat segment list.
    const segments = [u.host, ...u.pathname.split('/')].filter(Boolean);
    if (segments.length < 2) return null;
    if (!segments.every((s) => SEGMENT_RE.test(s))) return null;
    const [kind, ...rest] = segments;
    if (kind === 'game') return `${PLAY_HOME_URL}/launch/${rest.join('/')}`;
    if (kind === 'play') return `${PLAY_HOME_URL}/${rest.join('/')}`;
    return null;
  }

  if (u.protocol === 'https:' && (u.hostname === 'www.xbox.com' || u.hostname === 'xbox.com')) {
    if (!/(^|\/)play(\/|$)/.test(u.pathname)) return null;
    u.hostname = 'www.xbox.com';
    return u.toString();
  }

  return null;
}

module.exports = {
  PLAY_HOME_URL,
  isInternalUrl,
  isAuthPopupUrl,
  isSafeExternalUrl,
  isStreamUrl,
  resolveDeepLink
};

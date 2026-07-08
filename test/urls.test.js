'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAY_HOME_URL,
  isInternalUrl,
  isAuthPopupUrl,
  isSafeExternalUrl,
  isStreamUrl,
  resolveDeepLink
} = require('../src/main/urls');

test('internal: xbox.com family', () => {
  assert.ok(isInternalUrl('https://www.xbox.com/play'));
  assert.ok(isInternalUrl('https://xbox.com/en-US/play'));
  assert.ok(isInternalUrl('https://account.xbox.com/settings'));
  assert.ok(isInternalUrl('https://sisu.xboxlive.com/connect'));
  assert.ok(isInternalUrl('https://account.microsoft.com/'));
});

test('internal: microsoft auth hosts', () => {
  assert.ok(isInternalUrl('https://login.live.com/oauth20_authorize.srf'));
  assert.ok(isInternalUrl('https://login.microsoftonline.com/common/oauth2'));
});

test('not internal: lookalikes, other schemes, other hosts', () => {
  assert.ok(!isInternalUrl('http://www.xbox.com/play')); // http, not https
  assert.ok(!isInternalUrl('https://evilxbox.com/play'));
  assert.ok(!isInternalUrl('https://xbox.com.evil.example/play'));
  assert.ok(!isInternalUrl('https://www.live.com/')); // only exact auth hosts
  assert.ok(!isInternalUrl('https://example.com/'));
  assert.ok(!isInternalUrl('file:///etc/passwd'));
  assert.ok(!isInternalUrl('not a url'));
});

test('auth popups: exact hosts only', () => {
  assert.ok(isAuthPopupUrl('https://login.live.com/oauth20_authorize.srf?x=1'));
  assert.ok(!isAuthPopupUrl('https://login.live.com.evil.example/'));
  assert.ok(!isAuthPopupUrl('https://www.xbox.com/play'));
});

test('safe external: web schemes only', () => {
  assert.ok(isSafeExternalUrl('https://example.com/'));
  assert.ok(isSafeExternalUrl('mailto:someone@example.com'));
  assert.ok(!isSafeExternalUrl('file:///etc/passwd'));
  assert.ok(!isSafeExternalUrl('javascript:alert(1)'));
  assert.ok(!isSafeExternalUrl('smb://host/share'));
});

test('stream URL detection', () => {
  assert.ok(isStreamUrl('https://www.xbox.com/play/launch/fortnite/BT5P2X999VH2'));
  assert.ok(isStreamUrl('https://www.xbox.com/en-US/play/launch/halo'));
  assert.ok(!isStreamUrl('https://www.xbox.com/play'));
  assert.ok(!isStreamUrl('https://www.xbox.com/play/games/fortnite'));
});

test('deep link: xcloud://game/<id>', () => {
  assert.equal(
    resolveDeepLink('xcloud://game/9NBLGGH4V0FL'),
    `${PLAY_HOME_URL}/launch/9NBLGGH4V0FL`
  );
  assert.equal(
    resolveDeepLink('xcloud://game/fortnite/BT5P2X999VH2'),
    `${PLAY_HOME_URL}/launch/fortnite/BT5P2X999VH2`
  );
});

test('deep link: xcloud://play/<path>', () => {
  assert.equal(
    resolveDeepLink('xcloud://play/games/fortnite/BT5P2X999VH2'),
    `${PLAY_HOME_URL}/games/fortnite/BT5P2X999VH2`
  );
});

test('deep link: single-slash form', () => {
  assert.equal(resolveDeepLink('xcloud:game/9NBLGGH4V0FL'), `${PLAY_HOME_URL}/launch/9NBLGGH4V0FL`);
});

test('deep link: https xbox.com play URLs pass through, host normalized', () => {
  assert.equal(
    resolveDeepLink('https://xbox.com/en-US/play/launch/halo'),
    'https://www.xbox.com/en-US/play/launch/halo'
  );
  assert.equal(
    resolveDeepLink('https://www.xbox.com/play'),
    'https://www.xbox.com/play'
  );
});

test('deep link: rejects everything else', () => {
  assert.equal(resolveDeepLink('xcloud://settings/whatever'), null);
  // Dot-segments (literal or percent-encoded) are normalized away by the
  // WHATWG URL parser before validation, so they cannot escape /play/launch/.
  assert.equal(resolveDeepLink('xcloud://game/../evil'), `${PLAY_HOME_URL}/launch/evil`);
  assert.equal(resolveDeepLink('xcloud://game/%2e%2e/evil'), `${PLAY_HOME_URL}/launch/evil`);
  assert.equal(resolveDeepLink('xcloud://game/<script>'), null);
  assert.equal(resolveDeepLink('xcloud://game'), null);
  assert.equal(resolveDeepLink('https://www.xbox.com/'), null); // not /play
  assert.equal(resolveDeepLink('https://evil.example/play'), null);
  assert.equal(resolveDeepLink('file:///play'), null);
  assert.equal(resolveDeepLink(''), null);
  assert.equal(resolveDeepLink('--inspect'), null);
  assert.equal(resolveDeepLink('/Applications/XCloud Player.app'), null);
});

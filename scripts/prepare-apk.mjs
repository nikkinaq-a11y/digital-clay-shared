#!/usr/bin/env node
/**
 * Generate the two files Bubblewrap needs, from your hosted URL.
 *
 *   node scripts/prepare-apk.mjs https://you.github.io/digital-clay/
 *
 * Writes:
 *   twa-manifest.json               — how the APK is built
 *   public/.well-known/assetlinks.json — proves you own that site
 *
 * Run it again any time the URL changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ID = 'com.nikkiquinn.digitalclay';   // never change this after first install
const JAVA_HOME  = path.join(ROOT, 'tools/jdk/jdk-17.0.11+9/Contents/Home');
const KEYSTORE   = path.join(ROOT, 'signing/android.keystore');
const PW_FILE    = path.join(ROOT, 'signing/keystore-password.txt');

const raw = process.argv[2];
if (!raw) {
  console.error('\n  Usage: node scripts/prepare-apk.mjs <https url where the app is hosted>');
  console.error('  e.g.   node scripts/prepare-apk.mjs https://nikkiquinn.github.io/digital-clay/\n');
  process.exit(1);
}
const base = new URL(raw.endsWith('/') ? raw : raw + '/');
if (base.protocol !== 'https:') {
  console.error('\n  That URL must be https — a Trusted Web Activity will not accept plain http.\n');
  process.exit(1);
}

// Digital Asset Links is only ever checked at the ORIGIN ROOT. A project-page
// URL like user.github.io/repo/ cannot serve it, because you do not control
// user.github.io/.well-known/. Say so loudly rather than let it fail at launch.
if (base.pathname !== "/") {
  console.warn(`
  ⚠  Heads up: that URL has a path (${base.pathname}).

     Digital Asset Links is ONLY read from the origin root:
       ${base.origin}/.well-known/assetlinks.json
     not from
       ${base.href}.well-known/assetlinks.json

     If you cannot put a file at the origin root, the immersive app will not
     launch. Use a host that gives you the whole origin — a
     <name>.github.io user site, or Netlify / Cloudflare Pages, which both
     hand you your own subdomain.
`);
}

/* ── read the signing key's fingerprint ──────────────────────────────────── */
const pw = fs.readFileSync(PW_FILE, 'utf8').trim();
const out = execFileSync(path.join(JAVA_HOME, 'bin/keytool'),
  ['-list', '-v', '-keystore', KEYSTORE, '-alias', 'android', '-storepass', pw],
  { encoding: 'utf8' });
const fingerprint = (out.match(/SHA256:\s*([A-F0-9:]+)/i) || [])[1];
if (!fingerprint) { console.error('  Could not read SHA-256 from the keystore.'); process.exit(1); }

/* ── assetlinks.json — the site's half of the handshake ──────────────────── */
const assetlinks = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: PACKAGE_ID,
    sha256_cert_fingerprints: [fingerprint],
  },
}];
const alPath = path.join(ROOT, 'public/.well-known/assetlinks.json');
fs.mkdirSync(path.dirname(alPath), { recursive: true });
fs.writeFileSync(alPath, JSON.stringify(assetlinks, null, 2) + '\n');

/* ── twa-manifest.json — the APK's half ──────────────────────────────────── */
const twa = {
  packageId: PACKAGE_ID,
  host: base.host,
  name: 'Digital Clay',
  launcherName: 'Digital Clay',
  display: 'standalone',
  orientation: 'landscape',
  themeColor: '#141A23',
  themeColorDark: '#141A23',
  navigationColor: '#141A23',
  navigationColorDark: '#141A23',
  navigationDividerColor: '#141A23',
  navigationDividerColorDark: '#141A23',
  backgroundColor: '#141A23',
  enableNotifications: false,
  startUrl: base.pathname + 'index.html',
  iconUrl: base.href + 'icons/icon-512.png',
  maskableIconUrl: base.href + 'icons/icon-512.png',
  splashScreenFadeOutDuration: 300,
  signingKey: { path: KEYSTORE, alias: 'android' },
  appVersionName: '1',
  appVersionCode: 1,
  shortcuts: [],
  generatorApp: 'bubblewrap-cli',
  webManifestUrl: base.href + 'manifest.webmanifest',
  fallbackType: 'customtabs',
  features: {},
  alphaDependencies: { enabled: false },
  enableSiteSettingsShortcut: true,
  isChromeOSOnly: false,
  isMetaQuest: true,
  horizonOSAppMode: 'immersive',
  fullScopeUrl: base.href,
  minSdkVersion: 23,
  orientation: 'landscape',
  fingerprints: [{ name: 'android', value: fingerprint }],
  additionalTrustedOrigins: [],
  retainedBundles: [],
  protocolHandlers: [],
  fileHandlers: [],
  launchHandlerClientMode: 'auto',
};
fs.writeFileSync(path.join(ROOT, 'twa-manifest.json'), JSON.stringify(twa, null, 2) + '\n');

console.log(`
  Prepared for  ${base.href}

    package        ${PACKAGE_ID}
    fingerprint    ${fingerprint.slice(0, 32)}…
    app mode       immersive (launches straight into passthrough)

  Written:
    twa-manifest.json
    public/.well-known/assetlinks.json

  Next:
    1. Publish public/ to that URL — assetlinks.json must be live at
       ${base.origin}/.well-known/assetlinks.json
    2. ./build-apk.sh
`);

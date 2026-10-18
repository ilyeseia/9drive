// Fails when a tracked file contains something that looks like a real credential. High-confidence patterns only,
// so it stays quiet on test fixtures. It complements (does not replace) a dedicated scanner such as gitleaks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PATTERNS = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['OpenAI/Stripe-style secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bsk-[A-Za-z0-9]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT (signed token committed to the repo)', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['Authorization header with a literal token', /Authorization['"]?\s*[:=]\s*['"`]Bearer\s+[A-Za-z0-9._-]{20,}/i],
];
const FORBIDDEN_FILES = [/\.(jks|keystore|p8|p12|pfx|mobileprovision)$/i, /(^|\/)\.env($|\.(?!example$))/];

const files = execFileSync('git', ['ls-files', '--', '.'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems = [];
for (const file of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(file))) problems.push(`${file}: file type must never be committed`);
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|hbc)$/i.test(file) || file === 'package-lock.json') continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  // Test fixtures legitimately contain fake, unsigned-looking tokens (to prove they are redacted); the other patterns still apply.
  const isTest = /\.test\.(ts|tsx)$/.test(file);
  for (const [name, re] of PATTERNS) {
    if (isTest && /^(JWT|Authorization header)/.test(name)) continue;
    if (re.test(text)) problems.push(`${file}: looks like a ${name}`);
  }
}
if (problems.length > 0) {
  console.error('Secret scan failed:\n' + problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} tracked files).`);

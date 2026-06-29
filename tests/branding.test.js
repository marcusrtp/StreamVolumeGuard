const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const allowedLegacySettingsFile = "storage/settings.js";
const allowedLegacySettingsKey = "webloudnessGuard.settings";
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg"
]);

const forbiddenFragments = [
  "WebLoudness Guard",
  "WebLoudnessGuard",
  "runWebLoudness",
  "webloudnessGuardProcessed",
  "webloudnessGuardError"
];

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "dist") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (textExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function relative(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

const files = listFiles(rootDir).filter((file) => relative(file) !== "tests/branding.test.js");

const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
assert.strictEqual(manifest.name, "__MSG_extensionName__");

for (const locale of ["en", "fr"]) {
  const messages = JSON.parse(
    fs.readFileSync(path.join(rootDir, "_locales", locale, "messages.json"), "utf8")
  );
  assert.strictEqual(messages.extensionName.message, "StreamVolume Guard");
}

const englishMessages = JSON.parse(fs.readFileSync(path.join(rootDir, "_locales", "en", "messages.json"), "utf8"));
const frenchMessages = JSON.parse(fs.readFileSync(path.join(rootDir, "_locales", "fr", "messages.json"), "utf8"));

assert.match(englishMessages.extensionDescription.message, /open source/i);
assert.match(englishMessages.extensionDescription.message, /no trackers/i);
assert.match(englishMessages.extensionDescription.message, /no data collection/i);
assert.match(frenchMessages.extensionDescription.message, /open source/i);
assert.match(frenchMessages.extensionDescription.message, /sans tracker/i);
assert.match(frenchMessages.extensionDescription.message, /sans collecte de données/i);

const publicFiles = [
  "README.md",
  "store/github-about.md",
  "docs/streamer-quickstart-60s.md",
  "popup/popup.html",
  "options/options.html",
  "test-page.html"
];

for (const file of publicFiles) {
  const content = fs.readFileSync(path.join(rootDir, file), "utf8");
  assert(
    content.includes("StreamVolume Guard"),
    `${file} should include the public project name`
  );
}

const publicTextFiles = [
  "README.md",
  "store/github-about.md",
  "docs/streamer-quickstart-60s.md",
  "docs/tester-checklist.md",
  "docs/bug-report-template.md",
  "_locales/fr/messages.json",
  "popup/popup.html",
  "options/options.html",
  "options/options.js",
  "test-page.html"
];

for (const file of publicTextFiles) {
  const content = fs.readFileSync(path.join(rootDir, file), "utf8");
  assert.doesNotMatch(
    content,
    /Ã|Â|â€™|â€œ|â€|\uFFFD/,
    `${file} should not contain mojibake or replacement characters`
  );
}

const socialPreview = fs.readFileSync(path.join(rootDir, "assets", "social-preview.png"));
assert.equal(
  socialPreview.subarray(0, 8).toString("hex"),
  "89504e470d0a1a0a",
  "assets/social-preview.png should be a PNG"
);
assert.ok(socialPreview.length < 1024 * 1024, "assets/social-preview.png should stay below 1 MB");

const githubAbout = fs.readFileSync(path.join(rootDir, "store", "github-about.md"), "utf8");
assert.match(githubAbout, /Description courte/);
assert.match(githubAbout, /chrome-extension/);
assert.match(githubAbout, /social-preview\.png/);
assert.match(githubAbout, /open source/i);
assert.match(githubAbout, /sans tracker/i);
assert.match(githubAbout, /sans collecte de données/i);
assert.match(githubAbout, /aucune donnée/i);

const readme = fs.readFileSync(path.join(rootDir, "README.md"), "utf8");
const readmeIntro = readme.split(/\r?\n/).slice(2, 6).join(" ");
assert.match(readmeIntro, /streamers/i);
assert.match(readmeIntro, /pics audio/i);
assert.match(readmeIntro, /open source/i);
assert.match(readmeIntro, /sans tracker/i);
assert.match(readmeIntro, /sans collecte de données/i);
assert.match(readmeIntro, /aucune donnée/i);
assert.ok(
  readmeIntro.indexOf("pics audio") < readmeIntro.indexOf("open source"),
  "README intro should lead with streamer value before trust proof"
);

const settingsContent = fs.readFileSync(path.join(rootDir, "storage", "settings.js"), "utf8");
assert(settingsContent.includes('const SETTINGS_KEY = "streamVolumeGuard.settings";'));
assert(settingsContent.includes('const LEGACY_SETTINGS_KEY = "webloudnessGuard.settings";'));

const violations = [];
for (const file of files) {
  const rel = relative(file);
  const content = fs.readFileSync(file, "utf8");

  for (const fragment of forbiddenFragments) {
    if (content.includes(fragment)) {
      violations.push(`${rel}: contains ${fragment}`);
    }
  }

  if (rel !== allowedLegacySettingsFile && content.includes(allowedLegacySettingsKey)) {
    violations.push(`${rel}: contains legacy storage key outside migration module`);
  }
}

assert.deepStrictEqual(violations, []);

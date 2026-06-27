const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const {
  TARGETS,
  buildManifestForTarget,
  buildAllTargets
} = require("../tools/build-targets.js");

function readBaseManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test("build targets cover desktop and mobile browser families", () => {
  assert.deepEqual(
    TARGETS.map((target) => target.id),
    ["chromium", "firefox", "firefox-android", "safari-source"]
  );
  assert.equal(TARGETS.find((target) => target.id === "firefox-android").mobile, true);
  assert.equal(TARGETS.find((target) => target.id === "safari-source").requiresExternalPackaging, true);
});

test("Firefox manifests declare Gecko settings and no external data collection", () => {
  const baseManifest = readBaseManifest();
  const firefox = buildManifestForTarget(baseManifest, "firefox");
  const firefoxAndroid = buildManifestForTarget(baseManifest, "firefox-android");

  assert.equal(firefox.manifest_version, 3);
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.equal(firefox.background.service_worker, "background.js");
  assert.deepEqual(firefox.background.scripts, [
    "storage/settings.js",
    "license/capabilities.js",
    "background.js"
  ]);
  assert.equal(firefox.browser_specific_settings.gecko.id, "streamvolume-guard@local");
  assert.equal(firefox.permissions.includes("tabCapture"), false);
  assert.equal(firefox.permissions.includes("offscreen"), false);
  assert.deepEqual(
    firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
  assert.equal(firefox.browser_specific_settings.gecko_android, undefined);

  assert.equal(firefoxAndroid.minimum_chrome_version, undefined);
  assert.equal(firefoxAndroid.background.service_worker, "background.js");
  assert.deepEqual(firefoxAndroid.background.scripts, [
    "storage/settings.js",
    "license/capabilities.js",
    "background.js"
  ]);
  assert.equal(firefoxAndroid.browser_specific_settings.gecko.id, "streamvolume-guard@local");
  assert.equal(firefoxAndroid.permissions.includes("tabCapture"), false);
  assert.equal(firefoxAndroid.permissions.includes("offscreen"), false);
  assert.equal(firefoxAndroid.browser_specific_settings.gecko_android.strict_min_version, "121.0");
  assert.deepEqual(
    firefoxAndroid.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
});

test("Safari source manifest is prepared without claiming final Xcode packaging", () => {
  const baseManifest = readBaseManifest();
  const safari = buildManifestForTarget(baseManifest, "safari-source");

  assert.equal(safari.minimum_chrome_version, undefined);
  assert.equal(safari.background.service_worker, "background.js");
  assert.deepEqual(safari.background.scripts, [
    "storage/settings.js",
    "license/capabilities.js",
    "background.js"
  ]);
  assert.equal(safari.browser_specific_settings.safari.strict_min_version, "15.0");
  assert.equal(safari.permissions.includes("tabCapture"), false);
  assert.equal(safari.permissions.includes("offscreen"), false);
  assert.equal(safari.action.default_popup, "popup/popup.html");
});

test("buildAllTargets writes clean dist folders with target manifests", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svg-build-targets-"));
  try {
    const results = buildAllTargets({ projectRoot: root, outputRoot });

    assert.equal(results.length, TARGETS.length);
    for (const target of TARGETS) {
      const manifestPath = path.join(outputRoot, target.id, "manifest.json");
      const readmePath = path.join(outputRoot, target.id, "README.md");
      const testPagePath = path.join(outputRoot, target.id, "test-page.html");
      const gitPath = path.join(outputRoot, target.id, ".git");
      const distPath = path.join(outputRoot, target.id, "dist");
      const testsPath = path.join(outputRoot, target.id, "tests");
      const toolsPath = path.join(outputRoot, target.id, "tools");
      const docsPath = path.join(outputRoot, target.id, "docs");
      const roadmapPath = path.join(outputRoot, target.id, "docs", "future-implementation-roadmap.md");
      const userDocs = [
        "bug-report-template.md",
        "cross-browser-deployment.md",
        "streamer-quickstart-60s.md",
        "tester-checklist.md"
      ];

      assert.equal(fs.existsSync(manifestPath), true, `${target.id} manifest should exist`);
      assert.equal(fs.existsSync(readmePath), true, `${target.id} README should exist`);
      assert.equal(fs.existsSync(testPagePath), true, `${target.id} test page should exist`);
      assert.equal(fs.existsSync(docsPath), true, `${target.id} should contain user docs`);
      for (const doc of userDocs) {
        assert.equal(
          fs.existsSync(path.join(docsPath, doc)),
          true,
          `${target.id} should include docs/${doc}`
        );
      }
      assert.equal(fs.existsSync(roadmapPath), false, `${target.id} should not include the future roadmap`);
      assert.equal(fs.existsSync(gitPath), false, `${target.id} should not contain .git`);
      assert.equal(fs.existsSync(distPath), false, `${target.id} should not contain nested dist`);
      assert.equal(fs.existsSync(testsPath), false, `${target.id} should not contain tests`);
      assert.equal(fs.existsSync(toolsPath), false, `${target.id} should not contain tools`);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("public docs explain browser support and platform limits", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const gitignorePath = path.join(root, ".gitignore");
  const doc = fs.readFileSync(path.join(root, "docs", "cross-browser-deployment.md"), "utf8");

  assert.match(readme, /docs\/cross-browser-deployment\.md/);
  assert.match(readme, /github\.com\/Fredo0xJtl\/StreamVolume-Guard\/releases/);
  assert.match(readme, /streamvolume-guard-chromium-0\.1\.3\.zip/);
  assert.match(readme, /streamvolume-guard-firefox-0\.1\.3\.zip/);
  assert.match(readme, /streamvolume-guard-firefox-android-0\.1\.3\.zip/);
  assert.match(readme, /streamvolume-guard-safari-source-0\.1\.3\.zip/);
  assert.match(readme, /edge:\/\/extensions/);
  assert.match(readme, /dist[\\/]chromium/);
  assert.match(readme, /about:debugging#\/runtime\/this-firefox/);
  assert.match(readme, /manifest\.json/);
  assert.match(readme, /dist[\\/]safari-source/);
  assert.match(readme, /Xcode/);
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, "utf8");
    assert.doesNotMatch(gitignore, /^dist\/$/m);
  }
  assert.match(doc, /Firefox desktop/);
  assert.match(doc, /Firefox Android/);
  assert.match(doc, /Safari macOS/);
  assert.match(doc, /Safari iOS\/iPadOS/);
  assert.match(doc, /Chrome Android/);
  assert.match(doc, /non supporté officiellement/i);
  assert.match(doc, /node tools\/build-targets\.js/);
  assert.match(doc, /web-ext lint/);
  assert.match(doc, /Xcode/);
});

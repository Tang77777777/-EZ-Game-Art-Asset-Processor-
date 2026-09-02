import { join } from "node:path";
import { renameSync, rmSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_FILES = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
] as const;
const CHANGELOG_FILES = ["docs/CHANGELOG.md", "docs/CHANGELOG.zh-CN.md"] as const;
const README_FILES = ["README.md", "README.zh-CN.md"] as const;
const API_DOC_FILES = ["docs/api.md", "docs/api.zh-CN.md"] as const;
const WORKSPACE_NAMES = ["@ezgameart/server", "@ezgameart/web", "@ezgameart/shared"] as const;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LATEST_CHANGELOG_START = "<!-- latest-changelog:start -->";
const LATEST_CHANGELOG_END = "<!-- latest-changelog:end -->";

function fail(message: string): never {
  console.error(`错误：${message}`);
  process.exit(1);
}

async function read(path: string): Promise<string> {
  const file = Bun.file(join(ROOT, path));
  if (!(await file.exists())) fail(`文件不存在：${path}`);
  return file.text();
}

function parseVersion(value: string): [number, number, number] {
  const match = SEMVER.exec(value);
  if (!match) fail(`不是合法 SemVer：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
  return 0;
}

function nextVersion(current: string, target: string): string {
  if (SEMVER.test(target)) return target;
  const [major, week, bug] = parseVersion(current);
  if (target === "major") return `${major + 1}.1.0`;
  if (target === "week" || target === "minor") return `${major}.${week + 1}.0`;
  if (target === "bug" || target === "patch") return `${major}.${week}.${bug + 1}`;
  fail("目标必须是 bug、week、major 或完整版本号（patch/minor 为兼容别名）");
}

function latestChangelogBlock(changelog: string, lang: "en" | "zh"): string {
  const releases = [...changelog.matchAll(/^## \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\] - ([^\n]+)\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm)].slice(0, 2);
  if (releases.length < 2) fail(`${lang === "en" ? CHANGELOG_FILES[0] : CHANGELOG_FILES[1]} 至少需要两个已发布版本`);
  const changelogPath = lang === "en" ? "docs/CHANGELOG.md" : "docs/CHANGELOG.zh-CN.md";
  const title = lang === "en" ? "Latest Changes" : "最近更新";
  const linkText = lang === "en" ? "View the complete changelog →" : "查看完整变更日志 →";
  const sections = releases.map((match) => {
    const [, version, date, body] = match;
    const anchor = `${version.replaceAll(".", "")}---${date}`;
    return `### [${version}](${changelogPath}#${anchor}) · ${date}\n\n${body.trim().replace(/^### /gm, "#### ")}`;
  });
  return `${LATEST_CHANGELOG_START}\n## ${title}\n\n${sections.join("\n\n")}\n\n[${linkText}](${changelogPath})\n${LATEST_CHANGELOG_END}`;
}

function replaceLatestChangelog(readme: string, changelog: string, lang: "en" | "zh", path: string): string {
  const pattern = new RegExp(`${LATEST_CHANGELOG_START}[\\s\\S]*?${LATEST_CHANGELOG_END}`);
  if (!pattern.test(readme)) fail(`${path} 缺少唯一的最近变更标记区域`);
  return readme.replace(pattern, latestChangelogBlock(changelog, lang));
}

const packageTexts = await Promise.all(PACKAGE_FILES.map(read));
const versions = packageTexts.map((text, i) => {
  const value = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof value !== "string") fail(`${PACKAGE_FILES[i]} 缺少 version`);
  parseVersion(value);
  return value;
});
const current = versions[0];
if (versions.some((version) => version !== current)) {
  fail(`workspace 版本不一致：${PACKAGE_FILES.map((file, i) => `${file}=${versions[i]}`).join(", ")}`);
}

const changelogs = await Promise.all(CHANGELOG_FILES.map(read));
for (let i = 0; i < changelogs.length; i++) {
  if (!changelogs[i].includes(`## [${current}]`)) fail(`${CHANGELOG_FILES[i]} 缺少当前版本 ${current}`);
  if (!changelogs[i].includes("## [Unreleased]")) fail(`${CHANGELOG_FILES[i]} 缺少 Unreleased 区域`);
}
const readmes = await Promise.all(README_FILES.map(read));
for (let i = 0; i < readmes.length; i++) {
  const expected = replaceLatestChangelog(readmes[i], changelogs[i], i === 0 ? "en" : "zh", README_FILES[i]);
  if (expected !== readmes[i]) fail(`${README_FILES[i]} 的最近两个版本与 ${CHANGELOG_FILES[i]} 不一致，请运行 version:bump 或同步该区域`);
}

const lockText = await read("bun.lock");
for (const name of WORKSPACE_NAMES) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"name": "${escapedName}",\\n\\s+"version": "([^"]+)"`).exec(lockText);
  if (!match || match[1] !== current) fail(`bun.lock 中 ${name} 的版本不是 ${current}`);
}

const command = Bun.argv[2] ?? "check";
if (command === "check") {
  console.log(`✓ EZ Game Art Asset Processor ${current}：根包、workspace、bun.lock、changelog 与 README 最近版本一致`);
  process.exit(0);
}
if (command !== "bump" && command !== "plan") {
  fail("用法：bun run version:check、bun run version:plan -- bug|week|major，或 bun run version:bump -- bug|week|major");
}

const requested = Bun.argv[3];
if (!requested) fail("缺少目标：bug、week、major 或完整版本号");
const next = nextVersion(current, requested);
if (compare(next, current) <= 0) fail(`新版本 ${next} 必须高于当前版本 ${current}`);
if (command === "plan") {
  console.log(`${current} → ${next}`);
  process.exit(0);
}

const releaseDate = new Date().toISOString().slice(0, 10);
const releasedChangelogs = changelogs.map((text, i) => {
  const match = /## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[)/.exec(text);
  if (!match || !match[1].trim()) fail(`${CHANGELOG_FILES[i]} 的 Unreleased 没有变更条目`);
  return text.replace("## [Unreleased]", `## [Unreleased]\n\n## [${next}] - ${releaseDate}`);
});

// 所有目标内容先在内存中完成并校验，避免校验失败时只更新一半文件。
const outputs = new Map<string, string>();
for (let i = 0; i < PACKAGE_FILES.length; i++) {
  const pkg = JSON.parse(packageTexts[i]) as Record<string, unknown>;
  pkg.version = next;
  outputs.set(PACKAGE_FILES[i], `${JSON.stringify(pkg, null, 2)}\n`);
}

let nextLock = lockText;
for (const name of WORKSPACE_NAMES) {
  const before = `"name": "${name}",\n      "version": "${current}"`;
  const after = `"name": "${name}",\n      "version": "${next}"`;
  if (nextLock.split(before).length !== 2) fail(`bun.lock 中 ${name} 的版本位置不唯一`);
  nextLock = nextLock.replace(before, after);
}
outputs.set("bun.lock", nextLock);

for (let i = 0; i < CHANGELOG_FILES.length; i++) {
  outputs.set(CHANGELOG_FILES[i], releasedChangelogs[i]);
  outputs.set(
    README_FILES[i],
    replaceLatestChangelog(readmes[i], releasedChangelogs[i], i === 0 ? "en" : "zh", README_FILES[i])
  );
}
for (const path of API_DOC_FILES) {
  const text = await read(path);
  const before = `"name": "ezgameart-asset-processor", "version": "${current}"`;
  if (text.split(before).length !== 2) fail(`${path} 中 MCP 版本示例位置不唯一`);
  outputs.set(path, text.replace(before, `"name": "ezgameart-asset-processor", "version": "${next}"`));
}

const staged: Array<{ temp: string; destination: string }> = [];
try {
  for (const [path, content] of outputs) {
    const destination = join(ROOT, path);
    const temp = `${destination}.version-tmp-${process.pid}`;
    await Bun.write(temp, content);
    staged.push({ temp, destination });
  }
  for (const file of staged) renameSync(file.temp, file.destination);
} catch (error) {
  for (const file of staged) rmSync(file.temp, { force: true });
  throw error;
}

console.log(`✓ EZ Game Art Asset Processor ${current} → ${next}`);
console.log("已同步 package.json、workspace、bun.lock、API 文档、中英文 changelog 与 README 最近两个版本；未执行任何 git 操作。");

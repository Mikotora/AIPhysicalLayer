import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type CheckMode = "staged" | "tracked";
type Finding = { category: string; file: string; line: number };
type LiteralPattern = { category: string; value: string };

const EXPECTED_GIT_AUTHOR = "Mikotora";
const EXPECTED_GIT_EMAIL = "344910423+Mikotora@users.noreply.github.com";

function git(args: string[], encoding: BufferEncoding = "utf8"): string {
  return execFileSync("git", args, { encoding, stdio: ["ignore", "pipe", "ignore"] });
}

function commandValue(command: string, args: string[]): string | undefined {
  try {
    const value = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function addLiteral(patterns: LiteralPattern[], category: string, value: string | undefined): void {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 4) return;
  if (!patterns.some((pattern) => pattern.value.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    patterns.push({ category, value: normalized });
  }
}

function localPersonalPatterns(gitDir: string): LiteralPattern[] {
  const path = join(gitDir, "info", "personal-patterns");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2 && !line.startsWith("#"))
    .map((value) => ({ category: "local personal pattern", value }));
}

function literalPatterns(gitDir: string): LiteralPattern[] {
  const patterns: LiteralPattern[] = [];
  addLiteral(patterns, "current home path", homedir());
  addLiteral(patterns, "current OS username", userInfo().username);
  addLiteral(patterns, "current hostname", hostname());
  addLiteral(patterns, "current computer name", commandValue("scutil", ["--get", "ComputerName"]));
  addLiteral(patterns, "current local hostname", commandValue("scutil", ["--get", "LocalHostName"]));
  addLiteral(patterns, "current OS full name", commandValue("id", ["-F"]));
  patterns.push(...localPersonalPatterns(gitDir));
  return patterns;
}

function nulSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function filesFor(mode: CheckMode): string[] {
  return mode === "staged"
    ? nulSeparated(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]))
    : nulSeparated(git(["ls-files", "-z"]));
}

function fileContents(mode: CheckMode, repoRoot: string, file: string): Buffer {
  if (mode === "staged") {
    return execFileSync("git", ["show", `:${file}`], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
  }
  return readFileSync(join(repoRoot, file));
}

function inspectFile(file: string, contents: Buffer, literals: LiteralPattern[]): Finding[] {
  if (contents.includes(0)) return [];
  const findings: Finding[] = [];
  const lines = contents.toString("utf8").split(/\r?\n/);
  const genericHomePattern = /\/(?:Users|home)\/[^/\s"'`]+\//u;

  lines.forEach((line, index) => {
    if (genericHomePattern.test(line)) {
      findings.push({ category: "absolute user home path", file, line: index + 1 });
    }
    const lowerLine = line.toLocaleLowerCase();
    for (const pattern of literals) {
      if (lowerLine.includes(pattern.value.toLocaleLowerCase())) {
        findings.push({ category: pattern.category, file, line: index + 1 });
      }
    }
  });
  return findings;
}

function inspectPath(file: string, literals: LiteralPattern[]): Finding[] {
  return inspectFile(file, Buffer.from(file, "utf8"), literals).map((finding) => ({
    ...finding,
    category: `${finding.category} in file path`,
    line: 0,
  }));
}

function verifyGitIdentity(findings: Finding[]): void {
  const name = commandValue("git", ["config", "--local", "--get", "user.name"]);
  const email = commandValue("git", ["config", "--local", "--get", "user.email"]);
  if (name !== EXPECTED_GIT_AUTHOR) findings.push({ category: "unexpected local Git author", file: ".git/config", line: 0 });
  if (email !== EXPECTED_GIT_EMAIL) findings.push({ category: "unexpected local Git email", file: ".git/config", line: 0 });
}

function selfTest(): void {
  const syntheticPath = `${["", "Users", "example", "project"].join("/")}/file.txt`;
  const findings = inspectFile("fixture.txt", Buffer.from(`path=${syntheticPath}\n`, "utf8"), []);
  if (findings.length !== 1 || findings[0]?.category !== "absolute user home path") {
    throw new Error("self-test failed");
  }
  const pathFindings = inspectPath("private-label/file.txt", [{ category: "local personal pattern", value: "private-label" }]);
  if (pathFindings.length !== 1 || pathFindings[0]?.line !== 0) {
    throw new Error("path self-test failed");
  }
  console.log("personal-info check self-test passed");
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const mode: CheckMode = process.argv.includes("--staged") ? "staged" : "tracked";
  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  const rawGitDir = git(["rev-parse", "--git-dir"]).trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(repoRoot, rawGitDir);
  const literals = literalPatterns(gitDir);
  const files = filesFor(mode);
  const findings = [
    ...files.flatMap((file) => inspectPath(file, literals)),
    ...files.flatMap((file) => inspectFile(file, fileContents(mode, repoRoot, file), literals)),
  ];
  verifyGitIdentity(findings);

  const unique = [...new Map(findings.map((finding) => [
    `${finding.category}\0${finding.file}\0${finding.line}`,
    finding,
  ])).values()];

  if (unique.length > 0) {
    console.error("personal-info check failed; matched values are hidden:");
    for (const finding of unique) {
      const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`- ${finding.category}: ${location}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`personal-info check passed (${mode}, ${files.length} files)`);
}

try {
  main();
} catch {
  console.error("personal-info check could not run; no matched value was printed");
  process.exitCode = 2;
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, isHazardousFile, isEditLikeBashCommand } from "./bash-parser.ts";

describe("parseCommand", () => {
  describe("subcommands", () => {
    const EXACT: [string, string[]][] = [
      ["pwd", ["pwd"]],
      ["cat file.txt", ["cat file.txt"]],
      ["ls -la /tmp", ["ls -la /tmp"]],
      ["hostname", ["hostname"]],
      ["hostname -I", ["hostname -I"]],
      ["git status", ["git status"]],
      ["git status --short", ["git status --short"]],
      ["npm list", ["npm list"]],
      ["sed -n 1p file", ["sed -n 1p file"]],
      ["git config --get user.name", ["git config --get user.name"]],
      ['cat "README.md"', ["cat README.md"]],
      ['echo "hello world"', ["echo hello world"]],
      ["echo 'hello world'", ["echo hello world"]],
      ['echo ""', ['echo ""']],
      ["echo ''", ["echo ''"]],
      ['printf ""', ['printf ""']],
      ['echo "" hello', ['echo "" hello']],
      ["ls | grep foo", ["ls", "grep foo"]],
      ["cat a | sort | uniq", ["cat a", "sort", "uniq"]],
      ["cd dir && ls", ["cd dir", "ls"]],
      ["cmd1 || cmd2", ["cmd1", "cmd2"]],
      ["cmd1 && cmd2 || cmd3", ["cmd1", "cmd2", "cmd3"]],
      ["ls > out.txt", ["ls"]],
      ["ls | ls", ["ls"]],
      ["someunknowncmd", ["someunknowncmd"]],
    ];

    for (const [input, expected] of EXACT) {
      it(`${input} → [${expected.join(", ")}]`, () => {
        assert.deepEqual(parseCommand(input).subcommands, expected);
      });
    }

    it("empty input returns []", () => {
      assert.deepEqual(parseCommand("").subcommands, []);
      assert.deepEqual(parseCommand("   ").subcommands, []);
    });

    // Regression: the parser rejects tokens it flags as `Expected a command
    // word` (a trailing `a()` inside an interpreter one-liner). parse runs
    // with recoverErrors so the parseable prefix still classifies.
    it("recovers malformed inline code with parens/operators", () => {
      assert.deepEqual(parseCommand("node -e a()").subcommands, ["node -e a"]);
      assert.deepEqual(parseCommand("node --eval a()").subcommands, ["node --eval a"]);
      assert.deepEqual(parseCommand("python -c a()").subcommands, ["python -c a"]);
      // Literal operators inside quoted code are unaffected.
      assert.deepEqual(parseCommand('node -e "a()"').subcommands, ["node -e a()"]);
    });

    it("keeps placeholder for variable expansions in double quotes", () => {
      assert.ok(parseCommand('echo "$HOME"').subcommands[0]!.includes('"..."'));
    });

    it("keeps placeholder for command substitutions in double quotes", () => {
      assert.ok(parseCommand('echo "$(whoami)"').subcommands[0]!.includes('"..."'));
    });

    it("extracts command from $(...) in arguments", () => {
      const r = parseCommand('echo "$(whoami)"').subcommands;
      assert.ok(r.some((c) => c.startsWith("echo")));
      assert.ok(r.some((c) => c === "whoami"));
    });

    it("extracts command from variable assignment with $()", () => {
      assert.ok(parseCommand("x=$(date)").subcommands.includes("date"));
    });

    it("extracts commands from <(...) process substitution", () => {
      const r = parseCommand("diff <(sort a) <(sort b)").subcommands;
      assert.ok(r.some((c) => c.startsWith("diff")));
      assert.ok(r.includes("sort a"));
    });

    it("extracts commands from subshell", () => {
      const r = parseCommand("(cd dir && ls)").subcommands;
      assert.ok(r.some((c) => c === "cd dir"));
      assert.ok(r.includes("ls"));
    });

    it("extracts commands from brace group", () => {
      const r = parseCommand("{ cmd1; cmd2; }").subcommands;
      assert.ok(r.includes("cmd1"));
      assert.ok(r.includes("cmd2"));
    });

    it("emits find:exec for find -exec", () => {
      const r = parseCommand('find . -name "*.ts" -exec rm {} \\;');
      assert.ok(r.subcommands.includes("find:exec"));
      assert.ok(!r.subcommands.some((c) => c.startsWith("find .") && c !== "find:exec"));
    });

    it("emits find:exec for find -execdir", () => {
      assert.ok(parseCommand('find . -execdir ls {} \\;').subcommands.includes("find:exec"));
    });

    it("emits find:delete for find -delete", () => {
      assert.deepEqual(parseCommand("find . -delete").subcommands, ["find:delete"]);
    });

    it("detects -delete regardless of position", () => {
      assert.deepEqual(parseCommand('find . -delete -name "*.ts"').subcommands, ["find:delete"]);
    });

    it("returns plain find when no -exec or -delete", () => {
      const r = parseCommand('find . -name "*.ts"').subcommands;
      assert.equal(r.length, 1);
      assert.ok(r[0]!.startsWith("find ."));
    });

    it("handles find with \\( \\) grouping", () => {
      const r = parseCommand('find . \\( -name "*.ts" -o -name "*.js" \\)').subcommands;
      assert.equal(r.length, 1);
      assert.ok(r[0]!.startsWith("find ."));
      assert.ok(r[0]!.includes("-name"));
    });

    it("handles find \\( \\) in pipeline", () => {
      const r = parseCommand("find . \\( -name '*.md' \\) | sed 's#^#/##' | head -200").subcommands;
      assert.equal(r.length, 3);
      assert.ok(r[0]!.startsWith("find ."));
      assert.ok(r[1]!.startsWith("sed"));
      assert.ok(r[2]!.startsWith("head"));
    });

    it("handles nested \\( \\) in find", () => {
      const r = parseCommand('find . \\( \\( -name "*.ts" \\) -o -name "*.js" \\)').subcommands;
      assert.equal(r.length, 1);
      assert.ok(r[0]!.startsWith("find ."));
    });

    it("handles find \\( \\) with -exec", () => {
      const r = parseCommand('find . \\( -name "*.ts" \\) -exec rm {} \\;').subcommands;
      assert.ok(r.includes("find:exec"));
    });

    it("extracts sudo + underlying command", () => {
      assert.ok(parseCommand("sudo rm file").subcommands.some((c) => c === "sudo rm file"));
    });

    it("extracts sudo apt install", () => {
      assert.ok(parseCommand("sudo apt install foo").subcommands.some((c) => c === "sudo apt install foo"));
    });

    // xargs stripping
    it("strips xargs and returns inner command", () => {
      assert.deepEqual(parseCommand("xargs echo hello").subcommands, ["echo hello"]);
    });

    it("strips xargs flags without args", () => {
      assert.deepEqual(parseCommand("xargs -0 echo hello").subcommands, ["echo hello"]);
    });

    it("strips xargs flags with separate args", () => {
      assert.deepEqual(parseCommand("xargs -n 2 echo hello").subcommands, ["echo hello"]);
    });

    // The shell parser misparses standalone {} as a brace group (Block),
    // so we preprocess {} into "{}" before parsing.  With this fix,
    // xargs -I {} rm {} correctly produces the inner command with its {}
    // argument preserved.
    it("strips xargs -I with {} arg", () => {
      assert.deepEqual(parseCommand("xargs -I {} rm {}").subcommands, ["rm {}"]);
    });

    it("strips multiple xargs flags", () => {
      assert.deepEqual(parseCommand("xargs -0 -r -n 2 echo hello").subcommands, ["echo hello"]);
    });

    it("strips xargs --  and treats next word as command", () => {
      assert.deepEqual(parseCommand("xargs -- rm -i").subcommands, ["rm -i"]);
    });

    it("defaults to echo for bare xargs with no inner command", () => {
      assert.deepEqual(parseCommand("xargs").subcommands, ["echo"]);
    });

    it("strips xargs long flags", () => {
      assert.deepEqual(parseCommand("xargs --no-run-if-empty echo hello").subcommands, ["echo hello"]);
    });

    it("strips xargs long flags with =value", () => {
      assert.deepEqual(parseCommand("xargs --max-args=2 echo hello").subcommands, ["echo hello"]);
    });

    // timeout <duration> cmd: wrapper is preapproved (baseline timeout *),
    // and we also push the inner command so it gets evaluated normally.
    it("strips timeout and returns inner command", () => {
      const r = parseCommand("timeout 10 echo hi").subcommands;
      assert.ok(r.includes("timeout 10"));
      assert.ok(r.includes("echo hi"));
    });

    it("strips timeout with suffixed duration", () => {
      const r = parseCommand("timeout 5s rm file").subcommands;
      assert.ok(r.includes("timeout 5s"));
      assert.ok(r.includes("rm file"));
    });

    it("handles timeout 0 duration", () => {
      const r = parseCommand("timeout 0 cat foo").subcommands;
      assert.ok(r.includes("timeout 0"));
      assert.ok(r.includes("cat foo"));
    });

    it("timeout with no inner command only pushes the wrapper", () => {
      const r = parseCommand("timeout 10").subcommands;
      assert.deepEqual(r, ["timeout 10"]);
    });

    it("keeps sudo prefix with xargs inside", () => {
      // sudo xargs: sudo is kept, xargs is stripped
      assert.ok(parseCommand("sudo xargs rm file").subcommands.some((c) => c === "sudo rm file"));
    });

    it("preserves {} in echo command", () => {
      assert.deepEqual(parseCommand("echo {}").subcommands, ["echo {}"]);
    });

    it("preserves {} in pipeline with xargs", () => {
      const r = parseCommand("find . -print0 | xargs -0 rm {}");
      assert.ok(r.subcommands.includes("rm {}"));
    });

    it("extracts command without append redirect target", () => {
      const r = parseCommand("echo hi >> log.txt").subcommands;
      assert.ok(r.some((c) => c.startsWith("echo")));
      assert.ok(!r.some((c) => c.startsWith(">")));
    });

    it("extracts [ test as subcommand", () => {
      const r = parseCommand("[ -f package.json ]");
      assert.equal(r.subcommands.length, 1);
      assert.ok(r.subcommands[0]!.startsWith("[ -f package.json ]"));
    });

    it("extracts [[ test as subcommand", () => {
      const r = parseCommand("[[ -f package.json ]]");
      assert.equal(r.subcommands.length, 1);
      assert.ok(r.subcommands[0]!.startsWith("[[ -f package.json ]]"));
    });

    it("extracts printf as subcommand", () => {
      const r = parseCommand("printf '\\nPackage:\\n'");
      assert.equal(r.subcommands.length, 1);
      assert.ok(r.subcommands[0]!.startsWith("printf"));
    });

    it("extracts [ -f path ] as input redirect", () => {
      const r = parseCommand("[ -f /etc/passwd ]");
      assert.ok(r.redirects.some((t) => t.path === "/etc/passwd" && t.direction === "input"));
    });

    it("extracts [[ -f path ]] as input redirect", () => {
      const r = parseCommand("[[ -f package.json ]]");
      assert.ok(r.redirects.some((t) => t.path === "package.json" && t.direction === "input"));
    });

    it("extracts multiple file paths from [[ with -ef", () => {
      const r = parseCommand("[[ file1 -ef file2 ]]");
      assert.ok(r.redirects.some((t) => t.path === "file1"));
      assert.ok(r.redirects.some((t) => t.path === "file2"));
    });

    it("does not extract paths from non-file test operators", () => {
      const r = parseCommand("[[ a == b ]]");
      assert.equal(r.redirects.length, 0);
    });
  });

  describe("opaque string collapsing", () => {
    it("collapses long single-quoted strings to '...'", () => {
      const longScript = "a".repeat(41);
      const r = parseCommand(`bun -e '${longScript}'`);
      assert.equal(r.subcommands[0], "bun -e '...'");
    });

    it("keeps short single-quoted strings inline", () => {
      const r = parseCommand("bun -e 'console.log(1)'");
      assert.equal(r.subcommands[0], "bun -e console.log(1)");
    });

    it("collapses multiline single-quoted strings regardless of length", () => {
      const r = parseCommand("bun -e 'line1\nline2'");
      assert.equal(r.subcommands[0], "bun -e '...'");
    });

    it("collapses long double-quoted strings to \"...\"", () => {
      const longStr = "a".repeat(41);
      const r = parseCommand(`echo "${longStr}"`);
      assert.equal(r.subcommands[0], 'echo "..."');
    });

    it("keeps short double-quoted strings inline", () => {
      const r = parseCommand('echo "hello world"');
      assert.equal(r.subcommands[0], "echo hello world");
    });

    it("collapses multiline double-quoted strings regardless of length", () => {
      const r = parseCommand('echo "line1\nline2"');
      assert.equal(r.subcommands[0], 'echo "..."');
    });

    it("appends <<< '...' for here-string redirects", () => {
      const r = parseCommand("bun -e <<< 'script content'");
      assert.equal(r.subcommands[0], "bun -e <<< '...'");
    });

    it("appends << '...' for heredoc redirects", () => {
      const r = parseCommand("cat <<EOF > file.txt\nhello\nEOF");
      assert.equal(r.subcommands.length, 1);
      assert.ok(r.subcommands[0]!.includes("<< '...'"));
    });

    it("detects output redirects alongside a heredoc", () => {
      const r = parseCommand("cat <<EOF > file.txt\nhello\nEOF");
      assert.ok(r.redirects.some((t) => t.path === "file.txt" && t.direction === "output"));
    });

    it("collapsing produces identical subcommands for different opaque content (rule-matching semantics)", () => {
      // Two completely different long scripts should produce the same subcommand
      // so that approving one creates a rule that matches the other.
      const longA = "a".repeat(41);
      const longB = "b".repeat(41);
      const sub1 = parseCommand(`bun -e '${longA}'`).subcommands[0];
      const sub2 = parseCommand(`bun -e '${longB}'`).subcommands[0];
      assert.equal(sub1, sub2);

      // Same for here-strings
      const heredoc1 = parseCommand("bun -e <<< 'script A'").subcommands[0];
      const heredoc2 = parseCommand("bun -e <<< 'script B'").subcommands[0];
      assert.equal(heredoc1, heredoc2);

      // Same for heredocs
      const heredocA = parseCommand("cat <<EOF > a.txt\nalpha\nEOF").subcommands[0];
      const heredocB = parseCommand("cat <<EOF > b.txt\nbeta\nEOF").subcommands[0];
      assert.equal(heredocA, heredocB);

      // Inline vs here-string are different shapes — different subcommands
      assert.notEqual(sub1, heredoc1);
    });
  });

  describe("redirects", () => {
    const EXACT: [string, { path: string; direction: "input" | "output" }[]][] = [
      ["ls > out.txt", [{ path: "out.txt", direction: "output" }]],
      ["echo hi >> log.txt", [{ path: "log.txt", direction: "output" }]],
      ["cmd &> all.txt", [{ path: "all.txt", direction: "output" }]],
      ["cmd >| force.txt", [{ path: "force.txt", direction: "output" }]],
      ["sort < data.txt", [{ path: "data.txt", direction: "input" }]],
      ['echo hi > ".env"', [{ path: ".env", direction: "output" }]],
      ['echo hi > "/etc/passwd"', [{ path: "/etc/passwd", direction: "output" }]],
      ["sort < .env", [{ path: ".env", direction: "input" }]],
    ];

    const EMPTY: [string][] = [
      ["ls -la"],
      ["ls | grep foo"],
    ];

    for (const [input, expected] of EXACT) {
      it(`${input}`, () => {
        assert.deepEqual(parseCommand(input).redirects, expected);
      });
    }

    for (const [input] of EMPTY) {
      it(`${input} → []`, () => {
        assert.deepEqual(parseCommand(input).redirects, []);
      });
    }

    it("extracts multiple redirect targets", () => {
      const r = parseCommand("cmd > out.txt 2>> err.txt").redirects;
      assert.ok(r.some((t) => t.path === "out.txt" && t.direction === "output"));
      assert.ok(r.some((t) => t.path === "err.txt" && t.direction === "output"));
    });

    // Regression: redirects written after a compound command (fi/done/}/)/esac)
    // attach to the compound node rather than a SimpleCommand/command.  Without
    // explicit surfacing in the walker these vanish from parsed.redirects,
    // silently dropping the file-permission check.  Each case below is a
    // distinct compound node type.
    const COMPOUND: [string, string, "input" | "output"][] = [
      ["while read x; do echo $x; done < files", "files", "input"],
      ["{ a; b; } > out", "out", "output"],
      ["( a; b ) > out", "out", "output"],
      ["for x in a b; do echo $x; done > out", "out", "output"],
      ["case $x in a) echo a;; esac > out", "out", "output"],
      ["f() { echo hi; } > out", "out", "output"],
      ["if foo; then bar; fi < input", "input", "input"],
    ];

    for (const [input, path, direction] of COMPOUND) {
      it(`keeps compound redirect: ${input}`, () => {
        assert.ok(
          parseCommand(input).redirects.some((t) => t.path === path && t.direction === direction),
          `expected ${direction} redirect to ${path}`,
        );
      });
    }
  });

  describe("catastrophic", () => {
    const BLOCKED = [
      ["rm -rf /", "rm -rf root"],
      ["rm -fr /", "rm -fr root"],
      ["rm -rf /usr", "rm -rf protected dir"],
      ["rm -rf /usr/local", "rm -rf protected subdir"],
      ["rm -rf /etc", "rm -rf /etc"],
      ["rm -rf /home", "rm -rf /home"],
      ["rm -rf /var", "rm -rf /var"],
      ["rm -rf /opt", "rm -rf /opt"],
      ["rm -rf /tmp", "rm -rf /tmp"],
      ["rm -rf /etc /var ./node_modules", "rm with buried protected arg"],
      ["rm -rf / --no-preserve-root", "rm with --no-preserve-root"],
      ["sudo rm -rf /etc", "sudo rm protected"],
      ["sudo rm -rf /home", "sudo rm /home"],
      ["rm -rf /*", "rm -rf /*"],
      ["rm -rf ~", "rm -rf ~"],
      ['rm "/etc"', "rm double-quoted protected"],
      ['rm "/usr"', "rm double-quoted protected"],
      ['sudo rm "/etc"', "sudo rm double-quoted protected"],
      ["sudo -u root rm /etc", "sudo with flags before command"],
      ["sudo -E chmod 777 /usr", "sudo -E chmod protected"],
      ["chmod -R 777 /", "chmod -R 777 root"],
      ["chmod 777 /usr", "chmod protected dir"],
      ["chmod -R 755 /etc", "chmod -R protected"],
      ["sudo chmod 777 /usr", "sudo chmod protected"],
      ["chown root /etc", "chown protected"],
      ["chown -R root:root /usr", "chown -R protected"],
      ["sudo chown root /tmp", "sudo chown protected"],
      ["mkfs.ext4 /dev/sda1", "mkfs.ext4"],
      ["mkfs -t ext4 /dev/sda1", "mkfs -t"],
      ["mkfs /dev/sda1", "bare mkfs"],
      ["dd if=/dev/zero of=/dev/sda", "dd of=/dev"],
      ["dd of=/dev/sda", "dd of=/dev without if"],
      ["shutdown", "shutdown"],
      ["reboot", "reboot"],
      ["halt", "halt"],
      ["poweroff", "poweroff"],
      ["init 0", "init 0"],
      ["sudo reboot", "sudo reboot"],
      ["echo done && rm -rf /etc", "rm in && chain"],
      ["true || chmod -R 777 /usr", "chmod in || chain"],
      ["echo hi | rm -rf /etc", "rm in pipeline"],
      ["cd /tmp && mkfs.ext4 /dev/sda1", "mkfs in && chain"],
      ["rm -rf $HOME", "rm -rf $HOME"],
      ["rm -rf ${HOME}", "rm -rf ${HOME}"],
      ["chmod 777 $VAR", "chmod $VAR"],
      ["xargs rm -rf /", "xargs rm -rf root"],
      ["xargs -r rm -rf /etc", "xargs rm protected"],
      ["xargs -0 rm -rf /usr", "xargs -0 rm protected"],
      ["xargs -n 2 chmod 777 /usr", "xargs chmod protected"],
      ["xargs -I {} chown root /etc", "xargs chown protected"],
      ["sudo xargs rm -rf /etc", "sudo xargs rm protected"],
      ["timeout 10 rm -rf /etc", "timeout rm protected"],
      ["timeout 5 mkfs.ext4 /dev/sda1", "timeout mkfs"],
      ["sudo timeout 10 rm -rf /etc", "sudo timeout rm protected"],
    ] as const;

    const ALLOWED = [
      ["rm -rf ./node_modules", "rm -rf local dir"],
      ["rm file.txt", "rm single file"],
      ["rm -rf /home/user/project/build", "rm -rf deep user path"],
      ["chmod 755 script.sh", "chmod single file"],
      ["chmod +x build.sh", "chmod +x file"],
      ["chown user file.txt", "chown single file"],
      ['echo "shutdown"', "echo with shutdown string"],
      ['echo "mkfs.ext4 /dev/sda1"', "echo with mkfs string"],
      ['echo "dd if=/dev/zero"', "echo with dd string"],
      ["grep mkfs /proc/filesystems", "grep mkfs"],
      ["cd dir && ls", "safe compound command"],
    ] as const;

    for (const [cmd, label] of BLOCKED) {
      it(`blocks ${label}: ${cmd}`, () => {
        assert.equal(parseCommand(cmd).catastrophic, true);
      });
    }

    for (const [cmd, label] of ALLOWED) {
      it(`allows ${label}: ${cmd}`, () => {
        assert.equal(parseCommand(cmd).catastrophic, false);
      });
    }
  });
});

describe("isEditLikeBashCommand", () => {
  // Helper to parse then check
  function isEditLike(cmd: string): boolean {
    return isEditLikeBashCommand(cmd, parseCommand(cmd));
  }

  describe("heredoc + redirect (parser gap fix)", () => {
    const EDIT_LIKE = [
      ["cat <<EOF > file.txt\nhello\nEOF", "heredoc with > redirect"],
      ["cat <<EOF >> file.txt\nhello\nEOF", "heredoc with >> redirect"],
      ["cat <<EOF | tee file.txt\nhello\nEOF", "heredoc piped to tee"],
      ["cat <<EOF | dd of=file.txt\nhello\nEOF", "heredoc piped to dd"],
    ] as const;

    for (const [cmd, label] of EDIT_LIKE) {
      it(`detects ${label}`, () => {
        assert.equal(isEditLike(cmd), true);
      });
    }
  });

  describe("output redirects", () => {
    const EDIT_LIKE = [
      ["echo hello > file.txt", "echo with redirect"],
      ["cat file.txt > new.txt", "cat with redirect"],
      ["grep pattern file.txt > out.txt", "grep with redirect"],
      ["echo hello >> file.txt", "echo with append redirect"],
      ["sort file.txt > sorted.txt", "sort with redirect"],
      ["awk '{print}' file.txt > out.txt", "awk with redirect"],
      ["exec 3> file.txt", "exec with fd redirect"],
    ] as const;

    for (const [cmd, label] of EDIT_LIKE) {
      it(`detects ${label}`, () => {
        assert.equal(isEditLike(cmd), true);
      });
    }
  });

  describe("in-place edit flags", () => {
    const EDIT_LIKE = [
      ["sed -i s/foo/bar/ file.txt", "sed -i"],
      ["sed -i.bak s/foo/bar/ file.txt", "sed -i.bak"],
      ["sed --in-place s/foo/bar/ file.txt", "sed --in-place"],
      ["perl -pi -e s/foo/bar/ file.txt", "perl -pi"],
      ["perl -pe 's/foo/bar/' file.txt", "perl -pe"],
    ] as const;

    for (const [cmd, label] of EDIT_LIKE) {
      it(`detects ${label}`, () => {
        assert.equal(isEditLike(cmd), true);
      });
    }
  });

  describe("write-purpose commands", () => {
    const EDIT_LIKE = [
      ["tee file.txt", "tee with file arg"],
      ["tee file.txt <<< hello", "tee with here-string"],
      ["truncate -s 0 file.txt", "truncate"],
      ["install -m 644 src dst", "install"],
    ] as const;

    for (const [cmd, label] of EDIT_LIKE) {
      it(`detects ${label}`, () => {
        assert.equal(isEditLike(cmd), true);
      });
    }
  });

  describe("interpreter one-liners", () => {
    const EDIT_LIKE = [
      ["python3 -c \"open('f','w').write('hi')\"", "python3 -c"],
      ["python -c \"print('hello')\"", "python -c"],
      ["node -e \"require('fs').writeFileSync('f','hi')\"", "node -e"],
      ["ruby -e \"File.write('f','hi')\"", "ruby -e"],
      ["perl -e 'print hi'", "perl -e"],
      ["php -r 'echo hi;'", "php -r"],
      ["sh -c 'echo hello > file.txt'", "sh -c"],
      ["bash -c 'echo hello > file.txt'", "bash -c"],
    ] as const;

    for (const [cmd, label] of EDIT_LIKE) {
      it(`detects ${label}`, () => {
        assert.equal(isEditLike(cmd), true);
      });
    }
  });

  describe("pure read-only commands (should NOT be edit-like)", () => {
    const READ_ONLY = [
      ["cat file.txt", "cat (no redirect)"],
      ["ls -la", "ls"],
      ["grep pattern file.txt", "grep (no redirect)"],
      ["find . -name '*.ts'", "find"],
      ["git status", "git status"],
      ["git log --oneline -5", "git log"],
      ["echo hello", "echo (no redirect)"],
      ["sed -n 5p file.txt", "sed -n (read-only)"],
      ["jq . file.json", "jq (no redirect)"],
      ["sort file.txt", "sort (no redirect)"],
      ["head -20 file.txt", "head (no redirect)"],
      ["wc -l file.txt", "wc (no redirect)"],
    ] as const;

    const SAFE_REDIRECT = [
      ["grep pattern file 2>/dev/null", "grep with stderr to /dev/null"],
      ["ls /some/path 2>/dev/null || ls", "ls with stderr to /dev/null and fallback"],
      ["cat file.txt > /dev/null", "cat redirecting stdout to /dev/null"],
      ["cmd &> /dev/null", "cmd redirecting all output to /dev/null"],
      ["cmd >/dev/null 2>&1", "cmd with stdout and stderr to /dev/null"],
      ["cmd > /dev/zero", "cmd redirecting to /dev/zero"],
      ["cmd 2>/dev/urandom", "cmd redirecting stderr to /dev/urandom"],
    ] as const;

    for (const [cmd, label] of READ_ONLY) {
      it(`allows ${label}`, () => {
        assert.equal(isEditLike(cmd), false);
      });
    }

    for (const [cmd, label] of SAFE_REDIRECT) {
      it(`allows ${label} (safe device redirect)`, () => {
        assert.equal(isEditLike(cmd), false);
      });
    }
  });
});

describe("tree-sitter port regressions", () => {
  it("treats env-assignment prefixes as the effective command (catastrophic)", () => {
    assert.equal(parseCommand("A=1 rm -rf /etc").catastrophic, true);
    assert.equal(parseCommand("FOO=bar chmod 777 /usr").catastrophic, true);
  });

  it("keeps the effective command first after an env-assignment prefix", () => {
    assert.deepEqual(parseCommand("A=1 echo hi").subcommands, ["echo hi"]);
    assert.equal(parseCommand("A=1 echo hi").subcommandWords[0]![0], "echo");
  });

  it("detects edit-like commands behind env-assignment prefixes", () => {
    assert.equal(isEditLikeBashCommand("FOO=bar sed -i f", parseCommand("FOO=bar sed -i f")), true);
    assert.equal(isEditLikeBashCommand("FOO=bar node -e x", parseCommand("FOO=bar node -e x")), true);
    assert.equal(isEditLikeBashCommand("FOO=x tee f", parseCommand("FOO=x tee f")), true);
  });

  it("does not strip backslashes before ordinary chars in double quotes", () => {
    assert.deepEqual(parseCommand('echo "a\\qb"').subcommands, ["echo a\\qb"]);
  });

  it("still unescapes double-quoted $ and quotes", () => {
    assert.equal(parseCommand('echo "\\$HOME"').subcommands[0], "echo $HOME");
    assert.equal(parseCommand('echo "a\\"b"').subcommands[0], 'echo a"b');
  });

  it("keeps the here-string placeholder when a file redirect wraps the command", () => {
    assert.ok(parseCommand("cat <<< x > out").subcommands[0]!.includes("<<< '...'"));
  });

  it("keeps per-token subcommandWords for [ and [[ tests", () => {
    assert.deepEqual(parseCommand("[ -f package.json ]").subcommandWords[0], ["[", "-f", "package.json", "]"]);
    assert.deepEqual(parseCommand("[[ -f package.json ]]").subcommandWords[0], ["[[", "-f", "package.json", "]]"]);
  });

  it("reports parseFailed:false for ordinary commands", () => {
    assert.equal(parseCommand("ls -la").parseFailed, false);
  });
});

describe("dangerous-command hardening", () => {
  const BLOCKED = [
    "env rm -rf /",
    "nice rm -rf /etc",
    "nohup chmod -R 777 /",
    "command rm -rf /",
    "setsid rm -rf /",
    "stdbuf -oL rm -rf /",
    "rm -rf /usr/",
    "rm -rf //usr",
    "rm -rf /usr/../etc",
    "rm -rf /var/*",
    "xargs --max-args 2 rm -rf /etc",
  ];
  for (const cmd of BLOCKED) {
    it(`blocks ${cmd}`, () => assert.equal(parseCommand(cmd).catastrophic, true));
  }

  it("does not over-block a glob inside a user dir", () => {
    assert.equal(parseCommand("rm -rf /home/user/project/build/*").catastrophic, false);
  });

  it("treats find -ok/-okdir as destructive exec", () => {
    assert.ok(parseCommand("find . -ok rm {} \\;").subcommands.includes("find:exec"));
    assert.ok(parseCommand("find . -okdir rm {} \\;").subcommands.includes("find:exec"));
  });

  const EDIT_LIKE = [
    "sed -Ei s/a/b/ f",
    "sed -ni p f",
    "sed --in-place=.bak s/a/b/ f",
    "perl -pie s/a/b/ f",
    "perl -i -e s/a/b/ f",
  ];
  for (const cmd of EDIT_LIKE) {
    it(`edit-like: ${cmd}`, () => assert.equal(isEditLikeBashCommand(cmd, parseCommand(cmd)), true));
  }

  it("does not treat a sed -e script as a flag", () => {
    assert.equal(isEditLikeBashCommand("sed -es/i/x/ f", parseCommand("sed -es/i/x/ f")), false);
  });

  it("forces ask for a dangerous verb with a quoted expansion", () => {
    assert.equal(parseCommand('rm -rf "$HOME"').forceAsk, true);
    assert.equal(parseCommand('chmod 777 "$VAR"').forceAsk, true);
    assert.equal(parseCommand('echo "$HOME"').forceAsk, false);
  });

  it("displays double-quoted strings with their original escapes", () => {
    assert.equal(parseCommand('echo "a\\"b"').displaySubcommands[0], 'echo "a\\"b"');
  });
});

// --- Existing isHazardousFile tests below ---

describe("isHazardousFile", () => {
  const HAZARDOUS = [
    [".env", ".env"],
    [".env.production", ".env.production"],
    [".env.local", ".env.local"],
    [".env.local.bak", ".env multi-extension"],
    [".env.production.backup", ".env multi-extension"],
    ["/project/.env", ".env with path prefix"],
    [".envrc", ".envrc"],
    [".npmrc", ".npmrc"],
    [".pypirc", ".pypirc"],
    [".netrc", ".netrc"],
    [".dockercfg", ".dockercfg"],
    ["id_rsa", "id_rsa"],
    ["id_ed25519", "id_ed25519"],
    ["id_ecdsa", "id_ecdsa"],
    ["server.pem", ".pem file"],
    ["credentials.json", "credentials.json"],
    ["credentials.yml", "credentials.yml"],
    ["credentials.yaml", "credentials.yaml"],
    ["secrets.json", "secrets.json"],
    ["secrets.yml", "secrets.yml"],
    ["secrets.yaml", "secrets.yaml"],
    ["config/credentials.yaml", "credentials with path prefix"],
    ["/home/user/.ssh/id_rsa", ".ssh directory"],
    ["/home/user/.gnupg/keyring.gpg", ".gnupg directory"],
    ["/home/user/.aws/credentials", ".aws/credentials"],
    ["/home/user/.docker/config.json", ".docker/config.json"],
  ] as const;

  const SAFE = [
    [".env.example", ".env.example"],
    [".env.sample", ".env.sample"],
    [".env.template", ".env.template"],
    [".sample.env", ".sample.env"],
    ["id_rsa.pub", "id_rsa.pub"],
    ["src/main.ts", "src/main.ts"],
    ["package.json", "package.json"],
  ] as const;

  for (const [path, label] of HAZARDOUS) {
    it(`flags ${label}`, () => {
      assert.equal(isHazardousFile(path), true);
    });
  }

  for (const [path, label] of SAFE) {
    it(`allows ${label}`, () => {
      assert.equal(isHazardousFile(path), false);
    });
  }
});

describe("displaySubcommands (quote preservation)", () => {
  const CASES: [string, string][] = [
    // The reported bug — quoted -g argument must keep its quotes in the UI.
    ['bun run test:e2e -- linkOperations.spec.ts -g "Can save a link with the UI"',
      'bun run test:e2e -- linkOperations.spec.ts -g "Can save a link with the UI"'],
    ['echo "hello world"', 'echo "hello world"'],
    ["echo 'hello world'", "echo 'hello world'"],
    ['cat "README.md"', 'cat "README.md"'],
    // empty quotes and inline-empty-quote shapes are preserved exactly
    ['echo ""', 'echo ""'],
    ["echo ''", "echo ''"],
    ['echo "" hello', 'echo "" hello'],
  ];
  for (const [input, expectedDisplay] of CASES) {
    it(`${input} → display ${JSON.stringify(expectedDisplay)}`, () => {
      const r = parseCommand(input);
      assert.equal(r.displaySubcommands.length, r.subcommands.length);
      assert.equal(r.displaySubcommands[0], expectedDisplay);
    });
  }

  it("opaque/long quoted content still collapses to '...' / \"...\" in display", () => {
    const longStr = "a".repeat(41);
    assert.equal(parseCommand(`echo '${longStr}'`).displaySubcommands[0], "echo '...'");
    assert.equal(parseCommand(`echo "${longStr}"`).displaySubcommands[0], 'echo "..."');
  });

  it("display parallels subcommands in length/order for pipelines", () => {
    const r = parseCommand('cat "a b" | grep "x y"');
    assert.equal(r.subcommands.length, 2);
    assert.equal(r.displaySubcommands.length, 2);
    assert.deepEqual(r.displaySubcommands, ['cat "a b"', 'grep "x y"']);
    // canonical form is still de-quoted (matching artifact)
    assert.deepEqual(r.subcommands, ['cat a b', 'grep x y']);
  });

  it("subcommandWords stays parallel to subcommands/displaySubcommands", () => {
    const r = parseCommand('echo "hello world"');
    assert.equal(r.subcommandWords.length, 1);
    assert.equal(r.subcommandWords[0]!.length, 2); // [echo, "hello world"]
  });
});

describe("isEditLikeBashCommand (token-aware)", () => {
  // Real flags as separate tokens are still edit-like.
  it("sed -i is edit-like", () => {
    assert.equal(isEditLikeBashCommand("sed -i file", parseCommand("sed -i file")), true);
  });
  it("sed -i.bak is edit-like", () => {
    assert.equal(isEditLikeBashCommand("sed -i.bak file", parseCommand("sed -i.bak file")), true);
  });
  it("sed --in-place is edit-like", () => {
    assert.equal(isEditLikeBashCommand("sed --in-place file", parseCommand("sed --in-place file")), true);
  });
  it("perl -pi is edit-like", () => {
    assert.equal(isEditLikeBashCommand("perl -pi -e 's/a/b/' file", parseCommand("perl -pi -e 's/a/b/' file")), true);
  });
  it("python3 -c is edit-like", () => {
    assert.equal(isEditLikeBashCommand('python3 -c "print(1)"', parseCommand('python3 -c "print(1)"')), true);
  });
  it("sh -c is edit-like", () => {
    assert.equal(isEditLikeBashCommand('sh -c "echo hi"', parseCommand('sh -c "echo hi"')), true);
  });
  it("tee is edit-like", () => {
    assert.equal(isEditLikeBashCommand("tee file", parseCommand("tee file")), true);
  });

  // The false-positive class: a quoted literal whose interior contains a
  // flag-like substring must NOT be edit-like (it is a single token).
  it("sed with a quoted literal containing '-i' is NOT edit-like", () => {
    assert.equal(isEditLikeBashCommand('sed "we are -i today" file', parseCommand('sed "we are -i today" file')), false);
  });
  it("python with a quoted literal containing '-c' is NOT edit-like", () => {
    assert.equal(isEditLikeBashCommand('python "running -c tests" f', parseCommand('python "running -c tests" f')), false);
  });
  it("sed -n (no -i) is NOT edit-like", () => {
    assert.equal(isEditLikeBashCommand("sed -n 's/a/b/p' file", parseCommand("sed -n 's/a/b/p' file")), false);
  });
});

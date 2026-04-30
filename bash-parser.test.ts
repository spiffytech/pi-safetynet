import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAllCommands,
  hasFileRedirects,
  isCatastrophicCommand,
  isHazardousFile,
} from "./bash-parser.ts";

describe("getAllCommands", () => {
  describe("simple commands", () => {
    it("extracts a single command name", () => {
      assert.deepEqual(getAllCommands("ls"), ["ls"]);
    });

    it("extracts command name ignoring arguments", () => {
      assert.deepEqual(getAllCommands("cat file.txt"), ["cat"]);
    });

    it("extracts command with flags", () => {
      assert.deepEqual(getAllCommands("ls -la /tmp"), ["ls"]);
    });

    it("extracts a bare command with no args", () => {
      assert.deepEqual(getAllCommands("pwd"), ["pwd"]);
    });

    it("extracts hostname command", () => {
      assert.deepEqual(getAllCommands("hostname"), ["hostname"]);
    });

    it("extracts hostname with flags", () => {
      assert.deepEqual(getAllCommands("hostname -I"), ["hostname"]);
    });
  });

  describe("pipes", () => {
    it("extracts commands from a pipeline", () => {
      assert.deepEqual(getAllCommands("ls | grep foo"), ["ls", "grep"]);
    });

    it("extracts commands from a triple pipeline", () => {
      assert.deepEqual(getAllCommands("cat a | sort | uniq"), ["cat", "sort", "uniq"]);
    });
  });

  describe("logical operators", () => {
    it("extracts commands from && chain", () => {
      assert.deepEqual(getAllCommands("cd dir && ls"), ["cd", "ls"]);
    });

    it("extracts commands from || chain", () => {
      assert.deepEqual(getAllCommands("cmd1 || cmd2"), ["cmd1", "cmd2"]);
    });

    it("extracts commands from mixed && and ||", () => {
      assert.deepEqual(getAllCommands("cmd1 && cmd2 || cmd3"), ["cmd1", "cmd2", "cmd3"]);
    });
  });

  describe("command substitution", () => {
    it("extracts command from $(...) in arguments", () => {
      const result = getAllCommands('echo "$(whoami)"');
      assert.ok(result.includes("echo"));
      assert.ok(result.includes("whoami"));
    });

    it("extracts command from variable assignment with $()", () => {
      const result = getAllCommands("x=$(date)");
      assert.ok(result.includes("date"));
    });
  });

  describe("process substitution", () => {
    it("extracts commands from <(...) process substitution", () => {
      const result = getAllCommands("diff <(sort a) <(sort b)");
      assert.ok(result.includes("diff"));
      assert.ok(result.includes("sort"));
    });
  });

  describe("subshells and blocks", () => {
    it("extracts commands from subshell", () => {
      const result = getAllCommands("(cd dir && ls)");
      assert.ok(result.includes("cd"));
      assert.ok(result.includes("ls"));
    });

    it("extracts commands from brace group", () => {
      const result = getAllCommands("{ cmd1; cmd2; }");
      assert.ok(result.includes("cmd1"));
      assert.ok(result.includes("cmd2"));
    });
  });

  describe("find -exec", () => {
    it("does not extract rm as standalone command from find -exec", () => {
      const result = getAllCommands('find . -name "*.ts" -exec rm {} \\;');
      assert.ok(!result.includes("rm"));
      assert.ok(result.some((c) => c.startsWith("find")));
    });

    it("does not extract ls as standalone command from find -execdir", () => {
      const result = getAllCommands('find . -execdir ls {} \\;');
      assert.ok(!result.includes("ls"));
      assert.ok(result.some((c) => c.startsWith("find")));
    });

    it("returns just find when no -exec", () => {
      assert.deepEqual(getAllCommands('find . -name "*.ts"'), ["find"]);
    });
  });

  describe("redirects produce >target entries", () => {
    it("extracts redirect target from >", () => {
      const result = getAllCommands("ls > out.txt");
      assert.ok(result.includes("ls"));
      assert.ok(result.some((c) => c.startsWith(">")));
    });

    it("extracts redirect target from >>", () => {
      const result = getAllCommands("echo hi >> log.txt");
      assert.ok(result.includes("echo"));
      assert.ok(result.some((c) => c.startsWith(">")));
    });
  });

  describe("deduplication", () => {
    it("deduplicates command names", () => {
      const result = getAllCommands("ls | ls");
      assert.deepEqual(result, ["ls"]);
    });
  });

  describe("parse errors", () => {
    it("falls back to first word on parse failure", () => {
      const result = getAllCommands("someunknowncmd");
      assert.deepEqual(result, ["someunknowncmd"]);
    });

    it("returns empty for empty input", () => {
      assert.deepEqual(getAllCommands(""), []);
    });

    it("returns empty for whitespace input", () => {
      assert.deepEqual(getAllCommands("   "), []);
    });
  });
});

describe("hasFileRedirects", () => {
  it("detects > redirect", () => {
    assert.equal(hasFileRedirects("ls > out.txt"), true);
  });

  it("detects >> redirect", () => {
    assert.equal(hasFileRedirects("echo hi >> log.txt"), true);
  });

  it("detects &> redirect", () => {
    assert.equal(hasFileRedirects("cmd &> out.txt"), true);
  });

  it("detects &>> redirect", () => {
    assert.equal(hasFileRedirects("cmd &>> out.txt"), true);
  });

  it("detects >| redirect", () => {
    assert.equal(hasFileRedirects("cmd >| out.txt"), true);
  });

  it("does not flag < as write redirect", () => {
    assert.equal(hasFileRedirects("cmd < input.txt"), false);
  });

  it("returns false for commands with no redirects", () => {
    assert.equal(hasFileRedirects("ls -la"), false);
  });

  it("returns false for pipes without redirects", () => {
    assert.equal(hasFileRedirects("ls | grep foo"), false);
  });

  it("detects redirects inside subshell", () => {
    assert.equal(hasFileRedirects("(echo hi > out.txt)"), true);
  });

  it("detects redirects in && chain", () => {
    assert.equal(hasFileRedirects("cmd1 && cmd2 > out.txt"), true);
  });
});

describe("isCatastrophicCommand", () => {
  it("blocks rm -rf /", () => {
    assert.equal(isCatastrophicCommand("rm -rf /"), true);
  });

  it("blocks rm -rf /*", () => {
    assert.equal(isCatastrophicCommand("rm -rf /*"), true);
  });

  it("blocks sudo rm -rf /*", () => {
    assert.equal(isCatastrophicCommand("sudo rm -rf /*"), true);
  });

  it("blocks rm -rf ~", () => {
    assert.equal(isCatastrophicCommand("rm -rf ~"), true);
  });

  it("blocks mkfs.ext4 /dev/sda1", () => {
    assert.equal(isCatastrophicCommand("mkfs.ext4 /dev/sda1"), true);
  });

  it("blocks dd if=/dev/zero of=/dev/sda", () => {
    assert.equal(isCatastrophicCommand("dd if=/dev/zero of=/dev/sda"), true);
  });

  it("blocks sudo rm -rf --no-preserve-root", () => {
    assert.equal(isCatastrophicCommand("sudo rm -rf --no-preserve-root /"), true);
  });

  it("allows rm -rf ./node_modules", () => {
    assert.equal(isCatastrophicCommand("rm -rf ./node_modules"), false);
  });

  it("allows rm file.txt", () => {
    assert.equal(isCatastrophicCommand("rm file.txt"), false);
  });

  it("allows rm -rf /home/user/project/build", () => {
    assert.equal(isCatastrophicCommand("rm -rf /home/user/project/build"), false);
  });
});

describe("isHazardousFile", () => {
  it("flags .env files", () => {
    assert.equal(isHazardousFile(".env"), true);
  });

  it("flags .env.production", () => {
    assert.equal(isHazardousFile(".env.production"), true);
  });

  it("flags .env.local", () => {
    assert.equal(isHazardousFile(".env.local"), true);
  });

  it("does NOT flag .env.example", () => {
    assert.equal(isHazardousFile(".env.example"), false);
  });

  it("does NOT flag .env.sample", () => {
    assert.equal(isHazardousFile(".env.sample"), false);
  });

  it("does NOT flag .env.template", () => {
    assert.equal(isHazardousFile(".env.template"), false);
  });

  it("does NOT flag .sample.env", () => {
    assert.equal(isHazardousFile(".sample.env"), false);
  });

  it("flags .ssh directory paths", () => {
    assert.equal(isHazardousFile("/home/user/.ssh/id_rsa"), true);
  });

  it("flags .gnupg directory paths", () => {
    assert.equal(isHazardousFile("/home/user/.gnupg/keyring.gpg"), true);
  });

  it("flags .aws/credentials", () => {
    assert.equal(isHazardousFile("/home/user/.aws/credentials"), true);
  });

  it("does NOT flag src/main.ts", () => {
    assert.equal(isHazardousFile("src/main.ts"), false);
  });

  it("does NOT flag package.json", () => {
    assert.equal(isHazardousFile("package.json"), false);
  });

  it("flags .env with path prefix", () => {
    assert.equal(isHazardousFile("/project/.env"), true);
  });

  it("does NOT flag .envrc", () => {
    assert.equal(isHazardousFile(".envrc"), false);
  });
});

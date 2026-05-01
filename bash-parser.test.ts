import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAllCommands,
  hasFileRedirects,
  isCatastrophicCommand,
  isHazardousFile,
  getRedirectTargets,
} from "./bash-parser.ts";

describe("getAllCommands", () => {
  describe("simple commands", () => {
    it("extracts a single command with no args", () => {
      assert.deepEqual(getAllCommands("pwd"), ["pwd"]);
    });

    it("extracts command with arguments", () => {
      assert.deepEqual(getAllCommands("cat file.txt"), ["cat file.txt"]);
    });

    it("extracts command with flags", () => {
      assert.deepEqual(getAllCommands("ls -la /tmp"), ["ls -la /tmp"]);
    });

    it("extracts hostname with no args", () => {
      assert.deepEqual(getAllCommands("hostname"), ["hostname"]);
    });

    it("extracts hostname with flags", () => {
      assert.deepEqual(getAllCommands("hostname -I"), ["hostname -I"]);
    });

    it("extracts git with subcommand", () => {
      assert.deepEqual(getAllCommands("git status"), ["git status"]);
    });

    it("extracts git with subcommand and flags", () => {
      assert.deepEqual(getAllCommands("git status --short"), ["git status --short"]);
    });

    it("extracts npm with subcommand", () => {
      assert.deepEqual(getAllCommands("npm list"), ["npm list"]);
    });

    it("extracts sed with flag pattern", () => {
      assert.deepEqual(getAllCommands("sed -n 1p file"), ["sed -n 1p file"]);
    });

    it("extracts git config --get", () => {
      assert.deepEqual(getAllCommands("git config --get user.name"), ["git config --get user.name"]);
    });
  });

  describe("double-quoted strings (quoting bypass fix)", () => {
    it("preserves literal content of double-quoted strings", () => {
      const result = getAllCommands('cat "README.md"');
      assert.deepEqual(result, ["cat README.md"]);
    });

    it("preserves literal content with spaces", () => {
      const result = getAllCommands('echo "hello world"');
      assert.deepEqual(result, ["echo hello world"]);
    });

    it("keeps placeholder for variable expansions in double quotes", () => {
      const result = getAllCommands('echo "$HOME"');
      assert.ok(result[0]!.includes('"..."'));
    });

    it("keeps placeholder for command substitutions in double quotes", () => {
      const result = getAllCommands('echo "$(whoami)"');
      assert.ok(result[0]!.includes('"..."'));
    });

    it("preserves single-quoted strings", () => {
      const result = getAllCommands("echo 'hello world'");
      assert.deepEqual(result, ["echo hello world"]);
    });
  });

  describe("pipes", () => {
    it("extracts commands from a pipeline", () => {
      assert.deepEqual(getAllCommands("ls | grep foo"), ["ls", "grep foo"]);
    });

    it("extracts commands from a triple pipeline", () => {
      assert.deepEqual(getAllCommands("cat a | sort | uniq"), ["cat a", "sort", "uniq"]);
    });
  });

  describe("logical operators", () => {
    it("extracts commands from && chain", () => {
      assert.deepEqual(getAllCommands("cd dir && ls"), ["cd dir", "ls"]);
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
      assert.ok(result.some((c) => c.startsWith("echo")));
      assert.ok(result.some((c) => c === "whoami"));
    });

    it("extracts command from variable assignment with $()", () => {
      const result = getAllCommands("x=$(date)");
      assert.ok(result.includes("date"));
    });
  });

  describe("process substitution", () => {
    it("extracts commands from <(...) process substitution", () => {
      const result = getAllCommands("diff <(sort a) <(sort b)");
      assert.ok(result.some((c) => c.startsWith("diff")));
      assert.ok(result.includes("sort a"));
    });
  });

  describe("subshells and blocks", () => {
    it("extracts commands from subshell", () => {
      const result = getAllCommands("(cd dir && ls)");
      assert.ok(result.some((c) => c === "cd dir"));
      assert.ok(result.includes("ls"));
    });

    it("extracts commands from brace group", () => {
      const result = getAllCommands("{ cmd1; cmd2; }");
      assert.ok(result.includes("cmd1"));
      assert.ok(result.includes("cmd2"));
    });
  });

  describe("find -exec/-delete", () => {
    it("emits find:exec for find -exec", () => {
      const result = getAllCommands('find . -name "*.ts" -exec rm {} \\;');
      assert.ok(result.includes("find:exec"));
      assert.ok(!result.some((c) => c.startsWith("find .") && c !== "find:exec"));
    });

    it("emits find:exec for find -execdir", () => {
      const result = getAllCommands('find . -execdir ls {} \\;');
      assert.ok(result.includes("find:exec"));
    });

    it("emits find:delete for find -delete", () => {
      const result = getAllCommands("find . -delete");
      assert.deepEqual(result, ["find:delete"]);
    });

    it("detects -delete regardless of position", () => {
      const result = getAllCommands('find . -delete -name "*.ts"');
      assert.deepEqual(result, ["find:delete"]);
    });

    it("returns plain find when no -exec or -delete", () => {
      const result = getAllCommands('find . -name "*.ts"');
      assert.ok(result.length === 1);
      assert.ok(result[0]!.startsWith("find ."));
    });
  });

  describe("sudo", () => {
    it("extracts sudo + underlying command", () => {
      const result = getAllCommands("sudo rm file");
      assert.ok(result.some((c) => c === "sudo rm file"));
    });

    it("extracts sudo apt install", () => {
      const result = getAllCommands("sudo apt install foo");
      assert.ok(result.some((c) => c === "sudo apt install foo"));
    });
  });

  describe("redirects produce only command string (targets via getRedirectTargets)", () => {
    it("extracts command without redirect target", () => {
      const result = getAllCommands("ls > out.txt");
      assert.deepEqual(result, ["ls"]);
    });

    it("extracts command without append redirect target", () => {
      const result = getAllCommands("echo hi >> log.txt");
      assert.ok(result.some((c) => c.startsWith("echo")));
      assert.ok(!result.some((c) => c.startsWith(">")));
    });
  });

  describe("deduplication", () => {
    it("deduplicates command strings", () => {
      const result = getAllCommands("ls | ls");
      assert.deepEqual(result, ["ls"]);
    });
  });

  describe("parse errors", () => {
    it("falls back to full command on parse failure", () => {
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

describe("getRedirectTargets", () => {
  it("extracts output target from >", () => {
    assert.deepEqual(getRedirectTargets("ls > out.txt"), [{ path: "out.txt", direction: "output" }]);
  });

  it("extracts output target from >>", () => {
    assert.deepEqual(getRedirectTargets("echo hi >> log.txt"), [{ path: "log.txt", direction: "output" }]);
  });

  it("extracts output target from &>", () => {
    assert.deepEqual(getRedirectTargets("cmd &> all.txt"), [{ path: "all.txt", direction: "output" }]);
  });

  it("extracts output target from >|", () => {
    assert.deepEqual(getRedirectTargets("cmd >| force.txt"), [{ path: "force.txt", direction: "output" }]);
  });

  it("extracts input target from <", () => {
    assert.deepEqual(getRedirectTargets("sort < data.txt"), [{ path: "data.txt", direction: "input" }]);
  });

  it("returns empty for commands with no redirects", () => {
    assert.deepEqual(getRedirectTargets("ls -la"), []);
  });

  it("returns empty for pipes without redirects", () => {
    assert.deepEqual(getRedirectTargets("ls | grep foo"), []);
  });

  it("extracts multiple redirect targets", () => {
    const result = getRedirectTargets("cmd > out.txt 2>> err.txt");
    assert.ok(result.some((t) => t.path === "out.txt" && t.direction === "output"));
    assert.ok(result.some((t) => t.path === "err.txt" && t.direction === "output"));
  });

  it("resolves double-quoted redirect targets", () => {
    assert.deepEqual(getRedirectTargets('echo hi > ".env"'), [{ path: ".env", direction: "output" }]);
  });

  it("resolves double-quoted external path redirect targets", () => {
    assert.deepEqual(getRedirectTargets('echo hi > "/etc/passwd"'), [{ path: "/etc/passwd", direction: "output" }]);
  });

  it("identifies input redirect with hazardous file", () => {
    const result = getRedirectTargets("sort < .env");
    assert.equal(result.length, 1);
    assert.equal(result[0]!.path, ".env");
    assert.equal(result[0]!.direction, "input");
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

  it("flags < as input redirect", () => {
    assert.equal(hasFileRedirects("cmd < input.txt"), true);
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
  describe("rm: no argument may be a protected directory", () => {
    it("blocks rm -rf /", () => {
      assert.equal(isCatastrophicCommand("rm -rf /"), true);
    });

    it("blocks rm -fr /", () => {
      assert.equal(isCatastrophicCommand("rm -fr /"), true);
    });

    it("blocks rm -rf /usr", () => {
      assert.equal(isCatastrophicCommand("rm -rf /usr"), true);
    });

    it("blocks rm -rf /usr/local", () => {
      assert.equal(isCatastrophicCommand("rm -rf /usr/local"), true);
    });

    it("blocks rm -rf /etc", () => {
      assert.equal(isCatastrophicCommand("rm -rf /etc"), true);
    });

    it("blocks rm -rf /home", () => {
      assert.equal(isCatastrophicCommand("rm -rf /home"), true);
    });

    it("blocks rm -rf /var", () => {
      assert.equal(isCatastrophicCommand("rm -rf /var"), true);
    });

    it("blocks rm -rf /opt", () => {
      assert.equal(isCatastrophicCommand("rm -rf /opt"), true);
    });

    it("blocks rm -rf /tmp", () => {
      assert.equal(isCatastrophicCommand("rm -rf /tmp"), true);
    });

    it("blocks rm with buried protected arg", () => {
      assert.equal(isCatastrophicCommand("rm -rf /etc /var ./node_modules"), true);
    });

    it("blocks rm -rf / --no-preserve-root", () => {
      assert.equal(isCatastrophicCommand("rm -rf / --no-preserve-root"), true);
    });

    it("blocks sudo rm -rf /etc", () => {
      assert.equal(isCatastrophicCommand("sudo rm -rf /etc"), true);
    });

    it("blocks sudo rm -rf /home", () => {
      assert.equal(isCatastrophicCommand("sudo rm -rf /home"), true);
    });

    it("blocks rm -rf /*", () => {
      assert.equal(isCatastrophicCommand("rm -rf /*"), true);
    });

    it("blocks rm -rf ~", () => {
      assert.equal(isCatastrophicCommand("rm -rf ~"), true);
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

  describe("quoting bypass: double-quoted protected dirs are caught", () => {
    it('blocks rm "/etc"', () => {
      assert.equal(isCatastrophicCommand('rm "/etc"'), true);
    });

    it('blocks rm "/usr"', () => {
      assert.equal(isCatastrophicCommand('rm "/usr"'), true);
    });

    it('blocks sudo rm "/etc"', () => {
      assert.equal(isCatastrophicCommand('sudo rm "/etc"'), true);
    });

    it("blocks sudo -u root rm /etc (flags before command)", () => {
      assert.equal(isCatastrophicCommand("sudo -u root rm /etc"), true);
    });

    it("blocks sudo -E chmod 777 /usr (flags before command)", () => {
      assert.equal(isCatastrophicCommand("sudo -E chmod 777 /usr"), true);
    });
  });

  describe("chmod: no argument may be a protected directory", () => {
    it("blocks chmod -R 777 /", () => {
      assert.equal(isCatastrophicCommand("chmod -R 777 /"), true);
    });

    it("blocks chmod 777 /usr", () => {
      assert.equal(isCatastrophicCommand("chmod 777 /usr"), true);
    });

    it("blocks chmod -R 755 /etc", () => {
      assert.equal(isCatastrophicCommand("chmod -R 755 /etc"), true);
    });

    it("blocks sudo chmod 777 /usr", () => {
      assert.equal(isCatastrophicCommand("sudo chmod 777 /usr"), true);
    });

    it("allows chmod 755 script.sh", () => {
      assert.equal(isCatastrophicCommand("chmod 755 script.sh"), false);
    });

    it("allows chmod +x build.sh", () => {
      assert.equal(isCatastrophicCommand("chmod +x build.sh"), false);
    });
  });

  describe("chown: no argument may be a protected directory", () => {
    it("blocks chown root /etc", () => {
      assert.equal(isCatastrophicCommand("chown root /etc"), true);
    });

    it("blocks chown -R root:root /usr", () => {
      assert.equal(isCatastrophicCommand("chown -R root:root /usr"), true);
    });

    it("blocks sudo chown root /tmp", () => {
      assert.equal(isCatastrophicCommand("sudo chown root /tmp"), true);
    });

    it("allows chown user file.txt", () => {
      assert.equal(isCatastrophicCommand("chown user file.txt"), false);
    });
  });

  describe("other catastrophic patterns", () => {
    it("blocks mkfs.ext4 /dev/sda1", () => {
      assert.equal(isCatastrophicCommand("mkfs.ext4 /dev/sda1"), true);
    });

    it("blocks mkfs -t ext4 /dev/sda1", () => {
      assert.equal(isCatastrophicCommand("mkfs -t ext4 /dev/sda1"), true);
    });

    it("blocks bare mkfs /dev/sda1", () => {
      assert.equal(isCatastrophicCommand("mkfs /dev/sda1"), true);
    });

    it("blocks dd if=/dev/zero of=/dev/sda", () => {
      assert.equal(isCatastrophicCommand("dd if=/dev/zero of=/dev/sda"), true);
    });

    it("blocks dd of=/dev/sda without if=", () => {
      assert.equal(isCatastrophicCommand("dd of=/dev/sda"), true);
    });

    it("blocks shutdown", () => {
      assert.equal(isCatastrophicCommand("shutdown"), true);
    });

    it("blocks reboot", () => {
      assert.equal(isCatastrophicCommand("reboot"), true);
    });

    it("blocks halt", () => {
      assert.equal(isCatastrophicCommand("halt"), true);
    });

    it("blocks poweroff", () => {
      assert.equal(isCatastrophicCommand("poweroff"), true);
    });

    it("blocks init 0", () => {
      assert.equal(isCatastrophicCommand("init 0"), true);
    });

    it("blocks sudo reboot", () => {
      assert.equal(isCatastrophicCommand("sudo reboot"), true);
    });

    it("blocks shutdown in && chain", () => {
      assert.equal(isCatastrophicCommand("echo bye && shutdown"), true);
    });

    it("does NOT flag echo shutdown", () => {
      assert.equal(isCatastrophicCommand('echo "shutdown"'), false);
    });

    it("does NOT flag echo with mkfs in argument", () => {
      assert.equal(isCatastrophicCommand('echo "mkfs.ext4 /dev/sda1"'), false);
    });

    it("does NOT flag echo with dd in argument", () => {
      assert.equal(isCatastrophicCommand('echo "dd if=/dev/zero"'), false);
    });

    it("does NOT flag grep mkfs", () => {
      assert.equal(isCatastrophicCommand("grep mkfs /proc/filesystems"), false);
    });
  });

  describe("compound commands: catastrophic check covers all subcommands", () => {
    it("blocks rm in && chain", () => {
      assert.equal(isCatastrophicCommand("echo done && rm -rf /etc"), true);
    });

    it("blocks chmod in || chain", () => {
      assert.equal(isCatastrophicCommand("true || chmod -R 777 /usr"), true);
    });

    it("blocks rm in pipeline", () => {
      assert.equal(isCatastrophicCommand("echo hi | rm -rf /etc"), true);
    });

    it("blocks mkfs in && chain", () => {
      assert.equal(isCatastrophicCommand("cd /tmp && mkfs.ext4 /dev/sda1"), true);
    });

    it("allows safe compound commands", () => {
      assert.equal(isCatastrophicCommand("cd dir && ls"), false);
    });
  });

  describe("variable expansion in args", () => {
    it("blocks rm -rf $HOME", () => {
      assert.equal(isCatastrophicCommand("rm -rf $HOME"), true);
    });

    it("blocks rm -rf ${HOME}", () => {
      assert.equal(isCatastrophicCommand("rm -rf ${HOME}"), true);
    });

    it("blocks chmod 777 $VAR", () => {
      assert.equal(isCatastrophicCommand("chmod 777 $VAR"), true);
    });

    it("allows rm without variable args", () => {
      assert.equal(isCatastrophicCommand("rm -rf ./build"), false);
    });
  });
});

describe("isHazardousFile", () => {
  describe(".env variants", () => {
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

    it("flags .env.local.bak (multi-extension)", () => {
      assert.equal(isHazardousFile(".env.local.bak"), true);
    });

    it("flags .env.production.backup (multi-extension)", () => {
      assert.equal(isHazardousFile(".env.production.backup"), true);
    });

    it("flags .env with path prefix", () => {
      assert.equal(isHazardousFile("/project/.env"), true);
    });
  });

  describe("config files with credentials", () => {
    it("flags .envrc", () => {
      assert.equal(isHazardousFile(".envrc"), true);
    });

    it("flags .npmrc", () => {
      assert.equal(isHazardousFile(".npmrc"), true);
    });

    it("flags .pypirc", () => {
      assert.equal(isHazardousFile(".pypirc"), true);
    });

    it("flags .netrc", () => {
      assert.equal(isHazardousFile(".netrc"), true);
    });

    it("flags .dockercfg", () => {
      assert.equal(isHazardousFile(".dockercfg"), true);
    });
  });

  describe("SSH keys and certificates", () => {
    it("flags id_rsa", () => {
      assert.equal(isHazardousFile("id_rsa"), true);
    });

    it("flags id_ed25519", () => {
      assert.equal(isHazardousFile("id_ed25519"), true);
    });

    it("flags id_ecdsa", () => {
      assert.equal(isHazardousFile("id_ecdsa"), true);
    });

    it("does NOT flag id_rsa.pub", () => {
      assert.equal(isHazardousFile("id_rsa.pub"), false);
    });

    it("flags .pem files", () => {
      assert.equal(isHazardousFile("server.pem"), true);
    });
  });

  describe("credentials and secrets files", () => {
    it("flags credentials.json", () => {
      assert.equal(isHazardousFile("credentials.json"), true);
    });

    it("flags credentials.yml", () => {
      assert.equal(isHazardousFile("credentials.yml"), true);
    });

    it("flags credentials.yaml", () => {
      assert.equal(isHazardousFile("credentials.yaml"), true);
    });

    it("flags secrets.json", () => {
      assert.equal(isHazardousFile("secrets.json"), true);
    });

    it("flags secrets.yml", () => {
      assert.equal(isHazardousFile("secrets.yml"), true);
    });

    it("flags secrets.yaml", () => {
      assert.equal(isHazardousFile("secrets.yaml"), true);
    });

    it("flags credentials with path prefix", () => {
      assert.equal(isHazardousFile("config/credentials.yaml"), true);
    });
  });

  describe("directory-based patterns", () => {
    it("flags .ssh directory paths", () => {
      assert.equal(isHazardousFile("/home/user/.ssh/id_rsa"), true);
    });

    it("flags .gnupg directory paths", () => {
      assert.equal(isHazardousFile("/home/user/.gnupg/keyring.gpg"), true);
    });

    it("flags .aws/credentials", () => {
      assert.equal(isHazardousFile("/home/user/.aws/credentials"), true);
    });

    it("flags .docker/config.json", () => {
      assert.equal(isHazardousFile("/home/user/.docker/config.json"), true);
    });
  });

  describe("non-hazardous files", () => {
    it("does NOT flag src/main.ts", () => {
      assert.equal(isHazardousFile("src/main.ts"), false);
    });

    it("does NOT flag package.json", () => {
      assert.equal(isHazardousFile("package.json"), false);
    });
  });
});

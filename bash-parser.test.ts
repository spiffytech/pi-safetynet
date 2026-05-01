import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, isHazardousFile } from "./bash-parser.ts";

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

    it("extracts sudo + underlying command", () => {
      assert.ok(parseCommand("sudo rm file").subcommands.some((c) => c === "sudo rm file"));
    });

    it("extracts sudo apt install", () => {
      assert.ok(parseCommand("sudo apt install foo").subcommands.some((c) => c === "sudo apt install foo"));
    });

    it("extracts command without append redirect target", () => {
      const r = parseCommand("echo hi >> log.txt").subcommands;
      assert.ok(r.some((c) => c.startsWith("echo")));
      assert.ok(!r.some((c) => c.startsWith(">")));
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

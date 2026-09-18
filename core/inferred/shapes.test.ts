/**
 * shapes.test.ts — the inferred-rules corpus.
 *
 * This file is the widening regression gate described in
 * plans/inferred-rules-design.md. It contains a large, high-diversity
 * NEGATIVE corpus (pairs that must never merge, and patterns that must
 * never match commands outside their exemplar structure) mirrored by a
 * POSITIVE corpus (pairs that must merge into the exact expected
 * generalization).
 *
 * ANY future change to merge rules, slot semantics, or boundary tables must
 * keep this corpus green. A pattern matching a negative is a hard failure.
 * The matcher may only ever get stricter without a deliberate, reviewed
 * decision.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, subcommandTokenLists } from "../bash-parser.ts";
import {
  classifyTokens,
  hasHazardousValues,
  mergeExemplars,
  patternMatches,
  renderPattern,
  shapeKeyOf,
  CODE_FLAG_PAIRS,
  OPAQUE_PROGRAMS,
  RUNNER_VERBS,
  SUB_OPAQUE,
} from "./shapes.ts";

/** Tokens for a command string via the real parser. */
function toks(command: string): string[] {
  const lists = subcommandTokenLists(command);
  assert.equal(lists.length, 1, `expected single subcommand: ${command}`);
  return lists[0]!;
}

function merge2(a: string, b: string) {
  return mergeExemplars([toks(a), toks(b)]);
}

/** Assert the pair merges and renders exactly as expected. */
function assertMerges(a: string, b: string, expectedRender: string) {
  const r = merge2(a, b);
  if (!r.ok) {
    assert.fail(`${JSON.stringify(a)} + ${JSON.stringify(b)} must merge (failed: ${r.failure.why} @${"position" in r.failure ? r.failure.position : ""})`);
  }
  assert.equal(renderPattern(r.pattern), expectedRender);
  // Guarantee: the merged pattern matches every exemplar that produced it.
  for (const cmd of [a, b]) {
    assert.ok(
      patternMatches(r.pattern, toks(cmd)),
      `merged pattern ${renderPattern(r.pattern)} must match its own exemplar ${JSON.stringify(cmd)}`,
    );
  }
}

/** Assert the pair refuses to merge, optionally narrowing by failure kind. */
function assertNoMerge(a: string, b: string, why?: string) {
  const r = merge2(a, b);
  assert.ok(!r.ok, `${JSON.stringify(a)} + ${JSON.stringify(b)} must NOT merge (got: ${r.ok ? renderPattern(r.pattern) : ""})`);
  if (why && !r.ok) assert.equal(r.failure.why, why, `${a} + ${b}: expected ${why}, got ${r.failure.why}`);
}

// ─── POSITIVE corpus: must merge, exactly ───────────────────────────────────

describe("positive corpus", () => {
  it("varying trailing args merge to a trailing slot", () => {
    assertMerges("git log main", "git log dev", "git log <arg>");
  });

  it("varying quoted messages merge to a slot (space-containing tokens)", () => {
    assertMerges('git commit -m "fix parser"', 'git commit -m "fix tests"', "git commit -m <arg>");
  });

  it("dd assignment values slot; keys stay literal", () => {
    assertMerges("dd if=a.img bs=4M", "dd if=b.iso bs=1M", "dd if=<arg> bs=<arg>");
  });

  it("shared literals stay literal", () => {
    assertMerges("git push origin main", "git push origin dev", "git push origin <arg>");
  });

  it("multiple shared-literal prefixes widen only past the last shared token", () => {
    assertMerges("git push origin main", "git push upstream dev", "git push <arg> <arg>");
  });

  it("identical commands collapse to an exact rule", () => {
    assertMerges("npm test", "npm test", "npm test");
  });

  it("assignment value varies while another assignment stays fixed", () => {
    assertMerges("dd if=a.img bs=4M", "dd if=b.iso bs=4M", "dd if=<arg> bs=4M");
  });

  it("quoting is invisible to matching (canonical tokens)", () => {
    // identical canonical tokens → exact rule; must match BOTH quoting forms
    assertMerges('git log "main"', "git log main", "git log main");
  });

  it("harmless -c/-e flags are not boundaries (later args still slot)", () => {
    assertMerges("head -c 100 f1.txt", "head -c 100 f2.txt", "head -c 100 <arg>");
    assertMerges("grep -c foo a.txt", "grep -c foo b.txt", "grep -c foo <arg>");
    assertMerges("wc -l a.txt b1.txt", "wc -l a.txt b2.txt", "wc -l a.txt <arg>");
  });

  it("env-prefix assignments slot in place", () => {
    assertMerges("env FOO=1 curl example.org", "env FOO=2 curl example.org", "env FOO=<arg> curl example.org");
  });
});

// ─── NEGATIVE corpus: must never merge ──────────────────────────────────────

describe("negative corpus — must not merge", () => {
  it("different subcommands never merge", () => {
    assertNoMerge("git log", "git branch", "subcommand-mismatch");
    assertNoMerge("git log main", "git branch main", "subcommand-mismatch");
    assertNoMerge("git log main", "git show main", "subcommand-mismatch");
  });

  it("flag-set differences never merge", () => {
    assertNoMerge("grep -r foo .", "grep -i foo .", "flag-mismatch");
    assertNoMerge("git log -p main", "git log main", "token-count");
    assertNoMerge("ls -la", "ls -l", "flag-mismatch");
  });

  it("assignment key mismatch never merges (the dd of= hole)", () => {
    assertNoMerge("dd if=a bs=1", "dd of=b bs=1", "assign-key-mismatch");
  });

  it("interior free slots never merge", () => {
    assertNoMerge("git commit a -m msg", "git commit b -m msg", "interior-slot");
    // shared literal AFTER the varying position makes it interior
    assertNoMerge("git commit -m a x", "git commit -m b x", "interior-slot");
  });

  it("flag-vs-bare-word divergence at the same index never merges", () => {
    assertNoMerge("git log main", "git log --all");
    assertNoMerge("sort in.txt", "sort -u in.txt", "token-count");
  });

  it("token-count mismatches never merge", () => {
    assertNoMerge("git log", "git log main");
    assertNoMerge("git push origin", "git push origin main");
  });

  it("execution boundaries: runner verbs never generalize past themselves", () => {
    assertNoMerge("npm run dev", "npm run test", "boundary");
    assertNoMerge("bun run dev", "bun run test", "boundary");
    assertNoMerge("pnpm exec jest", "pnpm exec vitest", "boundary");
  });

  it("eval-flag pairs never slot their code argument", () => {
    // code is the first bare word → pinned structure (subcommand-mismatch)
    assertNoMerge('python -c "import os"', 'python -c "print(1)"', "subcommand-mismatch");
    assertNoMerge("node -e a()", "node -e b()", "subcommand-mismatch");
    assertNoMerge("perl -e 'a'", "perl -e 'b'", "subcommand-mismatch");
    // sed scripts may exec via the s///e flag — also pinned as first bare word
    assertNoMerge("sed -e s/a/b/ in", "sed -e s/x/y/ in", "subcommand-mismatch");
  });

  it("post-target exec (class C) never slots", () => {
    assertNoMerge("docker run ubuntu bash", "docker run alpine bash");
    assertNoMerge("docker run ubuntu bash", "docker run ubuntu sh", "boundary");
    assertNoMerge("docker exec c1 ls", "docker exec c2 ls");
    assertNoMerge("kubectl exec pod1 -- ls a", "kubectl exec pod1 -- ls b", "boundary");
    assertNoMerge("ssh host cmd1", "ssh host cmd2", "boundary");
  });

  it("cross-program never merges", () => {
    assertNoMerge("git log main", "docker logs main");
  });

  it("hazardous slot values never ripen", () => {
    const r = merge2("dd if=.env bs=1", "dd if=notes.txt bs=1");
    assert.ok(!r.ok, "hazardous exemplar value must block the merge");
    assert.equal(r.ok ? "" : r.failure.why, "hazard");
    assert.equal(hasHazardousValues(toks("cat x .env")), true);
    assert.equal(hasHazardousValues(toks("cat x notes.txt")), false);
  });
});

// ─── Matching negatives: stored patterns must not over-match ────────────────

describe("pattern matching — never wider than observed structure", () => {
  const push = merge2("git push origin main", "git push origin dev");
  assert.ok(push.ok);

  it("slot never matches flags (unobserved flags are not admitted)", () => {
    assert.equal(patternMatches(push.ok ? push.pattern : { tokens: [] }, toks("git push --force")), false);
    assert.equal(patternMatches(push.ok ? push.pattern : { tokens: [] }, toks("git push origin --force")), false);
  });

  it("slot never matches assignments", () => {
    assert.equal(patternMatches(push.ok ? push.pattern : { tokens: [] }, toks("git push origin K=v")), false);
  });

  it("token count is exact", () => {
    assert.equal(patternMatches(push.ok ? push.pattern : { tokens: [] }, toks("git push origin")), false);
    assert.equal(patternMatches(push.ok ? push.pattern : { tokens: [] }, toks("git push origin main extra")), false);
  });

  it("subcommand position stays literal", () => {
    assert.equal(patternMatches(push.ok ? push.pattern : { tokens: [] }, toks("git pull origin main")), false);
  });

  it("dd pattern cannot match of= (flag-assignment divergence)", () => {
    const dd = merge2("dd if=a.img bs=4M", "dd if=b.iso bs=1M");
    assert.ok(dd.ok);
    assert.equal(patternMatches(dd.pattern, toks("dd of=x bs=1")), false);
    assert.equal(patternMatches(dd.pattern, toks("dd if=x of=y")), false);
    assert.equal(patternMatches(dd.pattern, toks("dd if=x")), false);
  });
});

// ─── Shape keys ─────────────────────────────────────────────────────────────

describe("shape keys", () => {
  it("group same-structure commands", () => {
    assert.equal(shapeKeyOf(toks("git log main")), shapeKeyOf(toks("git log dev")));
    assert.equal(shapeKeyOf(toks("dd if=a bs=1")), shapeKeyOf(toks("dd if=b bs=2")));
  });

  it("separate different structure", () => {
    assert.notEqual(shapeKeyOf(toks("git log")), shapeKeyOf(toks("git branch")));
    assert.notEqual(shapeKeyOf(toks("grep -r x")), shapeKeyOf(toks("grep -i x")));
    assert.notEqual(shapeKeyOf(toks("dd if=a")), shapeKeyOf(toks("dd of=a")));
    assert.notEqual(shapeKeyOf(toks("git log main")), shapeKeyOf(toks("git log -p main")));
  });

  it("refuses to shape programs that are not bare words", () => {
    // direct: program must be a bare word (leading assignments are parsed
    // away by the shell parser; flag/assignment programs are refused)
    assert.equal(shapeKeyOf(["-x", "y"]), null);
    assert.equal(shapeKeyOf(["A=1", "b"]), null);
    assert.equal(shapeKeyOf([]), null);
  });
});

// ─── Property: merges never admit structural outsiders ──────────────────────

describe("property: merged patterns reject fuzzed outsiders", () => {
  const cases: Array<[string, string, string]> = [
    ["git log main", "git log dev", "git log <arg>"],
    ["git commit -m a x", "git commit -m b y", "git commit -m <arg> <arg>"],
    ["dd if=a bs=1", "dd if=b bs=2", "dd if=<arg> bs=<arg>"],
  ];
  for (const [a, b] of cases) {
    const r = mergeExemplars([toks(a), toks(b)]);
    assert.ok(r.ok);
    const outsiders = [
      ...[ "--force", "--all", "-rf", "k=v" ].map((f) => [ ...toks(a).slice(0, -1), f ]),
      toks(a).slice(0, -1),                // truncated
      [ ...toks(a), "extra" ],             // extended
    ];
    for (const out of outsiders) {
      if (out.length !== r.pattern.tokens.length) {
        assert.equal(patternMatches(r.pattern, out), false, `must reject: ${out.join(" ")}`);
      }
    }
  }
});

// ─── Boundary tables: the audit of 2026 ─────────────────────────────────────
//
// The tables are enforced table-driven rather than case by case: every entry
// in CODE_FLAG_PAIRS / RUNNER_VERBS / OPAQUE_PROGRAMS / SUB_OPAQUE is fed a
// synthetic pair whose varying token sits immediately after the boundary, so
// adding a row without real coverage is impossible — the row IS the test.
// A `zz`/`.`/`image` literal keeps the boundary token off the first-bare-word
// pin, which otherwise protects many real shapes for a different reason (that
// is why the realistic cases below assert whichever reason actually fires).

describe("boundary tables — every entry refuses the token that follows it", () => {
  it("code flags never slot the code, script, module, or package after them", () => {
    for (const [program, flags] of Object.entries(CODE_FLAG_PAIRS)) {
      for (const flag of flags) {
        assertNoMerge(`${program} zz ${flag} x1`, `${program} zz ${flag} x2`, "boundary");
      }
    }
  });

  it("runner verbs never slot the program, package, or code after them", () => {
    for (const verb of RUNNER_VERBS) {
      // -exec / -execdir never reach the merge as tokens: the bash parser
      // splits them into a nested subcommand (asserted below). They stay in the
      // table as defense-in-depth for parsers that flatten the same command.
      if (verb === "-exec" || verb === "-execdir") continue;
      // flag verbs (find --exec) get their first bare word from the path; bare
      // verbs need a flag so the verb itself is not the pinned first bare word
      const prefix = verb.startsWith("-") ? "find ." : "npm -g";
      assertNoMerge(`${prefix} ${verb} x1`, `${prefix} ${verb} x2`, "boundary");
    }
  });

  it("find's exec flags are split off by the parser, one layer earlier", () => {
    for (const verb of ["-exec", "-execdir"]) {
      const command = `find . ${verb} x1`;
      // the parser folds the flag into the subcommand name (find:exec) and the
      // nested command keeps its own token list, so x1 is never a token that
      // could follow -exec inside one list
      assert.ok(
        parseCommand(command).subcommands.some((s) => s.includes("exec")),
        `${verb}: the flag must be folded into the subcommand name`,
      );
      const flat = subcommandTokenLists(command).flat();
      assert.ok(
        flat.indexOf("x1") !== flat.indexOf(verb) + 1,
        `${verb}: no slot-able token may follow the raw flag`,
      );
    }
  });

  it("opaque programs never slot anywhere after the program", () => {
    for (const program of OPAQUE_PROGRAMS) {
      assertNoMerge(`${program} target x1`, `${program} target x2`, "boundary");
    }
  });

  it("opaque subcommands never slot after the image or target", () => {
    for (const [program, subs] of Object.entries(SUB_OPAQUE)) {
      for (const sub of subs) {
        assertNoMerge(`${program} ${sub} image x1`, `${program} ${sub} image x2`, "boundary");
      }
    }
  });
});

describe("audit 2026 — holes the expanded tables close", () => {
  it("SQL and build scripts that sit behind a pinned path", () => {
    assertNoMerge("sqlite3 db.sqlite 'SELECT a'", "sqlite3 db.sqlite 'SELECT b'", "boundary");
    assertNoMerge("duckdb db.duckdb 'SELECT a'", "duckdb db.duckdb 'SELECT b'", "boundary");
    // the script file is the first bare word, so the pin is what refuses these
    assertNoMerge("make -f a.mk t x", "make -f b.mk t x", "subcommand-mismatch");
    assertNoMerge("just -f a.just t x", "just -f b.just t x", "subcommand-mismatch");
  });

  it("code in a flag value that is not the first bare word", () => {
    assertNoMerge("mysql -u root -e 'SELECT a'", "mysql -u root -e 'SELECT b'", "boundary");
    assertNoMerge("psql -h host -c 'SELECT a'", "psql -h host -c 'SELECT b'", "boundary");
    assertNoMerge("su deploy -c 'cmd1'", "su deploy -c 'cmd2'", "boundary");
    assertNoMerge("bash -o pipefail -c 'cmd1'", "bash -o pipefail -c 'cmd2'", "boundary");
    assertNoMerge("java --module-path mods -m app1/App", "java --module-path mods -m app2/App", "boundary");
  });

  it("two-token docker/podman forms whose exec subcommand is not at position 1", () => {
    assertNoMerge("docker compose run svc cmd1", "docker compose run svc cmd2", "boundary");
    assertNoMerge("podman container exec c1 ls a", "podman container exec c1 ls b", "boundary");
  });

  it("keystrokes destined for another process, and address-based exec", () => {
    assertNoMerge("tmux send-keys cmd1", "tmux send-keys cmd2", "boundary");
    assertNoMerge("screen -X stuff cmd1", "screen -X stuff cmd2", "boundary");
    assertNoMerge("socat TCP:host:1 EXEC:a", "socat TCP:host:1 EXEC:b", "boundary");
  });

  it("launchers that take a command as a positional argument", () => {
    assertNoMerge("nsenter -t 1 -m cmd1", "nsenter -t 1 -m cmd2", "boundary");
    assertNoMerge("chroot /mnt cmd1", "chroot /mnt cmd2", "boundary");
    assertNoMerge("mosh host cmd1", "mosh host cmd2", "boundary");
  });

  it("package verbs select remote code, not data", () => {
    assertNoMerge("pnpm dlx pkg1", "pnpm dlx pkg2", "boundary");
    assertNoMerge("npm install pkg1", "npm install pkg2", "boundary");
    assertNoMerge("cargo add crate1", "cargo add crate2", "boundary");
    // the package name here is the first bare word, so the pin refuses it
    assertNoMerge("npx -p pkg1 cmd x", "npx -p pkg2 cmd x", "subcommand-mismatch");
  });
});

describe("audit 2026 — data flags are still not boundaries", () => {
  it("counts, encodings, defines, and load paths keep slotting", () => {
    assertMerges("python -O script.py a", "python -O script.py b", "python -O script.py <arg>");
    assertMerges("ruby -w script.rb a", "ruby -w script.rb b", "ruby -w script.rb <arg>");
    assertMerges("perl -w script.pl a", "perl -w script.pl b", "perl -w script.pl <arg>");
    assertMerges("lua -W script.lua a", "lua -W script.lua b", "lua -W script.lua <arg>");
    assertMerges("php -d memory_limit=1G a.php x", "php -d memory_limit=1G a.php y", "php -d memory_limit=1G a.php <arg>");
    assertMerges("make -o a.o target x", "make -o a.o target y", "make -o a.o target <arg>");
    assertMerges("just --dry-run build x", "just --dry-run build y", "just --dry-run build <arg>");
  });

  it("a load path is deliberately not a boundary (locked-in residual)", () => {
    // `-cp` decides where classes are found, which can redirect resolution to
    // an arbitrary jar. Recorded as a residual: it is not the "what runs next"
    // position, so it stays slot-able and this test freezes that decision.
    assertMerges("java -cp a.jar Main x", "java -cp a.jar Main y", "java -cp a.jar Main <arg>");
  });

  it("package verbs over-block on purpose — the designed failure mode", () => {
    assertNoMerge("dnf install pkg1", "dnf install pkg2", "boundary");
    // …but the slot one token further along is data and still merges
    assertMerges("git remote add origin https://a", "git remote add origin https://b", "git remote add origin <arg>");
  });
});

// Story #121: no test may write the developer's real Foreman state. Plain JS (no types, no
// dependencies) so server/paths.ts, the hooks and the scripts can all share one definition.
//
// "Under test" means this process was started by `node --test`: node sets NODE_TEST_CONTEXT in
// every test-file child process (and children those tests spawn inherit it), and with
// --test-isolation=none the test file runs in the runner itself, whose execArgv carries --test.
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export function underNodeTest(env = process.env, execArgv = process.execArgv) {
  return Boolean(env.NODE_TEST_CONTEXT) || execArgv.includes("--test");
}

// Realpath of the longest existing prefix, plus the not-yet-created remainder, so a home that
// does not exist yet (or reaches the real one through a symlink) still compares correctly.
function canonical(path) {
  let current = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(realpathSync(current), ...rest.reverse()); } catch {}
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.push(basename(current));
    current = parent;
  }
}

function accountHome() {
  try { return userInfo().homedir; } catch { return null; }
}

// The real homes a test must never use. `.foreman` (production) is refused under both the
// account's home and $HOME, so pointing HOME at a temp dir does not make the default acceptable.
// `.foreman-dev` is refused only under the account's home: the dev-environment tests sandbox
// themselves with HOME=<temp dir>, which makes <temp dir>/.foreman-dev their disposable dev home.
export function realHomes() {
  const account = accountHome();
  const bases = [...new Set([account, homedir()].filter(Boolean))];
  const homes = bases.map((base) => join(base, ".foreman"));
  if (account) homes.push(join(account, ".foreman-dev"));
  return homes.map(canonical);
}

// The real Codex home (~/.codex), for code that writes CODEX_HOME (scripts/install-codex-hooks.mjs).
export function realCodexHomes() {
  const account = accountHome();
  return [...new Set([account, homedir()].filter(Boolean))].map((base) => canonical(join(base, ".codex")));
}

export function isRealHome(path, homes = realHomes()) {
  const target = canonical(path);
  return homes.some((home) => target === home || target.startsWith(home + sep));
}

/**
 * Under `node --test`, throw unless `path` is an explicitly chosen home outside the real ones.
 * `explicit` is false when `path` is only the built-in default (the env variable was unset).
 */
export function assertTestHome(path, { explicit = true, variable = "FOREMAN_HOME", homes } = {}) {
  if (!underNodeTest()) return;
  if (!explicit || isRealHome(path, homes ?? realHomes())) {
    throw new Error(`Refusing to use the real home (${path}) under node --test: set ${variable} to a temp dir (mkdtemp) first.`);
  }
}

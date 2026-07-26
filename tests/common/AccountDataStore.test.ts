import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import AccountDataStore from "../../src/common/AccountDataStore";
import { AZURITE_ACCOUNTS_FILE_ENV } from "../../src/common/utils/constants";
import ILogger from "../../src/queue/generated/utils/ILogger";

const nopLogger: ILogger = {
  error: () => {
    /* no-op */
  },
  warn: () => {
    /* no-op */
  },
  info: () => {
    /* no-op */
  },
  verbose: () => {
    /* no-op */
  },
  debug: () => {
    /* no-op */
  }
};

// AZURITE_ACCOUNTS values are base64-encoded keys.
const b64 = (s: string) => Buffer.from(s).toString("base64");

// Filesystem change events are delivered asynchronously, so poll for the
// expected state instead of assuming it has landed by the next tick.
const waitFor = async (
  condition: () => boolean,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the accounts file reload.");
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

describe("AccountDataStore file-backed accounts @loki @sql", () => {
  let dir: string;
  let filePath: string;
  let store: AccountDataStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "azurite-accounts-"));
    filePath = path.join(dir, "accounts");
    delete process.env[AZURITE_ACCOUNTS_FILE_ENV];
  });

  afterEach(async () => {
    if (store !== undefined) {
      await store.close();
      store = undefined;
    }
    delete process.env[AZURITE_ACCOUNTS_FILE_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads accounts from the file at init @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();

    assert.strictEqual(store.getAccount("acct1")?.name, "acct1");
    assert.deepStrictEqual(
      store.getAccount("acct1")?.key1,
      Buffer.from(b64("key-one"), "base64")
    );
    // A configured file source replaces the built-in default account.
    assert.strictEqual(store.getAccount("devstoreaccount1"), undefined);
  });

  it("reloads added accounts when the file is replaced by rename @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();
    // Precondition: the second account does not exist before the reload.
    assert.strictEqual(store.getAccount("acct2"), undefined);

    // Replace the file by rename-over, as an atomic writer does.
    const staged = `${filePath}.tmp`;
    fs.writeFileSync(staged, `acct1:${b64("key-one")};acct2:${b64("key-two")}`);
    fs.renameSync(staged, filePath);

    await waitFor(() => store!.getAccount("acct2") !== undefined);

    assert.strictEqual(store.getAccount("acct2")?.name, "acct2");
    assert.deepStrictEqual(
      store.getAccount("acct2")?.key1,
      Buffer.from(b64("key-two"), "base64")
    );
    assert.strictEqual(store.getAccount("acct1")?.name, "acct1");
  });

  it("reloads added accounts when the file is written in place @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();
    assert.strictEqual(store.getAccount("acct2"), undefined); // precondition

    fs.writeFileSync(
      filePath,
      `acct1:${b64("key-one")};acct2:${b64("key-two")}`
    );

    await waitFor(() => store!.getAccount("acct2") !== undefined);
    assert.strictEqual(store.getAccount("acct2")?.name, "acct2");
  });

  it("stops watching the file on close @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();

    // Prove the watcher is live before closing it, so a later no-op cannot be
    // mistaken for a watcher that stopped.
    fs.writeFileSync(
      filePath,
      `acct1:${b64("key-one")};acct2:${b64("key-two")}`
    );
    await waitFor(() => store!.getAccount("acct2") !== undefined);

    await store.close();

    fs.writeFileSync(
      filePath,
      `acct1:${b64("key-one")};acct2:${b64("key-two")};acct3:${b64("key-three")}`
    );
    // Wait for three polling intervals.
    await new Promise(resolve => setTimeout(resolve, 1500));

    assert.strictEqual(store.getAccount("acct3"), undefined);
    store = undefined;
  });

  it("keeps current accounts when the file is unreadable on reload @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();

    // Prove reloads are reaching the store, so retention below is the failed
    // reload's doing rather than a watcher that never fired.
    fs.writeFileSync(
      filePath,
      `acct1:${b64("key-one")};acct2:${b64("key-two")}`
    );
    await waitFor(() => store!.getAccount("acct2") !== undefined);

    fs.rmSync(filePath);
    // Wait for three polling intervals after removal.
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Accounts are retained rather than dropped to the built-in default.
    assert.strictEqual(store.getAccount("acct1")?.name, "acct1");
    assert.strictEqual(store.getAccount("acct2")?.name, "acct2");
    assert.strictEqual(store.getAccount("devstoreaccount1"), undefined);
  });

  it("keeps current accounts when the file is emptied @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();

    // Prove reloads are reaching the store before relying on one not to.
    fs.writeFileSync(
      filePath,
      `acct1:${b64("key-one")};acct2:${b64("key-two")}`
    );
    await waitFor(() => store!.getAccount("acct2") !== undefined);

    fs.writeFileSync(filePath, "");
    // Wait for three polling intervals.
    await new Promise(resolve => setTimeout(resolve, 1500));

    // An empty file parses cleanly, so without a guard it would drop every account.
    assert.strictEqual(store.getAccount("acct1")?.name, "acct1");
    assert.strictEqual(store.getAccount("acct2")?.name, "acct2");
    assert.strictEqual(store.getAccount("devstoreaccount1"), undefined);
  });

  it("still honors AZURITE_ACCOUNTS when no file is configured @loki @sql", async () => {
    process.env["AZURITE_ACCOUNTS"] = `envacct:${b64("env-key")}`;
    try {
      store = new AccountDataStore(nopLogger);
      await store.init();
      assert.strictEqual(store.getAccount("envacct")?.name, "envacct");
    } finally {
      delete process.env["AZURITE_ACCOUNTS"];
    }
  });

  it("fails closed when the configured file cannot be read at startup @loki @sql", async () => {
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = path.join(dir, "does-not-exist");
    store = new AccountDataStore(nopLogger);

    // A configured-but-missing file must abort startup rather than silently
    // falling back to the built-in default account (which has a well-known key).
    await assert.rejects(() => store!.init());
    assert.strictEqual(store.isInitialized(), false);
  });

  it("prefers AZURITE_ACCOUNTS_FILE over AZURITE_ACCOUNTS @loki @sql", async () => {
    fs.writeFileSync(filePath, `fileacct:${b64("file-key")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;
    process.env["AZURITE_ACCOUNTS"] = `envacct:${b64("env-key")}`;
    try {
      store = new AccountDataStore(nopLogger);
      await store.init();
      assert.strictEqual(store.getAccount("fileacct")?.name, "fileacct");
      assert.strictEqual(store.getAccount("envacct"), undefined);
    } finally {
      delete process.env["AZURITE_ACCOUNTS"];
    }
  });

  it("does not start the polling interval in file mode @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    const originalSetInterval = global.setInterval;
    let intervalStarted = false;
    global.setInterval = ((
      handler: (...handlerArgs: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      intervalStarted = true;
      return originalSetInterval(handler, timeout, ...args);
    }) as typeof global.setInterval;

    try {
      store = new AccountDataStore(nopLogger);
      await store.init();
      assert.strictEqual(intervalStarted, false);
    } finally {
      global.setInterval = originalSetInterval;
    }
  });
});

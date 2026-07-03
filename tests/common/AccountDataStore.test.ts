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

// Synchronously invoke the process SIGHUP handlers (does not send an OS signal).
const emitSighup = () =>
  (process.emit as unknown as (event: string) => boolean)("SIGHUP");

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

  it("reloads added accounts from the file on SIGHUP @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();
    // Precondition: the second account does not exist before the reload.
    assert.strictEqual(store.getAccount("acct2"), undefined);

    fs.writeFileSync(
      filePath,
      `acct1:${b64("key-one")};acct2:${b64("key-two")}`
    );
    emitSighup();

    assert.strictEqual(store.getAccount("acct2")?.name, "acct2");
    assert.deepStrictEqual(
      store.getAccount("acct2")?.key1,
      Buffer.from(b64("key-two"), "base64")
    );
    // The originally-loaded account is still present.
    assert.strictEqual(store.getAccount("acct1")?.name, "acct1");
  });

  it("keeps current accounts when the file is unreadable on reload @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    store = new AccountDataStore(nopLogger);
    await store.init();
    assert.ok(store.getAccount("acct1")); // precondition

    fs.rmSync(filePath);
    emitSighup();

    // Accounts are retained rather than dropped to the built-in default.
    assert.strictEqual(store.getAccount("acct1")?.name, "acct1");
    assert.strictEqual(store.getAccount("devstoreaccount1"), undefined);
  });

  it("removes its SIGHUP listener on close @loki @sql", async () => {
    fs.writeFileSync(filePath, `acct1:${b64("key-one")}`);
    process.env[AZURITE_ACCOUNTS_FILE_ENV] = filePath;

    const before = process.listenerCount("SIGHUP");
    store = new AccountDataStore(nopLogger);
    await store.init();
    assert.strictEqual(process.listenerCount("SIGHUP"), before + 1);

    await store.close();
    store = undefined;
    assert.strictEqual(process.listenerCount("SIGHUP"), before);
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

import * as fs from "fs";

import {
  EMULATOR_ACCOUNT_KEY,
  EMULATOR_ACCOUNT_NAME
} from "../common/utils/constants";
import ILogger from "../queue/generated/utils/ILogger";
import IAccountDataStore, { IAccountProperties } from "./IAccountDataStore";
import {
  ACCOUNTS_FILE_POLL_INTERVAL,
  AZURITE_ACCOUNTS_ENV,
  AZURITE_ACCOUNTS_FILE_ENV,
  DEFAULT_ACCOUNTS_REFRESH_INTERVAL
} from "./utils/constants";

enum Status {
  Initializing,
  Initialized,
  Closing,
  Closed
}

interface IAccounts {
  [key: string]: IAccountProperties;
}

const DEFAULT_EMULATOR_ACCOUNTS: IAccounts = {
  [EMULATOR_ACCOUNT_NAME]: {
    name: EMULATOR_ACCOUNT_NAME,
    key1: EMULATOR_ACCOUNT_KEY
  }
};

export default class AccountDataStore implements IAccountDataStore {
  private status: Status = Status.Closed;
  private timer: any;
  private watchedFilePath: string | undefined;
  private accounts: IAccounts = DEFAULT_EMULATOR_ACCOUNTS;
  private readonly reloadListener = () => this.refresh();

  public constructor(private readonly logger: ILogger) {}

  public getAccount(name: string): IAccountProperties | undefined {
    if (this.accounts[name] !== undefined) {
      return this.accounts[name];
    } else {
      return undefined;
    }
  }

  public async init(): Promise<void> {
    this.refresh(true);

    const accountsFilePath = process.env[AZURITE_ACCOUNTS_FILE_ENV];
    if (accountsFilePath) {
      this.watchAccountsFile(accountsFilePath);
    } else {
      this.timer = setInterval(() => {
        this.refresh();
      }, DEFAULT_ACCOUNTS_REFRESH_INTERVAL);
      this.timer.unref();
    }

    this.status = Status.Initialized;
  }

  public isInitialized(): boolean {
    return this.status === Status.Initialized;
  }

  public async close(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    if (this.watchedFilePath !== undefined) {
      fs.unwatchFile(this.watchedFilePath, this.reloadListener);
      this.watchedFilePath = undefined;
    }
    this.status = Status.Closed;
  }

  public isClosed(): boolean {
    return this.status === Status.Closed;
  }

  public async clean(): Promise<void> {
    /* NOOP */
  }

  /**
   * Polls the file's modification time. Change events do not cross a host
   * directory bind-mounted into a container, and polling follows the pathname,
   * so a staged file renamed over the destination is still seen.
   */
  private watchAccountsFile(accountsFilePath: string) {
    fs.watchFile(
      accountsFilePath,
      { interval: ACCOUNTS_FILE_POLL_INTERVAL },
      this.reloadListener
    );
    this.watchedFilePath = accountsFilePath;
  }

  private refresh(initialLoad = false) {
    const accountsFilePath = process.env[AZURITE_ACCOUNTS_FILE_ENV];
    if (accountsFilePath) {
      this.refreshFromFile(accountsFilePath, initialLoad);
      return;
    }

    // TODO: Parse environment variable from environment class
    const env = process.env[AZURITE_ACCOUNTS_ENV];
    this.logger.info(
      `AccountDataStore:init() Refresh accounts from environment variable ${AZURITE_ACCOUNTS_ENV} with value ${
        env ? "*****" : undefined
      }`
    );
    if (env) {
      try {
        this.accounts = this.parserAccountsEnvironmentString(env);
      } catch (err) {
        this.logger.error(
          `AccountDataStore:init() Fallback to default emulator account ${EMULATOR_ACCOUNT_NAME}. Refresh accounts from environment variable ${AZURITE_ACCOUNTS_ENV} failed. ${JSON.stringify(
            err
          )}`
        );
        this.accounts = DEFAULT_EMULATOR_ACCOUNTS;
      }
    } else {
      this.logger.info(
        `AccountDataStore:init() Fallback to default emulator account ${EMULATOR_ACCOUNT_NAME}.`
      );
      this.accounts = DEFAULT_EMULATOR_ACCOUNTS;
    }
  }

  private refreshFromFile(accountsFilePath: string, initialLoad: boolean) {
    try {
      const content = fs.readFileSync(accountsFilePath, { encoding: "utf8" });
      const accounts = this.parserAccountsEnvironmentString(content);
      if (Object.keys(accounts).length === 0) {
        // An empty file parses without error, so it would otherwise replace every loaded
        // account and fail each request that follows. Treat it as a bad read.
        throw new Error(`Accounts file ${accountsFilePath} defines no accounts.`);
      }

      this.accounts = accounts;
      this.logger.info(
        `AccountDataStore:refresh() Loaded accounts from file ${accountsFilePath}.`
      );
    } catch (err) {
      if (initialLoad) {
        // Fail closed on startup: when a file source is explicitly configured
        // but cannot be loaded, do not silently keep the built-in default
        // account (which uses a well-known key).
        throw new Error(
          `AccountDataStore: failed to load accounts from file ${accountsFilePath}. ${JSON.stringify(
            err
          )}`
        );
      }
      // On a later reload, keep the currently loaded accounts so a transient
      // or malformed write does not drop live accounts.
      this.logger.error(
        `AccountDataStore:refresh() Failed to reload accounts from file ${accountsFilePath}; keeping current accounts. ${JSON.stringify(
          err
        )}`
      );
    }
  }

  private parserAccountsEnvironmentString(accounts: string): IAccounts {
    // account1:key1
    // account1:key1:key2
    // account1:key1:key2;account2:key2;
    const results: IAccounts = {};
    const accountsArray = accounts.trim().split(";");
    accountsArray.forEach(accountAndKeys => {
      if (accountAndKeys.length > 0) {
        const parts = accountAndKeys.split(":");
        if (parts.length < 2 || parts.length > 3) {
          throw RangeError(
            `AccountDataStore:parserAccountsEnvironmentString() Invalid environment string format for ${accounts}`
          );
        }
        const account = parts[0];
        const key1 = parts[1];
        const key2 = parts.length > 2 ? parts[2] : undefined;
        results[account] = {
          name: account,
          key1: Buffer.from(key1, "base64"),
          key2: key2 ? Buffer.from(key2, "base64") : undefined
        };
      }
    });

    return results;
  }
}

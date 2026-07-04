import { StorageError } from "../../blob/generated/artifacts/mappers";

/**
 * Base Batch serialization class.
 * Contains shared logic for batch serialization.
 * ToDo: Make these util functions static or aggregate this logic into one of the other
 * batch classes
 *
 * @export
 * @param {string} batchBoundary
 * @param {string} changesetBoundary
 */
export class BatchSerialization {
  public batchBoundary: string = "";
  public changesetBoundary: string = "";
  public lineEnding: string = "";

  public extractBatchBoundary(batchRequestsString: string): void {
    let batchRequestToProcess = "";
    try {
      batchRequestToProcess = decodeURI(batchRequestsString);
    } catch (err: any) {
      batchRequestToProcess = batchRequestsString;
    }
    const batchBoundaryMatch = batchRequestToProcess.match(
      // prettier-ignore
      /--batch_(\w+-?)+/
    );
    if (null != batchBoundaryMatch) {
      this.batchBoundary = batchBoundaryMatch[0];
    } else {
      throw Error("no batch boundary found in request");
    }
  }

  // ToDo: improve RegEx, as not sure if spec allows for use of other
  // change set boundary styles (such as boundary=blahblahblah)
  // have tried to make as generic as possible
  public extractChangeSetBoundary(batchRequestsString: string): void {
    let subChangeSetPrefixMatches = batchRequestsString.match(
      /(boundary=)+(\w+_?(\w+-?)+)/
    );

    if (subChangeSetPrefixMatches != null) {
      this.changesetBoundary = subChangeSetPrefixMatches[2];
    } else {
      // we need to see if this is a single query batch operation
      // whose format is different! (as we only support a single query per batch)
      // ToDo: do we need to check for GET HTTP verb?
      subChangeSetPrefixMatches = batchRequestsString.match(/(--batch_\w+)/);
      if (subChangeSetPrefixMatches != null) {
        this.changesetBoundary = subChangeSetPrefixMatches[1];
      } else {
        throw StorageError;
      }
    }
  }

  public extractLineEndings(batchRequestsString: string): void {
    const lineEndingMatch = batchRequestsString.match(
      // prettier-ignore
      /\r?\n+/
    );
    if (lineEndingMatch != null) {
      this.lineEnding = lineEndingMatch[0];
    } else {
      throw StorageError;
    }
  }

  /**
   * Extracts the resource path from a batch sub-request URI. The table name is
   * returned in capture group 1 (used by the deserializer as the operation's
   * table). Supports both addressing styles that Storage clients emit:
   *   - path-style       : http://host:port/{account}/{table}(...)  (dev-storage / IP endpoints)
   *   - production-style  : https://{account}.table.host/{table}(...) (account in the host)
   * @param uriString the full sub-request URI
   * @returns the regex match (group [1] = table name), or null when none is found
   */
  public extractPath(uriString: string) {
    // Path-style: the account precedes the table in the path (/{account}/{table}).
    const pathStyle = uriString.match(/\/\w+\/(\w+)/);
    if (pathStyle !== null) {
      return pathStyle;
    }

    // Production-style: the account is in the host, so the path has a single
    // segment (/{table}). Strip the scheme + authority, then capture the table
    // name at the start of the path; it ends at the entity-key '(', the query
    // '?', or the path end. Anchoring to the path start avoids matching a later
    // segment for a malformed URL that has no table segment.
    return uriString
      .replace(/^https?:\/\/[^/]+/i, "")
      .match(/^\/(\w+)(?=\(|\?|$)/);
  }
}

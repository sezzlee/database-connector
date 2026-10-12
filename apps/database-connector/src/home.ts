import { homedir } from "node:os";
import { join } from "node:path";

export const WINDOWS_SERVICE = "SezzleeDatabaseConnector";

export function connectorHome(): string {
  return process.env.SEZZLEE_CONNECTOR_HOME ?? join(homedir(), ".sezzlee");
}

/**
 * Guard: set only by the Windows service and its installer. The state then
 * belongs to the service's virtual account, so its ACL names that account and
 * its key is sealed by DPAPI for the machine rather than for whoever runs the
 * command.
 */
export function windowsServiceAccount(): string | undefined {
  return process.platform === "win32" &&
    process.env.SEZZLEE_CONNECTOR_SERVICE === WINDOWS_SERVICE
    ? `NT SERVICE\\${WINDOWS_SERVICE}`
    : undefined;
}

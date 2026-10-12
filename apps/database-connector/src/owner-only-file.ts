import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { windowsServiceAccount } from "./home.ts";

/**
 * Guard: Windows looks a bare program name up in the working directory before
 * PATH, so a planted powershell.exe there would be handed the connector's
 * secrets and ACLs.
 */
export const POWERSHELL = win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * Guard: the ACL names only the current account, or inside the Windows
 * service the service's virtual account, SYSTEM and Administrators, so the
 * installer and the service both reach the state and nobody else does.
 */
async function windowsAcl(
  path: string,
  directory: boolean,
  verify = false,
): Promise<void> {
  const accounts = `
    $ErrorActionPreference='Stop'; $p=$env:SEZZLEE_CONNECTOR_FILE;
    $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $sids=@($me);
    if ($env:SEZZLEE_CONNECTOR_ACCOUNT) {
      $sids=@(
        (New-Object System.Security.Principal.NTAccount($env:SEZZLEE_CONNECTOR_ACCOUNT)).Translate([System.Security.Principal.SecurityIdentifier]),
        (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
        (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
      );
    }`;
  const script = verify
    ? `${accounts}
    $acl=Get-Acl -LiteralPath $p;
    $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]);
    if (!$acl.AreAccessRulesProtected -or (($sids + $me) -notcontains $owner)) { throw 'Unsafe connector ACL' };
    foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and ($sids -notcontains $rule.IdentityReference)) { throw 'Unsafe connector ACL' }
    }`
    : `${accounts}
    $acl=New-Object System.Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"};
    $acl.SetOwner($(if ($sids -contains $me) { $me } else { $sids[2] })); $acl.SetAccessRuleProtection($true,$false);
    foreach ($sid in $sids) {
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl'${directory ? ",'ContainerInherit,ObjectInherit','None'" : ""},'Allow')));
    }
    Set-Acl -LiteralPath $p -AclObject $acl;`;
  const account = windowsServiceAccount();
  await promisify(execFile)(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        SEZZLEE_CONNECTOR_FILE: path,
        ...(account === undefined
          ? {}
          : { SEZZLEE_CONNECTOR_ACCOUNT: account }),
      },
      windowsHide: true,
    },
  );
}

export async function writeOwnerOnlyFile(
  path: string,
  text: string,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dir);
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (process.getuid !== undefined && dirStat.uid !== process.getuid())
  )
    throw new Error("Unsafe connector directory");
  if (process.platform === "win32") await windowsAcl(dir, true);
  else await chmod(dir, 0o700);
  const temporary = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    if (process.platform === "win32") await windowsAcl(temporary, false);
    else await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function assertOwnerOnlyDirectory(
  dir: string,
  label: string,
): Promise<void> {
  const stat = await lstat(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())))
  )
    throw new Error(
      `Connector ${label} directory requires owner-only permissions`,
    );
}

/**
 * Guard: the file is opened first and every check runs on the opened handle,
 * so nothing can swap the path between the check and the read. `O_NOFOLLOW`
 * refuses a symlink at open; Windows has no such flag, so there the path is
 * checked before the open and the ACL after it.
 */
export async function readOwnerOnlyFile(
  path: string,
  file: { readonly label: string; readonly maxBytes: number },
): Promise<string> {
  const unsafe = () => new Error(`Unsafe connector ${file.label} file`);
  await assertOwnerOnlyDirectory(dirname(path), file.label);
  if (process.platform === "win32" && (await lstat(path)).isSymbolicLink())
    throw unsafe();
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  ).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    )
      throw unsafe();
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > file.maxBytes) throw unsafe();
    if (
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid()))
    )
      throw new Error(
        `Connector ${file.label} requires owner-only permissions`,
      );
    if (process.platform === "win32") await windowsAcl(path, false, true);
    const buffer = Buffer.alloc(file.maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > file.maxBytes) throw unsafe();
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

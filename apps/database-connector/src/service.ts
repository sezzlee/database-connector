import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { isSea } from "node:sea";
import { promisify } from "node:util";
import { WINDOWS_SERVICE } from "./home.ts";
import { POWERSHELL } from "./owner-only-file.ts";

export const SERVICE_USER = "sezzlee-connector";
export const SERVICE_HOME = "/var/lib/sezzlee-database-connector";
const LINUX_BINARY = "/usr/local/bin/sezzlee-database-connector";
const SYSTEMD_UNIT = "sezzlee-database-connector.service";
const LAUNCH_AGENT = "app.sezzlee.database-connector";
const WRAPPER = "sezzlee-database-connector-service";

export class ServiceUsageError extends Error {}

const run = promisify(execFile);

function interactive(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function systemdUnit(): string {
  return `[Unit]
Description=Sezzlee database connector
Wants=network-online.target
After=network-online.target

[Service]
User=${SERVICE_USER}
Group=${SERVICE_USER}
Environment=HOME=${SERVICE_HOME}
Environment=SEZZLEE_CONNECTOR_SECRET_STORE=file
ExecStart=${LINUX_BINARY} run
Restart=on-failure
RestartSec=30
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${SERVICE_HOME}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
}

export function launchAgent(executable: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executable)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function winswConfig(data: string): string {
  return `<service>
  <id>${WINDOWS_SERVICE}</id>
  <name>Sezzlee database connector</name>
  <description>Runs Sezzlee database queries on this network.</description>
  <executable>%BASE%\\sezzlee-database-connector.exe</executable>
  <arguments>run</arguments>
  <env name="SEZZLEE_CONNECTOR_HOME" value="${xml(data)}"/>
  <env name="SEZZLEE_CONNECTOR_SERVICE" value="${WINDOWS_SERVICE}"/>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="30 sec"/>
  <logpath>${xml(win32.join(data, "logs"))}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
`;
}

function windowsPaths() {
  const system = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
  );
  const install = win32.join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "Sezzlee",
    "DatabaseConnector",
  );
  return {
    sc: win32.join(system, "sc.exe"),
    install,
    wrapper: win32.join(install, `${WRAPPER}.exe`),
    root: win32.join(process.env.ProgramData ?? "C:\\ProgramData", "Sezzlee"),
    data: win32.join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "Sezzlee",
      "DatabaseConnector",
    ),
  };
}

/**
 * Points this process at the Windows service's state, so the commands it runs
 * next read and write what the service uses.
 */
export function useWindowsServiceState(): void {
  process.env.SEZZLEE_CONNECTOR_HOME = windowsPaths().data;
  process.env.SEZZLEE_CONNECTOR_SERVICE = WINDOWS_SERVICE;
}

/**
 * Runs a connector command as the Linux service user, whose files root
 * cannot pass the owner-only checks for.
 */
const pick = (env: NodeJS.ProcessEnv, names: readonly string[]) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

export function runAsLinuxService(args: readonly string[]): Promise<void> {
  if (process.getuid?.() !== 0)
    throw new ServiceUsageError("Run this with sudo");
  return interactive(
    "/usr/sbin/runuser",
    ["-u", SERVICE_USER, "--", LINUX_BINARY, ...args],
    {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: SERVICE_HOME,
      SEZZLEE_CONNECTOR_SECRET_STORE: "file",
      ...pick(process.env, ["CHAT_DATABASE_ALLOW_LOCAL_HTTP", "NODE_ENV"]),
    },
  );
}

async function installLinux(api: string | undefined): Promise<void> {
  if (process.getuid?.() !== 0)
    throw new ServiceUsageError("Run service install with sudo");
  if (
    !(await run("/usr/bin/id", ["-u", SERVICE_USER]).then(
      () => true,
      () => false,
    ))
  )
    await run("/usr/sbin/useradd", [
      "--system",
      "--user-group",
      "--home-dir",
      SERVICE_HOME,
      "--create-home",
      "--shell",
      "/usr/sbin/nologin",
      SERVICE_USER,
    ]);
  const uid = Number((await run("/usr/bin/id", ["-u", SERVICE_USER])).stdout);
  const home = await lstat(SERVICE_HOME);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== uid)
    throw new ServiceUsageError(
      `${SERVICE_HOME} must be a directory owned by ${SERVICE_USER}`,
    );
  await chmod(SERVICE_HOME, 0o700);
  /*
   * Guard: the new binary is renamed over the old one, never written into it,
   * so a running service keeps its file and an interrupted copy leaves the
   * installed binary whole.
   */
  if (process.execPath !== LINUX_BINARY) {
    await copyFile(process.execPath, `${LINUX_BINARY}.new`);
    await chmod(`${LINUX_BINARY}.new`, 0o755);
    await rename(`${LINUX_BINARY}.new`, LINUX_BINARY);
  }
  /*
   * Guard: existing state is kept only when the service user can open it
   * under the same owner, mode and seal checks the service applies, so a file
   * planted in the state directory stops the install instead of being run.
   */
  if (await exists(join(SERVICE_HOME, ".sezzlee", "database-connector.json")))
    await runAsLinuxService(["fingerprint"]).catch(() => {
      throw new ServiceUsageError(
        `The state in ${SERVICE_HOME} cannot be opened; remove it and install again`,
      );
    });
  else if (api === undefined)
    throw new ServiceUsageError(
      "service install --api <url> pairs the service",
    );
  else await runAsLinuxService(["pair", "--api", api]);
  await writeFile(`/etc/systemd/system/${SYSTEMD_UNIT}`, systemdUnit(), {
    mode: 0o644,
  });
  await run("/usr/bin/systemctl", ["daemon-reload"]);
  await run("/usr/bin/systemctl", ["enable", "--now", SYSTEMD_UNIT]);
}

async function uninstallLinux(): Promise<void> {
  if (process.getuid?.() !== 0)
    throw new ServiceUsageError("Run service uninstall with sudo");
  await run("/usr/bin/systemctl", ["disable", "--now", SYSTEMD_UNIT]).catch(
    () => undefined,
  );
  await rm(`/etc/systemd/system/${SYSTEMD_UNIT}`, { force: true });
  await run("/usr/bin/systemctl", ["daemon-reload"]);
}

const launchAgentPath = () =>
  join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT}.plist`);

async function installMac(
  pair: () => Promise<void>,
  paired: boolean,
): Promise<void> {
  if (!paired) await pair();
  const path = launchAgentPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    launchAgent(
      process.execPath,
      join(homedir(), "Library", "Logs", "sezzlee-database-connector.log"),
    ),
    { mode: 0o644 },
  );
  const domain = `gui/${process.getuid?.() ?? 0}`;
  await run("/bin/launchctl", ["bootout", `${domain}/${LAUNCH_AGENT}`]).catch(
    () => undefined,
  );
  await run("/bin/launchctl", ["bootstrap", domain, path]);
}

async function uninstallMac(): Promise<void> {
  await run("/bin/launchctl", [
    "bootout",
    `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT}`,
  ]).catch(() => undefined);
  await rm(launchAgentPath(), { force: true });
}

/**
 * Guard: any local user may create folders under %ProgramData%, so a folder
 * there that someone else made first could hold planted state or be swapped
 * after the checks. The installer refuses a reparse point or a folder owned
 * by anyone but itself, SYSTEM or Administrators, then replaces its ACL.
 */
async function lockWindowsDirectory(path: string): Promise<void> {
  await run(
    POWERSHELL,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $p=$env:SEZZLEE_CONNECTOR_FILE;
      $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
      $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
      $admins=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544');
      if (Test-Path -LiteralPath $p) {
        $item=Get-Item -LiteralPath $p -Force;
        if (!$item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe connector directory' };
        $owner=(Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]);
        if (@($me,$system,$admins) -notcontains $owner) { throw 'Unsafe connector directory' };
      } else { New-Item -ItemType Directory -Path $p | Out-Null };
      $sids=@($system,$admins);
      $sids+=(New-Object System.Security.Principal.NTAccount($env:SEZZLEE_CONNECTOR_ACCOUNT)).Translate([System.Security.Principal.SecurityIdentifier]);
      $acl=New-Object System.Security.AccessControl.DirectorySecurity;
      $acl.SetOwner($admins); $acl.SetAccessRuleProtection($true,$false);
      foreach ($sid in $sids) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) };
      Set-Acl -LiteralPath $p -AclObject $acl;`,
    ],
    {
      env: {
        ...process.env,
        SEZZLEE_CONNECTOR_FILE: path,
        SEZZLEE_CONNECTOR_ACCOUNT: `NT SERVICE\\${WINDOWS_SERVICE}`,
      },
      windowsHide: true,
    },
  );
}

async function installWindows(
  pair: () => Promise<void>,
  paired: () => Promise<boolean>,
): Promise<void> {
  const paths = windowsPaths();
  const wrapper = win32.join(dirname(process.execPath), `${WRAPPER}.exe`);
  if (!(await exists(wrapper)))
    throw new ServiceUsageError(
      `${WRAPPER}.exe must sit next to the connector`,
    );
  await mkdir(paths.install, { recursive: true });
  if (
    process.execPath !==
    win32.join(paths.install, "sezzlee-database-connector.exe")
  ) {
    await copyFile(
      process.execPath,
      win32.join(paths.install, "sezzlee-database-connector.exe"),
    );
    await copyFile(wrapper, paths.wrapper);
  }
  await writeFile(
    win32.join(paths.install, `${WRAPPER}.xml`),
    winswConfig(paths.data),
  );
  if (
    !(await run(paths.wrapper, ["status"]).then(
      ({ stdout }) => !/NonExistent/iu.test(stdout),
      () => false,
    ))
  ) {
    await run(paths.wrapper, ["install"]);
    await run(paths.sc, [
      "config",
      WINDOWS_SERVICE,
      "obj=",
      `NT SERVICE\\${WINDOWS_SERVICE}`,
    ]);
  }
  await lockWindowsDirectory(paths.root);
  await lockWindowsDirectory(paths.data);
  useWindowsServiceState();
  if (!(await paired())) await pair();
  await mkdir(win32.join(paths.data, "logs"), { recursive: true });
  await run(paths.wrapper, ["start"]);
}

async function uninstallWindows(): Promise<void> {
  const paths = windowsPaths();
  await run(paths.wrapper, ["stop"]).catch(() => undefined);
  await run(paths.wrapper, ["uninstall"]);
}

export interface ServiceInstall {
  readonly api: string | undefined;
  readonly pair: (api: string) => Promise<void>;
  readonly paired: () => Promise<boolean>;
}

export async function installService(options: ServiceInstall): Promise<string> {
  if (!isSea())
    throw new ServiceUsageError(
      "Install the service from the released sezzlee-database-connector executable",
    );
  const pair = async () => {
    if (options.api === undefined)
      throw new ServiceUsageError(
        "service install --api <url> pairs the service",
      );
    await options.pair(options.api);
  };
  switch (process.platform) {
    case "linux":
      await installLinux(options.api);
      return `Service ${SYSTEMD_UNIT} runs as ${SERVICE_USER}; state is in ${SERVICE_HOME}.`;
    case "darwin":
      await installMac(pair, await options.paired());
      return `Launch agent ${LAUNCH_AGENT} runs while you are logged in.`;
    case "win32":
      await installWindows(pair, options.paired);
      return `Windows service ${WINDOWS_SERVICE} runs as NT SERVICE\\${WINDOWS_SERVICE}; state is in ${windowsPaths().data}.`;
    default:
      throw new ServiceUsageError(`No service support on ${process.platform}`);
  }
}

export async function uninstallService(): Promise<string> {
  switch (process.platform) {
    case "linux":
      await uninstallLinux();
      return `Service removed. Its state stays in ${SERVICE_HOME}; delete it to forget this connector.`;
    case "darwin":
      await uninstallMac();
      return "Launch agent removed. The connector's state stays in ~/.sezzlee.";
    case "win32":
      await uninstallWindows();
      return `Service removed. Its state stays in ${windowsPaths().data}; delete it to forget this connector.`;
    default:
      throw new ServiceUsageError(`No service support on ${process.platform}`);
  }
}

const LOOPBACK_NAMES = new Set(["localhost"]);

/**
 * Strips IPv6 brackets, an IPv6 zone suffix and a trailing root dot, and lowers
 * the case.
 *
 * Guard: the trailing dot is removed because `localhost.` is a valid absolute
 * name that resolves exactly like `localhost` while comparing unequal to it.
 *
 * @param hostname a url's `hostname`, in whatever form the parser produced
 * @returns the bare host to compare against
 */
export function bareHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/%.*$/u, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

function octetsOf(host: string): readonly number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) =>
    /^\d{1,3}$/u.test(part) ? Number(part) : -1,
  );

  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets
    : undefined;
}

/**
 * Expands an IPv6 literal into its eight groups.
 *
 * Guard: the literal is parsed rather than matched as text. A url parser
 * rewrites `::ffff:10.0.0.5` to `::ffff:a00:5`, so a prefix comparison against
 * the dotted form reads a mapped private address as public.
 *
 * @param host a bare IPv6 literal, with an optional trailing dotted IPv4 part
 * @returns eight 16-bit groups, or `undefined` when the text is not IPv6
 */
export function ipv6Groups(host: string): readonly number[] | undefined {
  if (!host.includes(":")) {
    return undefined;
  }

  const [head = "", tail, extra] = host.split("::");
  if (extra !== undefined) {
    return undefined;
  }

  const expand = (part: string): number[] | undefined => {
    if (part === "") {
      return [];
    }

    const pieces = part.split(":");
    const last = pieces[pieces.length - 1] ?? "";
    const trailing = octetsOf(last);
    if (trailing !== undefined) {
      pieces.pop();
      pieces.push(
        (((trailing[0] ?? 0) << 8) | (trailing[1] ?? 0)).toString(16),
        (((trailing[2] ?? 0) << 8) | (trailing[3] ?? 0)).toString(16),
      );
    }

    const groups: number[] = [];
    for (const piece of pieces) {
      if (!/^[0-9a-f]{1,4}$/u.test(piece)) {
        return undefined;
      }
      groups.push(Number.parseInt(piece, 16));
    }

    return groups;
  };

  const left = expand(head);
  const right = tail === undefined ? [] : expand(tail);
  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (tail === undefined) {
    return left.length === 8 ? left : undefined;
  }

  const fill = 8 - left.length - right.length;

  return fill < 0 ? undefined : [...left, ...Array(fill).fill(0), ...right];
}

function isPrivateV4(octets: readonly number[]): boolean {
  const [first = 0, second = 0] = octets;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19)
  );
}

export function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (LOOPBACK_NAMES.has(host)) {
    return true;
  }

  const octets = octetsOf(host);
  if (octets !== undefined) {
    return octets[0] === 127;
  }

  const groups = ipv6Groups(host);

  return (
    groups !== undefined &&
    groups.slice(0, 7).every((group) => group === 0) &&
    groups[7] === 1
  );
}

/**
 * Guard: an address the platform must never be talked into reaching. The host
 * comes from whoever registers an integration, and a request this process makes
 * carries its network position — cloud instance metadata on 169.254.169.254 and
 * everything on the deployment's own private network answer it, and a public
 * client cannot.
 *
 * @param hostname a url's host or a resolved address
 * @returns whether it names an address outside the public internet
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = bareHost(hostname);
  if (LOOPBACK_NAMES.has(host)) {
    return true;
  }

  const octets = octetsOf(host);
  if (octets !== undefined) {
    return isPrivateV4(octets);
  }

  const groups = ipv6Groups(host);
  if (groups === undefined) {
    return false;
  }

  const [first = 0, second = 0] = groups;
  const embedsV4 =
    (groups.slice(0, 5).every((group) => group === 0) &&
      groups[5] === 0xffff) ||
    (first === 0x0064 && second === 0xff9b);

  if (embedsV4) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;

    return isPrivateV4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  return (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80
  );
}

/**
 * Whether a resolved address is one a hosted database connection may reach.
 *
 * Guard: stricter than `!isPrivateAddress`. Documentation, mapped, NAT64,
 * 6to4 and other special ranges are not public SQL servers, and the api and
 * the executor must refuse the same set or the user sees a generic failure
 * from the executor instead of the api's explanation.
 *
 * @param address a bare IPv4 or IPv6 literal, never a name
 */
export function isPublicUnicastAddress(address: string): boolean {
  const host = bareHost(address);
  if (isPrivateAddress(host)) {
    return false;
  }

  const octets = octetsOf(host);
  if (octets !== undefined) {
    const [first, second, third] = octets;

    return (
      !(first === 192 && second === 0 && (third === 0 || third === 2)) &&
      !(first === 198 && second === 51 && third === 100) &&
      !(first === 203 && second === 0 && third === 113)
    );
  }

  const groups = ipv6Groups(host);
  if (groups === undefined) {
    return false;
  }

  const [first = 0, second = 0] = groups;

  return (
    (first & 0xe000) === 0x2000 &&
    !(first === 0x2001 && second <= 0x1ff) &&
    !(first === 0x2001 && second === 0xdb8) &&
    first !== 0x2002
  );
}

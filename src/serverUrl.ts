const INGRESS_MARKER = "/api/hassio_ingress/";

export function ingressBasePath(pathname: string): string | undefined {
  const markerIndex = pathname.indexOf(INGRESS_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }

  const tokenStart = markerIndex + INGRESS_MARKER.length;
  const tokenEnd = pathname.indexOf("/", tokenStart);
  return tokenEnd < 0 ? `${pathname}/` : pathname.slice(0, tokenEnd + 1);
}

export function serverUrl(path: string, pathname = currentPathname()): string {
  const ingressBase = ingressBasePath(pathname);
  if (!ingressBase) {
    return path;
  }
  return `${ingressBase}${path.replace(/^\/+/, "")}`;
}

export function isIngressPath(pathname = currentPathname()): boolean {
  return ingressBasePath(pathname) !== undefined;
}

function currentPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

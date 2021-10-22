import { gzipSync } from 'fflate';

declare global {
  interface Window {
    __DEBUG_BEACON_TRANSPORTER?: boolean;
  }
}

export function createHeaders(
  headers: Record<string, string> = {},
  headerName: string | undefined,
  attempt: number,
  errorCode?: number
): Record<string, string> {
  if (!headerName || attempt < 1) return headers;
  headers[headerName] = JSON.stringify({ attempt, errorCode });
  return headers;
}

/**
 * @public
 */
export function createRequestInit({
  body,
  keepalive,
  headers,
  compress,
}: {
  body: string;
  keepalive: boolean;
  headers: Record<string, string>;
  compress: boolean;
}): RequestInit {
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.get('content-type')) {
    finalHeaders.set('content-type', 'text/plain;charset=UTF-8');
  }

  let finalBody: string | Uint8Array = body;
  if (compress && typeof TextEncoder !== 'undefined') {
    finalBody = gzipSync(new TextEncoder().encode(body));
    finalHeaders.set('content-encoding', 'gzip');
  }

  return {
    body: finalBody,
    keepalive,
    credentials: 'same-origin',
    headers: finalHeaders,
    method: 'POST',
    mode: 'cors',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function debug(...data: string[]): void {
  if (typeof window !== 'undefined' && window.__DEBUG_BEACON_TRANSPORTER) {
    console.debug('[beacon-transporter] ', ...data);
  }
}

export function logError(...data: string[]): void {
  if (typeof window !== 'undefined' && window.__DEBUG_BEACON_TRANSPORTER) {
    console.error('[beacon-transporter] ', ...data);
  }
}

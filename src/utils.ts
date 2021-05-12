export function createRequestInit({
  body,
  keepalive,
  headers
}: {
  body: string;
  keepalive: boolean;
  headers?: HeadersInit;
}): RequestInit {
  headers = new Headers(headers);
  headers.set('content-type', 'text/plain;charset=UTF-8');
  return {
    body,
    keepalive,
    credentials: 'same-origin',
    headers,
    method: 'POST',
    mode: 'cors',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function debug(...data: any[]) {
  // @ts-ignore
  if (self.__DEBUG_BEACON_TRANSPORTER) {
    console.debug('[beacon-transporter] ', ...data);
  }
}

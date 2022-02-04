export function xhr(
  url: string,
  body: string,
  headers: Record<string, string> = {}
): undefined {
  if (
    typeof window !== 'undefined' &&
    typeof window.XMLHttpRequest !== 'undefined'
  ) {
    const req = new XMLHttpRequest();
    req.open('POST', url, true);
    req.withCredentials = true;
    for (const key of Object.keys(headers)) {
      req.setRequestHeader(key, headers[key]);
    }
    req.send(body);
  }
  return;
}

export function log(message: string, ...rest: unknown[]): void {
  if (process.env.DEBUG) {
    console.log(message, ...rest);
  }
}

export function within<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new RequestTimeout(`${label} timed out. Please retry or save a recovery copy.`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
export class RequestTimeout extends Error {}

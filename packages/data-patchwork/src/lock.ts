import { spawn } from 'node:child_process';
import path from 'node:path';

// The kernel releases this lock when its pipe owner dies, including SIGKILL.
// Never delete the lock inode: deleting flock files permits two simultaneous owners.
export async function acquireWorkspaceLock(
  directory: string,
  onLost: (error: Error) => void,
): Promise<() => Promise<void>> {
  const child = spawn(
    'flock',
    [
      '--exclusive',
      '--timeout',
      '1',
      '--conflict-exit-code',
      '75',
      path.join(directory, 'workspace.lock'),
      'sh',
      '-c',
      'printf "ready\\n"; while IFS= read -r line; do :; done',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let diagnostics = '';
  let ready = false,
    releasing = false;
  child.stdin.on('error', () => {}); // Acquisition/exit reports the pipe owner's failure below.
  child.stderr.on('data', (bytes) => {
    if (diagnostics.length < 8000) diagnostics += String(bytes);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  void exited.catch(() => {});
  void exited.then(
    (code) => {
      if (ready && !releasing)
        onLost(
          new Error(`Workspace lock owner exited (${code}). Save a recovery copy and restart.`),
        );
    },
    (error: Error) => {
      if (ready && !releasing) onLost(error);
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout.off('data', receive);
        if (error) reject(error);
        else resolve();
      };
      const receive = (bytes: Buffer) => {
        output += String(bytes);
        if (output.includes('ready\n')) finish();
      };
      const timer = setTimeout(
        () => finish(new Error('Workspace lock acquisition timed out.')),
        5000,
      );
      child.stdout.on('data', receive);
      void exited.then(
        (code) =>
          finish(
            new Error(
              code === 75
                ? 'This workspace store is already open in another process. Close that instance before continuing.'
                : `Workspace locking failed (${code}): ${diagnostics}`,
            ),
          ),
        (error: Error) => finish(error),
      );
    });
  } catch (error) {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited.catch(() => {});
    throw error;
  }
  ready = true;
  let released: Promise<void> | undefined;
  return () =>
    (released ??= (async () => {
      releasing = true;
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error('Workspace lock release timed out.'));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    })());
}

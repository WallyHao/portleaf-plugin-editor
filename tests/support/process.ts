import type { ChildProcess } from 'node:child_process';

// Cleanup only: scenarios which verify shutdown must exercise normal application quit.
export async function stopProcess(child: ChildProcess, label: string) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const timer = setTimeout(
      () => finish(new Error(`${label} did not exit during cleanup.`)),
      5000,
    );
    child.once('exit', onExit);
    if (!child.kill('SIGKILL')) finish(new Error(`Could not stop ${label} during cleanup.`));
  });
}

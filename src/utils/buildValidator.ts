import { exec } from 'child_process';

export function validateBuild(workspacePath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise(resolve => {
    exec('npm run build', { cwd: workspacePath, timeout: 45000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: (stderr || stdout).trim().slice(0, 2000) });
      }
    });
  });
}

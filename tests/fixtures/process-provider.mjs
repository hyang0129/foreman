import { spawn } from 'node:child_process';
// A native-like provider with a shell in another process group. Both shell and
// child ignore TERM; cleanup has to escalate and retain the detached group.
const worker = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 120 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
worker.stdout.once('data', (data) => console.log(JSON.stringify({ provider: process.pid, shell: worker.pid, sleep: Number(data.toString().trim()) })));
process.stdin.resume();
process.stdin.on('data', (data) => { if (data.toString().trim() === 'crash') process.kill(process.pid, 'SIGKILL'); });
setInterval(() => {}, 1000);

import { attach } from 'neovim';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

async function main() {
  const sock = join(tmpdir(), 'pivi-notif-' + Date.now() + '.sock');
  const proc = spawn('nvim', ['--headless', '--listen', sock], {
    env: {...process.env, NVIM_LOG_FILE: '/dev/null'}, stdio: 'ignore'
  });
  await new Promise<void>(r => {
    const t = setInterval(() => { if (existsSync(sock)) { clearInterval(t); r(); } }, 50);
  });

  const client = await attach({ socket: sock });
  const editor = await attach({ socket: sock });
  const bufnr = await editor.call('nvim_create_buf', [false, false]) as number;
  console.log('bufnr:', bufnr);

  const received: string[] = [];
  client.on('notification', (method: string, args: unknown[]) => {
    console.log('GOT NOTIFICATION:', method, JSON.stringify(args).slice(0,60));
    received.push(method);
  });

  const ok = await client.call('nvim_buf_attach', [bufnr, false, {}]);
  console.log('nvim_buf_attach:', ok);

  await editor.call('nvim_buf_set_lines', [bufnr, 0, -1, false, ['hello world']]);
  console.log('edit done, waiting...');

  await new Promise(r => setTimeout(r, 1500));
  console.log('total notifications:', received.length, received);
  proc.kill();
}
main().catch(console.error);

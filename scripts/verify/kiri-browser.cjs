// The sealed A CLI writes its authorization URL in one message. Observe that
// message in the CLI process: piping stdout would disable its interactive model menu.
const { spawnSync } = require('node:child_process');

const write = process.stdout.write;
const prompt = 'Open this URL to sign in:\n';
process.stdout.write = function (chunk, ...args) {
  if (typeof chunk !== 'string' || !chunk.startsWith(prompt)) {
    return write.call(this, chunk, ...args);
  }
  process.stdout.write = write;
  const url = chunk.slice(prompt.length).trimEnd();
  // The existing gateway launcher validates the issuer and authorization path
  // and opens Chrome/Edge with the lab's own profile and leaf certificate.
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "& './Open-Browser.ps1' -Url ([Console]::In.ReadLine())"], {
    cwd: process.env.EMRANK_A_BROWSER_DIR,
    input: url + '\n',
    stdio: ['pipe', 'ignore', 'inherit'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('未能打开本地登录页。请确认已安装 Chrome 或 Edge，再重新运行登录命令。');
  }
  return write.call(this, '已请求打开本地登录页。请在浏览器中授权，然后回到此终端。\n', ...args);
};

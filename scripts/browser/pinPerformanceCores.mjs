import { execFileSync } from 'node:child_process';

// Windows schedules a headless (background) browser onto the i7-13700KF's
// efficiency cores at will, which doubles every CPU number from one run to the
// next. A played game is a foreground window on the performance cores, so the
// captures are pinned there. The default mask is the 8 hyper-threaded P-cores
// (logical processors 0-15). Call after the page has loaded, once the renderer
// and GPU processes exist.
export const P_CORE_MASK = '0xFFFF';

export function resolvePinMask(argv = process.argv) {
  if (argv.includes('--no-pin') || process.platform !== 'win32') return null;
  return argv.find(arg => arg.startsWith('--pin='))?.split('=')[1] ?? P_CORE_MASK;
}

// Pins this browser's own processes (as Chrome itself lists them) and nothing
// else: other sessions may be running their own Playwright browsers here.
export async function pinBrowserToCores(browser, mask) {
  if (!mask) return null;
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(mask)) throw new Error('pin mask must be a number, e.g. 0xFFFF');
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  await session.detach();
  const ids = processInfo.map(info => Number(info.id)).filter(id => Number.isInteger(id) && id > 0);
  const script = [
    `$ids = @(${ids.join(',')})`,
    `$n = 0; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).ProcessorAffinity = ${mask}; $n++ } catch {} }`,
    // Browsers of other sessions share the GPU and skew GPU timings; count them.
    '$others = @(Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -match \'playwright\' -and $ids -notcontains [int]$_.ProcessId }).Count',
    '"$n $others"',
  ].join('; ');
  const [processes, foreign] = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    .trim().split(/\s+/).map(Number);
  if (foreign > 0) console.warn(`WARNING: ${foreign} other Playwright browser processes are running; GPU timings will be skewed.`);
  return { mask, processes, foreignBrowserProcesses: foreign };
}

param(
  [string]$MonitorUrl = 'http://127.0.0.1:47831',
  [string]$MutexName = 'Local\CodexLimitsMonitorTray',
  [switch]$VerifyIcons
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ('CodexMonitor.NativeIconMethods' -as [type])) {
  Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
namespace CodexMonitor {
  public static class NativeIconMethods {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr handle);
  }
  public sealed class ConsoleLineReader {
    private readonly ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
    public bool Ended { get; private set; }
    public void Start() {
      var thread = new Thread(() => {
        string line;
        while ((line = Console.In.ReadLine()) != null) lines.Enqueue(line);
        Ended = true;
      });
      thread.IsBackground = true;
      thread.Start();
    }
    public bool TryRead(out string line) { return lines.TryDequeue(out line); }
  }
}
'@
}

function New-StatusIcon([string]$ColorName) {
  $colors = @{
    gray = '#7D8794'
    green = '#42D392'
    yellow = '#F2C14E'
    red = '#EF6461'
  }
  if (-not $colors.ContainsKey($ColorName)) { throw "Unknown tray color: $ColorName" }
  $bitmap = [System.Drawing.Bitmap]::new(32, 32)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($colors[$ColorName]))
  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(235, 245, 255), 2)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.FillEllipse($brush, 3, 3, 26, 26)
    $graphics.DrawEllipse($pen, 3, 3, 26, 26)
    $handle = $bitmap.GetHicon()
    try { return [System.Drawing.Icon]([System.Drawing.Icon]::FromHandle($handle).Clone()) }
    finally { [void][CodexMonitor.NativeIconMethods]::DestroyIcon($handle) }
  } finally {
    $pen.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$icons = @{}
foreach ($name in @('gray', 'green', 'yellow', 'red')) { $icons[$name] = New-StatusIcon $name }

if ($VerifyIcons) {
  [Console]::Out.WriteLine((@{ event = 'icons-verified'; colors = @('gray', 'green', 'yellow', 'red') } | ConvertTo-Json -Compress))
  foreach ($icon in $icons.Values) { $icon.Dispose() }
  exit 0
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
  [Console]::Out.WriteLine('{"event":"duplicate"}')
  foreach ($icon in $icons.Values) { $icon.Dispose() }
  $mutex.Dispose()
  exit 0
}

$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$refreshItem = [System.Windows.Forms.ToolStripMenuItem]::new('Actualizar ahora')
$openItem = [System.Windows.Forms.ToolStripMenuItem]::new('Abrir monitor')
$exitItem = [System.Windows.Forms.ToolStripMenuItem]::new('Salir')
[void]$menu.Items.Add($refreshItem)
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($exitItem)

$script:cleaned = $false
function Send-TrayEvent([hashtable]$Event) {
  [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
function Open-Monitor {
  Start-Process -FilePath $MonitorUrl | Out-Null
}
function Close-Tray {
  if ($script:cleaned) { return }
  $script:cleaned = $true
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $menu.Dispose()
  foreach ($icon in $icons.Values) { $icon.Dispose() }
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

$notifyIcon.Icon = $icons.gray
$notifyIcon.Text = 'Codex 5H: sin datos'
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Visible = $true
$notifyIcon.add_MouseClick({
  param($sender, $eventArgs)
  if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Monitor }
})
$refreshItem.add_Click({ Send-TrayEvent @{ event = 'refresh' } })
$openItem.add_Click({ Open-Monitor })
$exitItem.add_Click({ Send-TrayEvent @{ event = 'exit' }; Close-Tray })

$lineReader = [CodexMonitor.ConsoleLineReader]::new()
$lineReader.Start()
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 200
$timer.add_Tick({
  $line = $null
  while ($lineReader.TryRead([ref]$line)) {
    try {
      $message = $line | ConvertFrom-Json
      if ($message.type -eq 'state' -and $icons.ContainsKey([string]$message.color)) {
        $tooltip = [string]$message.tooltip
        if ($tooltip.Length -gt 63) { $tooltip = $tooltip.Substring(0, 63) }
        $notifyIcon.Icon = $icons[[string]$message.color]
        $notifyIcon.Text = $tooltip
        Send-TrayEvent @{ event = 'state-applied'; color = [string]$message.color; tooltip = $tooltip }
      } elseif ($message.type -eq 'exit') {
        Close-Tray
        return
      }
    } catch {
      Send-TrayEvent @{ event = 'invalid-command' }
    }
  }
  if ($lineReader.Ended) { Close-Tray }
})
$timer.Start()
Send-TrayEvent @{ event = 'ready' }
try { [System.Windows.Forms.Application]::Run() }
finally { $timer.Dispose(); Close-Tray }

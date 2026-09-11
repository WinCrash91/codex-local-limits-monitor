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
$chartForm = [System.Windows.Forms.Form]::new()
$chartPanel = [System.Windows.Forms.Panel]::new()
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$chartWord = 'gr' + ([char]0x00E1) + 'fico'
$pinItem = [System.Windows.Forms.ToolStripMenuItem]::new(('Fijar ' + $chartWord + ' en pantalla'))
$refreshItem = [System.Windows.Forms.ToolStripMenuItem]::new('Actualizar ahora')
$openItem = [System.Windows.Forms.ToolStripMenuItem]::new('Abrir monitor')
$exitItem = [System.Windows.Forms.ToolStripMenuItem]::new('Salir')
[void]$menu.Items.Add($pinItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($refreshItem)
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($exitItem)

$script:cleaned = $false
$script:history = @()
$script:lastMousePosition = $null
$script:hoverStartedAt = $null
$script:chartVisible = $false
$script:chartPinned = $false
$script:draggingChart = $false
$script:dragOffset = [System.Drawing.Point]::Empty

function Hide-Chart([switch]$Force) {
  if ($script:chartPinned -and -not $Force) { return }
  if ($script:chartVisible) { $chartForm.Hide(); $script:chartVisible = $false }
}
function Show-Chart {
  if (-not $script:chartVisible) {
    $position = if ($script:lastMousePosition) { $script:lastMousePosition } else { [System.Windows.Forms.Cursor]::Position }
    $area = [System.Windows.Forms.Screen]::FromPoint($position).WorkingArea
    $x = [Math]::Min([Math]::Max($area.Left, $position.X - [Math]::Floor($chartForm.Width / 2)), $area.Right - $chartForm.Width)
    $y = [Math]::Max($area.Top, $position.Y - $chartForm.Height - 10)
    $chartForm.Location = [System.Drawing.Point]::new($x, $y)
    $chartForm.Show()
    $script:chartVisible = $true
  }
  $chartPanel.Invalidate()
}
function Paint-Chart([System.Object]$sender, [System.Windows.Forms.PaintEventArgs]$eventArgs) {
  $graphics = $eventArgs.Graphics
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#17202B'))
  $font = [System.Drawing.Font]::new('Segoe UI', 8)
  $titleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 9)
  $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#DCE7F2'))
  $mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#8FA1B5'))
  $gridPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#34445A'), 1)
  $fivePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#42D392'), 2)
  $weekPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#72A7FF'), 2)
  $fiveBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#42D392'))
  $weekBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#72A7FF'))
  try {
    $chartTitle = ([char]0x00DA) + 'ltimos 60 minutos'
    $graphics.DrawString($chartTitle, $titleFont, $textBrush, 10, 8)
    $left = 28; $top = 31; $right = $chartPanel.Width - 10; $bottom = $chartPanel.Height - 22
    foreach ($fraction in @(0, .5, 1)) {
      $y = $top + (($bottom - $top) * $fraction)
      $graphics.DrawLine($gridPen, $left, $y, $right, $y)
    }
    $cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - (60 * 60 * 1000)
    $samples = @($script:history | Where-Object {
      try { ([DateTimeOffset]::Parse([string]$_.collectedAt)).ToUnixTimeMilliseconds() -ge $cutoff } catch { $false }
    } | Sort-Object { [DateTimeOffset]::Parse([string]$_.collectedAt) })
    if ($samples.Count -lt 1) {
      $graphics.DrawString('Esperando datos...', $font, $mutedBrush, 94, 70)
      return
    }
    $start = $cutoff; $end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    function Point-For($sample, [string]$field) {
      $time = [DateTimeOffset]::Parse([string]$sample.collectedAt).ToUnixTimeMilliseconds()
      $value = [double]$sample.$field
      $px = $left + (($time - $start) / [double]($end - $start)) * ($right - $left)
      $py = $bottom - ($value / 100) * ($bottom - $top)
      return [System.Drawing.PointF]::new([float]$px, [float]$py)
    }
    foreach ($fieldAndPen in @(@('fiveHourRemainingPercent', $fivePen), @('weeklyRemainingPercent', $weekPen))) {
      $points = @($samples | ForEach-Object { Point-For $_ $fieldAndPen[0] })
      if ($points.Count -gt 1) { $graphics.DrawLines($fieldAndPen[1], $points) }
      elseif ($points.Count -eq 1) { $graphics.FillEllipse([System.Drawing.Brushes]::White, $points[0].X - 2, $points[0].Y - 2, 4, 4) }
    }
    $graphics.DrawString('5H', $font, $fiveBrush, 10, $chartPanel.Height - 18)
    $graphics.DrawString('Semanal', $font, $weekBrush, 42, $chartPanel.Height - 18)
  } finally {
    $weekBrush.Dispose(); $fiveBrush.Dispose(); $weekPen.Dispose(); $fivePen.Dispose(); $gridPen.Dispose(); $mutedBrush.Dispose(); $textBrush.Dispose(); $titleFont.Dispose(); $font.Dispose()
  }
}
$chartForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$chartForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$chartForm.ShowInTaskbar = $false
$chartForm.TopMost = $true
$chartForm.Width = 300; $chartForm.Height = 150
$chartForm.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#17202B')
$chartForm.Controls.Add($chartPanel)
$chartPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$chartPanel.add_Paint({ param($sender, $eventArgs) Paint-Chart $sender $eventArgs })
$chartPanel.add_MouseDown({
  param($sender, $eventArgs)
  if ($script:chartPinned -and $eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $cursor = [System.Windows.Forms.Cursor]::Position
    $script:dragOffset = [System.Drawing.Point]::new($cursor.X - $chartForm.Left, $cursor.Y - $chartForm.Top)
    $script:draggingChart = $true
    $chartPanel.Cursor = [System.Windows.Forms.Cursors]::SizeAll
  }
})
$chartPanel.add_MouseMove({
  if (-not $script:draggingChart) { return }
  $cursor = [System.Windows.Forms.Cursor]::Position
  $area = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
  $x = [Math]::Min([Math]::Max($area.Left, $cursor.X - $script:dragOffset.X), $area.Right - $chartForm.Width)
  $y = [Math]::Min([Math]::Max($area.Top, $cursor.Y - $script:dragOffset.Y), $area.Bottom - $chartForm.Height)
  $chartForm.Location = [System.Drawing.Point]::new($x, $y)
})
$chartPanel.add_MouseUp({
  if ($script:draggingChart) {
    $script:draggingChart = $false
    $chartPanel.Cursor = [System.Windows.Forms.Cursors]::Default
  }
})
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
  Hide-Chart -Force
  $chartForm.Dispose()
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
$notifyIcon.add_MouseMove({
  $script:lastMousePosition = [System.Windows.Forms.Cursor]::Position
  $script:hoverStartedAt = [DateTime]::UtcNow
})
$pinItem.add_Click({
  $script:chartPinned = -not $script:chartPinned
  $pinItem.Checked = $script:chartPinned
  $pinItem.Text = if ($script:chartPinned) { 'Desfijar ' + $chartWord } else { 'Fijar ' + $chartWord + ' en pantalla' }
  $script:hoverStartedAt = $null
  if ($script:chartPinned) { Show-Chart } else { Hide-Chart }
})
$refreshItem.add_Click({ Send-TrayEvent @{ event = 'refresh' } })
$openItem.add_Click({ Open-Monitor })
$exitItem.add_Click({ Send-TrayEvent @{ event = 'exit' }; Close-Tray })

$lineReader = [CodexMonitor.ConsoleLineReader]::new()
$lineReader.Start()
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
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
        $script:history = @($message.history)
        if ($script:chartVisible) { $chartPanel.Invalidate() }
        Send-TrayEvent @{ event = 'state-applied'; color = [string]$message.color; tooltip = $tooltip }
      } elseif ($message.type -eq 'exit') {
        Close-Tray
        return
      }
    } catch {
      Send-TrayEvent @{ event = 'invalid-command' }
    }
  }
  if (-not $script:chartPinned -and $script:hoverStartedAt -and $script:lastMousePosition) {
    $currentPosition = [System.Windows.Forms.Cursor]::Position
    $moved = [Math]::Abs($currentPosition.X - $script:lastMousePosition.X) -gt 3 -or [Math]::Abs($currentPosition.Y - $script:lastMousePosition.Y) -gt 3
    if ($moved) { Hide-Chart; $script:hoverStartedAt = $null }
    elseif (-not $script:chartVisible -and (([DateTime]::UtcNow - $script:hoverStartedAt).TotalMilliseconds -ge 700)) { Show-Chart }
  }
  if ($lineReader.Ended) { Close-Tray }
})
$timer.Start()
Send-TrayEvent @{ event = 'ready' }
try { [System.Windows.Forms.Application]::Run() }
finally { $timer.Dispose(); Close-Tray }

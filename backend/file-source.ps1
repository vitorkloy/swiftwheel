Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class VorFileSource {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string NameAt(int x, int y) {
    IntPtr hwnd = WindowFromPoint(new POINT { x = x, y = y });
    if (hwnd == IntPtr.Zero) return "";
    IntPtr root = GetAncestor(hwnd, 2);
    IntPtr target = root == IntPtr.Zero ? hwnd : root;
    uint pid;
    GetWindowThreadProcessId(target, out pid);
    if (pid == 0) return "";
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    var buf = new StringBuilder(1024);
    int size = buf.Capacity;
    bool ok = QueryFullProcessImageNameW(h, 0, buf, ref size);
    CloseHandle(h);
    if (!ok) return "";
    string full = buf.ToString();
    int slash = full.LastIndexOf('\\');
    return slash >= 0 ? full.Substring(slash + 1) : full;
  }
}
"@
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -lt 2) { Write-Output ""; [Console]::Out.Flush(); continue }
  $x = 0; $y = 0
  [void][int]::TryParse($parts[0], [ref]$x)
  [void][int]::TryParse($parts[1], [ref]$y)
  try { Write-Output ([VorFileSource]::NameAt($x, $y)) } catch { Write-Output "" }
  [Console]::Out.Flush()
}

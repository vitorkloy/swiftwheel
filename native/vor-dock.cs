// vor-dock: helper nativo da Dock do SwiftWheel (Windows).
// Fora de escopo: injetar no explorer.exe, reservar AppBar, ou engolir Win+número.
// - Esconde/restaura Shell_TrayWnd (e Shell_SecondaryTrayWnd) só com ShowWindow.
// - WH_MOUSE_LL só com auto-hide: emite edge in/out, sem poll do cursor.
// - Se o processo pai morrer (WaitForSingleObject no PID), a barra volta sozinha.
// - WTS_SESSION_LOCK / disconnect restauram; unlock volta a esconder se ainda armado.
// Protocolo (linhas UTF-8):
//   stdin  parent <pid> | arm 0|1 | edge bottom|left|right|off | slop <px>
//          hwnd <n> | hostrect <x> <y> <w> <h> | list | pins | activate <hwnd>
//          close <hwnd> | status | quit
//   stdout ready | edge in|out <mx> <my> <mw> <mh> <cx> <cy>
//          win <hwnd> <pid> <path> | title <hwnd> <text> | wins-end
//          pin <path> | pin-label <text> | pins-end
//          status vol=.. mute=.. battery=.. ac=.. online=.. hasbatt=..
//          lock | unlock | gone | log <txt>
// argv "restore": mostra a barra e sai (recuperação se o helper anterior morreu).
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class VorDock
{
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string title);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint ga);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetModuleHandle(string n);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT pt);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] buffer, int count, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern bool SetConsoleOutputCP(uint cp);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCP(uint cp);
    [DllImport("wtsapi32.dll")] static extern bool WTSRegisterSessionNotification(IntPtr h, int flags);
    [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveOutGetVolume(IntPtr h, out uint vol);
    [DllImport("wininet.dll")] static extern bool InternetGetConnectedState(out int flags, int reserved);

    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_POWER_STATUS
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte Reserved1;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr l);

    const int SW_HIDE = 0;
    const int SW_SHOW = 5;
    const int SW_RESTORE = 9;
    const int WH_MOUSE_LL = 14;
    const int WM_CLOSE = 0x0010;
    const int WM_WTSSESSION_CHANGE = 0x02B1;
    const int WM_POWERBROADCAST = 0x0218;
    const int WTS_CONSOLE_CONNECT = 0x1;
    const int WTS_CONSOLE_DISCONNECT = 0x2;
    const int WTS_REMOTE_CONNECT = 0x3;
    const int WTS_REMOTE_DISCONNECT = 0x4;
    const int WTS_SESSION_LOCK = 0x7;
    const int WTS_SESSION_UNLOCK = 0x8;
    const int NOTIFY_FOR_THIS_SESSION = 0;
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const uint SYNCHRONIZE = 0x00100000;
    const uint PROCESS_QUERY_LIMITED = 0x1000;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_APPWINDOW = 0x00040000;
    const uint GA_ROOTOWNER = 3;
    const int DWMWA_CLOAKED = 14;

    static readonly object outLock = new object();
    static IntPtr stdoutHandle;
    static readonly UTF8Encoding utf8 = new UTF8Encoding(false);
    static StreamReader input;
    static volatile bool armed;
    static volatile bool edgeWatch;
    static string edgeSide = "bottom";
    static int slop = 2;
    static IntPtr dockHwnd = IntPtr.Zero;
    static RECT hostRect;
    static bool hostRectSet;
    static IntPtr mouseHook = IntPtr.Zero;
    static HookProc mouseProc = MouseCallback;
    static uint hookThread;
    static bool edgeInside;
    static HiddenForm form;
    static int parentPid;

    static void Emit(string s)
    {
        lock (outLock)
        {
            try
            {
                byte[] bytes = utf8.GetBytes(s + "\n");
                int written;
                WriteFile(stdoutHandle, bytes, bytes.Length, out written, IntPtr.Zero);
            }
            catch { }
        }
    }

    static string Clean(string s)
    {
        if (s == null) return "";
        return s.Replace("\r", " ").Replace("\n", " ");
    }

    [STAThread]
    static void Main(string[] args)
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware(); }
        catch { try { SetProcessDPIAware(); } catch { } }

        AppDomain.CurrentDomain.UnhandledException += delegate { RestoreTray(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { RestoreTray(); };

        if (args != null && args.Length > 0 && string.Equals(args[0], "restore", StringComparison.OrdinalIgnoreCase))
        {
            RestoreTray();
            return;
        }

        try { SetConsoleOutputCP(65001); SetConsoleCP(65001); } catch { }
        stdoutHandle = GetStdHandle(-11);
        input = new StreamReader(Console.OpenStandardInput(), utf8);

        Application.EnableVisualStyles();
        form = new HiddenForm();
        IntPtr hwnd = form.Handle;
        try { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION); } catch { }

        Thread hook = new Thread(HookLoop);
        hook.IsBackground = true;
        hook.Name = "mouse";
        hook.Start();

        Thread reader = new Thread(ReadLoop);
        reader.IsBackground = true;
        reader.Name = "stdin";
        reader.Start();

        Emit("ready");
        Application.Run(form);
        RestoreTray();
    }

    static void ReadLoop()
    {
        try
        {
            string line;
            while ((line = input.ReadLine()) != null)
            {
                string l = line.Trim();
                if (l.Length == 0) continue;
                string cmd = l, arg = "";
                int sp = l.IndexOf(' ');
                if (sp > 0) { cmd = l.Substring(0, sp); arg = l.Substring(sp + 1).Trim(); }
                if (cmd == "parent") WatchParent(arg);
                else if (cmd == "arm") SetArmed(arg == "1");
                else if (cmd == "edge") SetEdge(arg);
                else if (cmd == "slop")
                {
                    int n;
                    if (int.TryParse(arg, out n) && n >= 0 && n <= 40) slop = n;
                }
                else if (cmd == "hwnd")
                {
                    long n;
                    if (long.TryParse(arg, out n)) dockHwnd = new IntPtr(n);
                }
                else if (cmd == "hostrect") ParseHostRect(arg);
                else if (cmd == "list") form.BeginInvoke((Action)EmitWindows);
                else if (cmd == "pins") form.BeginInvoke((Action)EmitPins);
                else if (cmd == "activate") ActivateHwnd(arg);
                else if (cmd == "close") CloseHwnd(arg);
                else if (cmd == "status") EmitStatus();
                else if (cmd == "lock") OnSessionLock();
                else if (cmd == "unlock") OnSessionUnlock();
                else if (cmd == "quit") break;
            }
        }
        catch { }
        RestoreTray();
        try { Application.Exit(); } catch { Environment.Exit(0); }
    }

    static void WatchParent(string arg)
    {
        int pid;
        if (!int.TryParse(arg, out pid) || pid <= 0) return;
        parentPid = pid;
        IntPtr h = OpenProcess(SYNCHRONIZE, false, pid);
        if (h == IntPtr.Zero) return;
        Thread t = new Thread(delegate()
        {
            WaitForSingleObject(h, uint.MaxValue);
            RestoreTray();
            Emit("gone");
            try { Application.Exit(); } catch { Environment.Exit(0); }
        });
        t.IsBackground = true;
        t.Name = "parent";
        t.Start();
    }

    static void SetArmed(bool value)
    {
        armed = value;
        if (value) HideTray();
        else RestoreTray();
    }

    static void SetEdge(string arg)
    {
        string side = (arg ?? "").Trim().ToLowerInvariant();
        if (side == "off" || side.Length == 0)
        {
            edgeWatch = false;
            edgeInside = false;
            return;
        }
        if (side == "left" || side == "right" || side == "bottom") edgeSide = side;
        edgeWatch = true;
    }

    static void ParseHostRect(string arg)
    {
        string[] p = (arg ?? "").Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (p.Length < 4) { hostRectSet = false; return; }
        int x, y, w, h;
        if (!int.TryParse(p[0], out x) || !int.TryParse(p[1], out y) || !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h))
        {
            hostRectSet = false;
            return;
        }
        hostRect.left = x;
        hostRect.top = y;
        hostRect.right = x + w;
        hostRect.bottom = y + h;
        hostRectSet = w > 0 && h > 0;
    }

    static void HideTray()
    {
        SetTrayVisible(false);
    }

    static void RestoreTray()
    {
        SetTrayVisible(true);
    }

    static void SetTrayVisible(bool show)
    {
        int cmd = show ? SW_SHOW : SW_HIDE;
        IntPtr tray = FindWindow("Shell_TrayWnd", null);
        if (tray != IntPtr.Zero) ShowWindow(tray, cmd);
        IntPtr sec = IntPtr.Zero;
        while (true)
        {
            sec = FindWindowEx(IntPtr.Zero, sec, "Shell_SecondaryTrayWnd", null);
            if (sec == IntPtr.Zero) break;
            ShowWindow(sec, cmd);
        }
    }

    static void OnSessionLock()
    {
        RestoreTray();
        Emit("lock");
    }

    static void OnSessionUnlock()
    {
        Emit("unlock");
        if (armed) HideTray();
    }

    static void HookLoop()
    {
        hookThread = GetCurrentThreadId();
        mouseProc = MouseCallback;
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
        if (mouseHook == IntPtr.Zero) Emit("log hook-fail " + Marshal.GetLastWin32Error());
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static IntPtr MouseCallback(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0 && edgeWatch)
        {
            MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
            ConsiderPoint(info.pt);
        }
        return CallNextHookEx(mouseHook, code, w, l);
    }

    static void ConsiderPoint(POINT pt)
    {
        RECT mon;
        if (!MonitorRectAt(pt, out mon)) return;
        bool onEdge = false;
        if (edgeSide == "left") onEdge = pt.x <= mon.left + slop;
        else if (edgeSide == "right") onEdge = pt.x >= mon.right - 1 - slop;
        else onEdge = pt.y >= mon.bottom - 1 - slop;

        bool inHost = hostRectSet
            && pt.x >= hostRect.left && pt.x < hostRect.right
            && pt.y >= hostRect.top && pt.y < hostRect.bottom;
        bool inside = onEdge || inHost;
        if (inside == edgeInside) return;
        edgeInside = inside;
        string kind = inside ? "in" : "out";
        Emit("edge " + kind + " " + mon.left + " " + mon.top + " " + (mon.right - mon.left) + " " + (mon.bottom - mon.top) + " " + pt.x + " " + pt.y);
    }

    static bool MonitorRectAt(POINT pt, out RECT mon)
    {
        mon = new RECT();
        IntPtr h = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if (h == IntPtr.Zero) return false;
        MONITORINFO info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(h, ref info)) return false;
        mon = info.rcMonitor;
        return true;
    }

    static void EmitWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!ShouldListWindow(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string path = ProcessPath((int)pid);
            Emit("win " + h.ToInt64() + " " + pid + " " + Clean(path));
            StringBuilder title = new StringBuilder(512);
            GetWindowText(h, title, title.Capacity);
            Emit("title " + h.ToInt64() + " " + Clean(title.ToString()));
            return true;
        }, IntPtr.Zero);
        Emit("wins-end");
    }

    static bool ShouldListWindow(IntPtr h)
    {
        if (h == IntPtr.Zero || h == dockHwnd) return false;
        if (!IsWindowVisible(h)) return false;
        if (GetAncestor(h, GA_ROOTOWNER) != h) return false;
        int cloaked;
        if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false;
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0) return false;
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, cls.Capacity);
        string c = cls.ToString();
        if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW") return false;
        if (c == "NotifyIconOverflowWindow" || c == "Windows.UI.Core.CoreWindow") return false;
        StringBuilder title = new StringBuilder(512);
        GetWindowText(h, title, title.Capacity);
        if (title.Length == 0) return false;
        return true;
    }

    static string ProcessPath(int pid)
    {
        if (pid <= 0) return "";
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            int size = sb.Capacity;
            if (QueryFullProcessImageName(h, 0, sb, ref size)) return sb.ToString();
        }
        catch { }
        finally { CloseHandle(h); }
        return "";
    }

    static void EmitPins()
    {
        try
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string dir = Path.Combine(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
            if (!Directory.Exists(dir))
            {
                Emit("pins-end");
                return;
            }
            string[] files = Directory.GetFiles(dir, "*.lnk");
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = shellType != null ? Activator.CreateInstance(shellType) : null;
            for (int i = 0; i < files.Length; i++)
            {
                string file = files[i];
                string label = Path.GetFileNameWithoutExtension(file);
                string target = file;
                if (shell != null)
                {
                    try
                    {
                        object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { file });
                        object pathObj = lnk.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, lnk, null);
                        string resolved = pathObj as string;
                        if (!string.IsNullOrEmpty(resolved)) target = resolved;
                    }
                    catch { }
                }
                Emit("pin " + Clean(target));
                Emit("pin-label " + Clean(label));
            }
        }
        catch (Exception ex)
        {
            Emit("log pins " + Clean(ex.Message));
        }
        Emit("pins-end");
    }

    static void ActivateHwnd(string arg)
    {
        long n;
        if (!long.TryParse(arg, out n)) return;
        IntPtr h = new IntPtr(n);
        form.BeginInvoke((Action)delegate
        {
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            uint fgPid;
            uint fgTid = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
            uint thisTid = GetCurrentThreadId();
            if (fgTid != 0 && fgTid != thisTid) AttachThreadInput(thisTid, fgTid, true);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (fgTid != 0 && fgTid != thisTid) AttachThreadInput(thisTid, fgTid, false);
        });
    }

    static void CloseHwnd(string arg)
    {
        long n;
        if (!long.TryParse(arg, out n)) return;
        PostMessage(new IntPtr(n), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    static void EmitStatus()
    {
        uint volRaw;
        waveOutGetVolume(IntPtr.Zero, out volRaw);
        int left = (int)(volRaw & 0xFFFF);
        int pct = (int)Math.Round(left * 100.0 / 0xFFFF);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        SYSTEM_POWER_STATUS power;
        GetSystemPowerStatus(out power);
        bool hasBatt = (power.BatteryFlag & 128) == 0;
        int batt = power.BatteryLifePercent;
        if (batt > 100) batt = 100;
        int flags;
        bool online = InternetGetConnectedState(out flags, 0);
        Emit("status vol=" + pct + " mute=" + (pct == 0 ? 1 : 0) + " battery=" + batt + " ac=" + (power.ACLineStatus == 1 ? 1 : 0) + " online=" + (online ? 1 : 0) + " hasbatt=" + (hasBatt ? 1 : 0));
    }

    sealed class HiddenForm : Form
    {
        public HiddenForm()
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            Opacity = 0;
            Width = 1;
            Height = 1;
            StartPosition = FormStartPosition.Manual;
            Location = new System.Drawing.Point(-32000, -32000);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_WTSSESSION_CHANGE)
            {
                int w = m.WParam.ToInt32();
                if (w == WTS_SESSION_LOCK || w == WTS_CONSOLE_DISCONNECT || w == WTS_REMOTE_DISCONNECT)
                    OnSessionLock();
                else if (w == WTS_SESSION_UNLOCK || w == WTS_CONSOLE_CONNECT || w == WTS_REMOTE_CONNECT)
                    OnSessionUnlock();
            }
            else if (m.Msg == WM_POWERBROADCAST)
            {
                EmitStatus();
            }
            base.WndProc(ref m);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            try { WTSUnRegisterSessionNotification(Handle); } catch { }
            RestoreTray();
            base.OnFormClosed(e);
        }
    }
}

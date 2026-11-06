// vor-capture: helper nativo da captura do VOR (Windows).
// - Atalhos via WH_KEYBOARD_LL numa thread própria que responde na hora (sem ida e volta ao Node),
//   então o Windows nunca remove o hook por LowLevelHooksTimeout.
// - Congela a tela com BitBlt (GDI) do desktop virtual inteiro, em pixels físicos (Per-Monitor V2),
//   e mostra na hora uma janela topmost sem ativação que pinta exatamente esse frame 1:1.
//   O Electron abre por cima com o mesmo frame e só então esta janela some: zero salto.
// Protocolo (linhas): stdin  bind <accel>=<mode>;...  | grab <mode> | armed 0|1 | hide | quit
//                     stdout ready | shot <mode> <path> <x> <y> <w> <h> | esc | log <txt>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class VorCapture
{
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint t, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);

    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

    static readonly object outLock = new object();
    static StreamWriter output;
    static StreamReader input;
    static void Emit(string s) { lock (outLock) { try { output.Write(s + "\n"); output.Flush(); } catch { } } }

    static Dictionary<string, string> bindings = new Dictionary<string, string>();
    static volatile bool armed;
    static IntPtr hook = IntPtr.Zero;
    static HookProc hookProc = HookCallback;
    static uint hookThread;
    static readonly HashSet<uint> swallowUp = new HashSet<uint>();
    static FreezeForm form;
    static int seq;
    static int shiftAt;

    [STAThread]
    static void Main()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        output = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false));
        input = new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
        Application.EnableVisualStyles();
        form = new FreezeForm();
        var h = form.Handle; // cria o HWND agora (escondido)
        int one = 1; DwmSetWindowAttribute(h, 3, ref one, 4); // DWMWA_TRANSITIONS_FORCEDISABLED

        var t = new Thread(HookLoop) { IsBackground = true, Name = "hook" };
        t.Start();
        var r = new Thread(ReadLoop) { IsBackground = true, Name = "stdin" };
        r.Start();
        Emit("ready");
        Application.Run();
    }

    static void ReadLoop()
    {
        string line;
        try
        {
            while ((line = input.ReadLine()) != null)
            {
                string l = line.Trim(); if (l.Length == 0) continue;
                string cmd = l, arg = "";
                int sp = l.IndexOf(' '); if (sp > 0) { cmd = l.Substring(0, sp); arg = l.Substring(sp + 1).Trim(); }
                if (cmd == "bind") SetBindings(arg);
                else if (cmd == "armed") armed = arg == "1";
                else if (cmd == "grab") { string m = arg; form.BeginInvoke((Action)(() => Grab(m))); }
                else if (cmd == "hide") form.BeginInvoke((Action)HideFreeze);
                else if (cmd == "quit") break;
            }
        }
        catch { }
        Environment.Exit(0); // pai morreu ou pediu quit
    }

    static void SetBindings(string spec)
    {
        var map = new Dictionary<string, string>();
        foreach (var part in spec.Split(';'))
        {
            int eq = part.LastIndexOf('='); if (eq <= 0) continue;
            map[part.Substring(0, eq).Trim().ToLowerInvariant()] = part.Substring(eq + 1).Trim();
        }
        bindings = map;
        Emit("log bindings " + map.Count);
    }

    // ---- hook ----
    static void HookLoop()
    {
        hookThread = GetCurrentThreadId();
        Install();
        // Reinstala o hook a cada 30 s: se o Windows o tiver removido (máquina travada), volta sozinho.
        SetTimer(IntPtr.Zero, IntPtr.Zero, 30000, IntPtr.Zero);
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            if (m.msg == 0x0113) { Install(); continue; } // WM_TIMER
            TranslateMessage(ref m); DispatchMessage(ref m);
        }
    }

    static void Install()
    {
        IntPtr old = hook;
        hook = SetWindowsHookEx(13, hookProc, GetModuleHandle(null), 0);
        if (old != IntPtr.Zero) UnhookWindowsHookEx(old);
        if (hook == IntPtr.Zero) Emit("log hook-fail " + Marshal.GetLastWin32Error());
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static string KeyName(uint vk)
    {
        if (vk == 0x2C) return "printscreen";
        if (vk == 0x1B) return "escape";
        if (vk == 0x20) return "space";
        if (vk >= 0x30 && vk <= 0x5A) return ((char)vk).ToString().ToLowerInvariant();
        if (vk >= 0x70 && vk <= 0x87) return "f" + (vk - 0x6F);
        return null;
    }

    static IntPtr HookCallback(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            var k = (KBD)Marshal.PtrToStructure(l, typeof(KBD));
            int msg = w.ToInt32();
            bool isDown = msg == 0x100 || msg == 0x104;
            bool isUp = msg == 0x101 || msg == 0x105;
            if (k.vk == 0x10 || k.vk == 0xA0 || k.vk == 0xA1) { if (isDown) { if (shiftAt == 0) shiftAt = Environment.TickCount; } else if (isUp) shiftAt = 0; }
            if (isUp && swallowUp.Remove(k.vk)) return new IntPtr(1);
            if (isDown)
            {
                string key = KeyName(k.vk);
                if (key != null)
                {
                    if (key == "escape" && armed) { swallowUp.Add(k.vk); Emit("esc"); return new IntPtr(1); }
                    var parts = new List<string>();
                    if (Down(0x11)) parts.Add("commandorcontrol");
                    if (Down(0x12)) parts.Add("alt");
                    // O PrintScreen chega com um Shift fantasma (E0 2A) injetado pelo teclado; o Shift real é físico.
                    bool shift = Down(0xA0) || Down(0xA1);
                    if (k.vk == 0x2C && shiftAt != 0 && Environment.TickCount - shiftAt < 40) shift = false;
                    if (shift) parts.Add("shift");
                    if (Down(0x5B) || Down(0x5C)) parts.Add("super");
                    parts.Add(key);
                    string accel = string.Join("+", parts.ToArray());
                    string mode;
                    if (bindings.TryGetValue(accel, out mode))
                    {
                        swallowUp.Add(k.vk);
                        string m2 = mode;
                        form.BeginInvoke((Action)(() => Grab(m2)));
                        return new IntPtr(1);
                    }
                }
            }
        }
        return CallNextHookEx(hook, code, w, l);
    }


    // ---- captura ----
    static void Grab(string mode)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
            ReleaseFrame();
            IntPtr screenDc = GetDC(IntPtr.Zero);
            memDc = CreateCompatibleDC(screenDc);
            memBmp = CreateCompatibleBitmap(screenDc, w, h);
            oldBmp = SelectObject(memDc, memBmp);
            BitBlt(memDc, 0, 0, w, h, screenDc, x, y, 0x00CC0020 | 0x40000000); // SRCCOPY | CAPTUREBLT
            ReleaseDC(IntPtr.Zero, screenDc);
            long grabMs = sw.ElapsedMilliseconds;
            if (mode == "full")
            {
                using (var full = Snapshot()) Clipboard.SetImage(full);
                ReleaseFrame();
                Emit("full " + grabMs);
                return;
            }
            // Mostra o frame congelado já: posição e tamanho em pixels físicos, sem ativar; pinta com BitBlt.
            SetWindowPos(form.Handle, new IntPtr(-1), x, y, w, h, 0x0010 | 0x0040); // NOACTIVATE | SHOWWINDOW
            form.Invalidate(); form.Update();
            long shownMs = sw.ElapsedMilliseconds;
            var bmp = Snapshot();
            string dir = Path.Combine(Path.GetTempPath(), "vor-shot-frame");
            Directory.CreateDirectory(dir);
            seq++;
            string file = Path.Combine(dir, "frame-" + (seq % 2) + ".bmp");
            bmp.Save(file, ImageFormat.Bmp);
            bmp.Dispose();
            Emit("shot " + mode + " " + x + " " + y + " " + w + " " + h + " " + grabMs + " " + shownMs + " " + file);
        }
        catch (Exception e) { Emit("log grab-error " + e.Message.Replace('\n', ' ')); HideFreeze(); }
    }

    static IntPtr memDc, memBmp, oldBmp;
    // Image.FromHbitmap exige o bitmap fora de um DC: desseleciona, copia e volta a selecionar.
    static Bitmap Snapshot() { SelectObject(memDc, oldBmp); var b = Image.FromHbitmap(memBmp); SelectObject(memDc, memBmp); return b; }
    static void ReleaseFrame()
    {
        if (memDc != IntPtr.Zero) { SelectObject(memDc, oldBmp); DeleteDC(memDc); memDc = IntPtr.Zero; }
        if (memBmp != IntPtr.Zero) { DeleteObject(memBmp); memBmp = IntPtr.Zero; }
    }

    static void HideFreeze()
    {
        ShowWindow(form.Handle, 0);
        ReleaseFrame();
    }

    class FreezeForm : Form
    {
        public FreezeForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.Opaque, true);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00000080 | 0x00000008 | 0x08000000; // TOOLWINDOW | TOPMOST | NOACTIVATE
                return cp;
            }
        }
        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e)
        {
            if (memDc == IntPtr.Zero) return;
            IntPtr dc = e.Graphics.GetHdc();
            BitBlt(dc, 0, 0, ClientSize.Width, ClientSize.Height, memDc, 0, 0, 0x00CC0020);
            e.Graphics.ReleaseHdc(dc);
        }
    }
}

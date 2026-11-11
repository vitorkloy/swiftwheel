// vor-preview: helper nativo da prévia de arquivos do SwiftWheel (Windows).
// Comportamento à la QuickLook (só referência; código original, não derivado do QL-Win/GPL).
// - WH_KEYBOARD_LL numa thread própria (o Windows não tira o hook por LowLevelHooksTimeout).
// - Só engole o atalho com o Explorer ou a área de trabalho em primeiro plano,
//   e nunca com o caret a piscar / campo Edit (renomear, busca, barra de endereço).
// - O item selecionado vem da API do Shell (Shell.Application / IShellWindows).
// Protocolo (linhas UTF-8):
//   stdin  bind <accel> | armed 0|1 | pinned 0|1 | hwnd <n> | openwith <path> | quit | status
//   stdout ready | open <path> | close | next | prev | launch | openwith-done | log <txt> | status ...
// Com a prévia armada o Explorer fica com o teclado (o Windows recusa o foco à janela
// Electron). Esc/setas/Enter/Espaço são tratados aqui, não no renderer.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class VorPreview
{
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint id, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHOpenWithDialog(IntPtr hwnd, ref OPENASINFO info);

    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OPENASINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pcszFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcszClass;
        public uint oaifInFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public int left, top, right, bottom;
    }
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

    const int GUI_CARETBLINKING = 0x00000001;
    const int GUI_INMOVESIZE = 0x00000002;
    const int GUI_INMENUMODE = 0x00000004;
    const int GUI_SYSTEMMENUMODE = 0x00000008;
    const int GUI_POPUPMENUMODE = 0x00000010;
    const uint KEYEVENTF_KEYUP = 2;
    // Assinatura nas teclas que nós próprios injetamos, para o hook as deixar passar.
    static readonly UIntPtr MAGIC = new UIntPtr(0x53575056);

    static readonly object outLock = new object();
    static StreamWriter output;
    static StreamReader input;
    static void Emit(string s) { lock (outLock) { try { output.Write(s + "\n"); output.Flush(); } catch { } } }

    static string binding = "";
    static volatile bool armed;
    static volatile bool stayOpen;
    static IntPtr previewHwnd = IntPtr.Zero;
    static IntPtr hook = IntPtr.Zero;
    static HookProc hookProc = HookCallback;
    static readonly HashSet<uint> swallowUp = new HashSet<uint>();
    static readonly HashSet<uint> held = new HashSet<uint>();
    static Form form;
    static int lastKeyAt;

    [STAThread]
    static void Main()
    {
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        form = new Form();
        form.FormBorderStyle = FormBorderStyle.None;
        form.ShowInTaskbar = false;
        form.Opacity = 0;
        form.Width = 0;
        form.Height = 0;
        IntPtr unused = form.Handle;

        Thread t = new Thread(HookLoop);
        t.IsBackground = true;
        t.Name = "hook";
        t.Start();
        Thread r = new Thread(ReadLoop);
        r.IsBackground = true;
        r.Name = "stdin";
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
                string l = line.Trim();
                if (l.Length == 0) continue;
                string cmd = l, arg = "";
                int sp = l.IndexOf(' ');
                if (sp > 0) { cmd = l.Substring(0, sp); arg = l.Substring(sp + 1).Trim(); }
                if (cmd == "bind")
                {
                    binding = arg.ToLowerInvariant();
                    Emit("log bindings " + (binding.Length == 0 ? 0 : 1));
                }
                else if (cmd == "armed") armed = arg == "1";
                else if (cmd == "pinned") stayOpen = arg == "1";
                else if (cmd == "hwnd")
                {
                    long n = 0;
                    if (long.TryParse(arg, out n)) previewHwnd = new IntPtr(n);
                }
                else if (cmd == "openwith")
                {
                    string p = arg;
                    try { form.BeginInvoke((Action)(() => ShowOpenWith(p))); }
                    catch (Exception ex) { Emit("log openwith-invoke " + ex.Message); Emit("openwith-done"); }
                }
                else if (cmd == "status")
                    Emit("status hook=" + (hook != IntPtr.Zero ? 1 : 0) + " bindings=" + (binding.Length == 0 ? 0 : 1) + " lastkey=" + (lastKeyAt == 0 ? -1 : Environment.TickCount - lastKeyAt) + " armed=" + (armed ? 1 : 0));
                else if (cmd == "quit") break;
            }
        }
        catch { }
        Environment.Exit(0);
    }

    static void HookLoop()
    {
        Install();
        SetTimer(IntPtr.Zero, IntPtr.Zero, 30000, IntPtr.Zero);
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            if (m.msg == 0x0113) { Install(); continue; }
            TranslateMessage(ref m);
            DispatchMessage(ref m);
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
        if (vk == 0x20) return "space";
        if (vk == 0x1B) return "escape";
        if (vk == 0x0D) return "enter";
        if (vk == 0x25) return "left";
        if (vk == 0x26) return "up";
        if (vk == 0x27) return "right";
        if (vk == 0x28) return "down";
        if (vk >= 0x30 && vk <= 0x5A) return ((char)vk).ToString().ToLowerInvariant();
        if (vk >= 0x70 && vk <= 0x87) return "f" + (vk - 0x6F);
        return null;
    }

    // Com a prévia visível o Explorer fica em primeiro plano: estas teclas não podem ir para lá.
    static string NavCommand(uint vk)
    {
        if (vk == 0x1B) return "close";
        if (vk == 0x20) return stayOpen ? null : "close";
        if (vk == 0x0D) return "launch";
        if (vk == 0x25 || vk == 0x26) return "prev";
        if (vk == 0x27 || vk == 0x28) return "next";
        return null;
    }

    static bool IsPreviewForeground()
    {
        if (previewHwnd == IntPtr.Zero) return false;
        IntPtr fg = GetForegroundWindow();
        return fg == previewHwnd || Related(fg, previewHwnd);
    }

    static void ShowOpenWith(string filePath)
    {
        if (filePath == null || filePath.Length == 0)
        {
            Emit("openwith-done");
            return;
        }
        try
        {
            OPENASINFO info = new OPENASINFO();
            info.pcszFile = filePath;
            info.pcszClass = null;
            info.oaifInFlags = 0x00000001 | 0x00000004; // ALLOW_REGISTRATION | EXEC
            // Dono nulo: o HWND Chromium da prévia (alwaysOnTop) engolia ou escondia o diálogo.
            int hr = SHOpenWithDialog(IntPtr.Zero, ref info);
            if (hr < 0 && (hr & 0xFFFF) != 1223)
            {
                Emit("log openwith-hr " + hr);
                try
                {
                    System.Diagnostics.Process.Start("rundll32.exe", "shell32.dll,OpenAs_RunDLL \"" + filePath + "\"");
                }
                catch (Exception fallbackEx)
                {
                    Emit("log openwith-rundll " + fallbackEx.Message);
                }
            }
        }
        catch (Exception ex)
        {
            Emit("log openwith-error " + ex.Message);
        }
        Emit("openwith-done");
    }

    static string AccelOf(uint vk)
    {
        string key = KeyName(vk);
        if (key == null) return "";
        List<string> parts = new List<string>();
        if (Down(0x11)) parts.Add("commandorcontrol");
        if (Down(0x12)) parts.Add("alt");
        if (Down(0xA0) || Down(0xA1)) parts.Add("shift");
        if (Down(0x5B) || Down(0x5C)) parts.Add("super");
        parts.Add(key);
        return string.Join("+", parts.ToArray());
    }

    static string ClassName(IntPtr h)
    {
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static bool IsExplorerFrame(string cls)
    {
        return cls == "CabinetWClass" || cls == "ExploreWClass";
    }

    static bool HasDefView(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return true;
        IntPtr child = FindWindowEx(h, IntPtr.Zero, null, null);
        while (child != IntPtr.Zero)
        {
            if (ClassName(child) == "SHELLDLL_DefView" || HasDefView(child)) return true;
            child = FindWindowEx(h, child, null, null);
        }
        return false;
    }

    static bool IsDesktopHwnd(IntPtr h)
    {
        IntPtr p = h;
        for (int i = 0; i < 8 && p != IntPtr.Zero; i++)
        {
            string c = ClassName(p);
            if (c == "Progman" || c == "WorkerW") return true;
            p = GetParent(p);
        }
        return HasDefView(h) && !IsExplorerFrame(ClassName(Root(h)));
    }

    static IntPtr Root(IntPtr h)
    {
        IntPtr p = h, last = h;
        while (p != IntPtr.Zero)
        {
            last = p;
            p = GetParent(p);
        }
        return last;
    }

    static bool Related(IntPtr a, IntPtr b)
    {
        if (a == IntPtr.Zero || b == IntPtr.Zero) return false;
        if (a == b) return true;
        IntPtr p = a;
        while (p != IntPtr.Zero) { if (p == b) return true; p = GetParent(p); }
        p = b;
        while (p != IntPtr.Zero) { if (p == a) return true; p = GetParent(p); }
        return false;
    }

    static bool IsTargetForeground()
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        string cls = ClassName(fg);
        if (IsExplorerFrame(cls)) return true;
        if (IsExplorerFrame(ClassName(Root(fg)))) return true;
        if (cls == "Progman" || cls == "WorkerW") return true;
        if (IsDesktopHwnd(fg)) return true;
        IntPtr shell = GetShellWindow();
        if (shell != IntPtr.Zero && Related(fg, shell)) return true;
        return false;
    }

    // Caret a piscar = o utilizador está a escrever (renomear, busca, endereço).
    // Edit na cadeia do foco cobre o caso em que o caret ainda não começou.
    static bool IsTyping()
    {
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (!GetGUIThreadInfo(0, ref info)) return false;
        int typingFlags = GUI_CARETBLINKING | GUI_INMENUMODE | GUI_SYSTEMMENUMODE | GUI_POPUPMENUMODE | GUI_INMOVESIZE;
        if ((info.flags & typingFlags) != 0) return true;
        IntPtr h = info.hwndFocus;
        for (int i = 0; i < 6 && h != IntPtr.Zero; i++)
        {
            string c = ClassName(h);
            if (c == "Edit" || c == "RichEdit20W" || c == "RICHEDIT50W") return true;
            if (c == "ComboBox" || c == "ComboBoxEx32") return true;
            if (c.IndexOf("Search", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (c == "AutoSuggest") return true;
            h = GetParent(h);
        }
        return false;
    }

    static object Prop(object o, string name)
    {
        return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null);
    }

    static object Call(object o, string name, params object[] args)
    {
        return o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args);
    }

    static string TryFolderItemPath(object item)
    {
        if (item == null) return null;
        try
        {
            object p = Prop(item, "Path");
            if (p == null) return null;
            string s = Convert.ToString(p);
            if (s != null && s.Length > 0) return s;
        }
        catch { }
        return null;
    }

    static string PathFromDocument(object doc)
    {
        if (doc == null) return null;
        try
        {
            string focused = TryFolderItemPath(Prop(doc, "FocusedItem"));
            if (focused != null) return focused;
        }
        catch { }
        try
        {
            object sel = Call(doc, "SelectedItems");
            if (sel == null) return null;
            int n = Convert.ToInt32(Prop(sel, "Count"));
            if (n < 1) return null;
            object item = null;
            try { item = Call(sel, "Item", 0); } catch { }
            if (item == null) { try { item = Call(sel, "Item", 1); } catch { } }
            return TryFolderItemPath(item);
        }
        catch { }
        return null;
    }

    static bool WindowLooksDesktop(object w)
    {
        try
        {
            object loc = Prop(w, "LocationURL");
            string url = loc == null ? "" : Convert.ToString(loc);
            if (url == null) url = "";
            if (url.Length == 0) return true;
            if (url.IndexOf("::{", StringComparison.Ordinal) >= 0) return false;
        }
        catch { }
        return false;
    }

    static string SelectedPath()
    {
        IntPtr fg = GetForegroundWindow();
        bool desktop = IsDesktopHwnd(fg);
        Type t = Type.GetTypeFromProgID("Shell.Application");
        if (t == null) return null;
        object shell = Activator.CreateInstance(t);
        if (shell == null) return null;
        object windows = Call(shell, "Windows");
        if (windows == null) return null;
        int count = Convert.ToInt32(Prop(windows, "Count"));
        string desktopPath = null;
        for (int i = 0; i < count; i++)
        {
            object w = null;
            try { w = Call(windows, "Item", i); } catch { continue; }
            if (w == null) continue;
            IntPtr hwnd = IntPtr.Zero;
            try { hwnd = new IntPtr(Convert.ToInt32(Prop(w, "HWND"))); } catch { continue; }
            bool match = Related(fg, hwnd) || Related(Root(fg), hwnd);
            if (!match && desktop && (hwnd == GetShellWindow() || WindowLooksDesktop(w))) match = true;
            if (!match) continue;
            string path = null;
            try { path = PathFromDocument(Prop(w, "Document")); } catch { }
            if (path != null && path.Length > 0)
            {
                if (desktop && WindowLooksDesktop(w)) desktopPath = path;
                else return path;
            }
        }
        return desktopPath;
    }

    static void InjectKey(uint vk)
    {
        byte b = (byte)vk;
        keybd_event(b, 0, 0, MAGIC);
        keybd_event(b, 0, KEYEVENTF_KEYUP, MAGIC);
    }

    static void TryOpenOrClose(uint vk)
    {
        try
        {
            if (armed && !stayOpen)
            {
                Emit("close");
                return;
            }
            string path = SelectedPath();
            if (path != null && path.Length > 0) Emit("open " + path);
            else InjectKey(vk);
        }
        catch (Exception ex)
        {
            Emit("log sel-error " + ex.Message);
            InjectKey(vk);
        }
    }

    static bool IsInjected(KBD k)
    {
        if ((k.flags & 0x10) != 0) return true; // LLKHF_INJECTED
        try
        {
            if (k.extra != IntPtr.Zero && (uint)k.extra.ToInt64() == 0x53575056) return true;
        }
        catch { }
        return false;
    }

    static IntPtr HookCallback(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            KBD k = (KBD)Marshal.PtrToStructure(l, typeof(KBD));
            int msg = w.ToInt32();
            bool isDown = msg == 0x100 || msg == 0x104;
            bool isUp = msg == 0x101 || msg == 0x105;
            lastKeyAt = Environment.TickCount;
            if (IsInjected(k)) return CallNextHookEx(hook, code, w, l);
            if (isUp)
            {
                held.Remove(k.vk);
                if (swallowUp.Remove(k.vk)) return new IntPtr(1);
            }
            if (isDown)
            {
                bool repeat = !held.Add(k.vk);
                if (armed)
                {
                    // Se a prévia tiver mesmo o foreground, o Chromium trata as teclas.
                    // Caso típico: o Explorer ficou com o teclado e o Electron mente no isFocused.
                    string nav = NavCommand(k.vk);
                    if (nav != null && !IsPreviewForeground() && IsTargetForeground() && !IsTyping())
                    {
                        swallowUp.Add(k.vk);
                        if (!repeat || nav == "next" || nav == "prev")
                        {
                            string emit = nav;
                            form.BeginInvoke((Action)(() => Emit(emit)));
                        }
                        return new IntPtr(1);
                    }
                }
                if (repeat)
                {
                    if (swallowUp.Contains(k.vk)) return new IntPtr(1);
                    return CallNextHookEx(hook, code, w, l);
                }
                if (binding.Length > 0)
                {
                    string accel = AccelOf(k.vk);
                    if (accel == binding)
                    {
                        // Explorer/caret no próprio hook: engolir Espaço noutro app e reinjetá-lo
                        // atrasava o caractere e podia falhar em jogos.
                        if (!IsTargetForeground() || IsTyping())
                            return CallNextHookEx(hook, code, w, l);
                        swallowUp.Add(k.vk);
                        uint vk = k.vk;
                        form.BeginInvoke((Action)(() => TryOpenOrClose(vk)));
                        return new IntPtr(1);
                    }
                }
            }
        }
        return CallNextHookEx(hook, code, w, l);
    }
}

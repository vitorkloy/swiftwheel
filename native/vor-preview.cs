// vor-preview: helper nativo da prévia de arquivos do SwiftWheel (Windows).
// Comportamento à la QuickLook (só referência; código original, não derivado do QL-Win/GPL).
// - WH_KEYBOARD_LL numa thread própria (o Windows não tira o hook por LowLevelHooksTimeout).
// - Só engole o atalho com o Explorer ou a área de trabalho em primeiro plano,
//   e nunca com o caret a piscar / campo Edit (renomear, busca, barra de endereço).
// - O item selecionado e a lista de irmãos vêm da view do Explorer (IFolderView).
// Protocolo (linhas UTF-8):
//   stdin  bind <accel> | armed 0|1 | pinned 0|1 | hwnd <n> | openwith <path> | select <path> | selecti <index> | quit | status
//   stdout ready | view <index> <count> | viewitem <path> | open <path> | close | next | prev | launch | openwith-done | log <txt> | status ...
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
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern bool SHGetPathFromIDListW(IntPtr pidl, StringBuilder pszPath);
    [DllImport("shell32.dll")] static extern int SHCreateItemFromIDList(IntPtr pidl, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    [DllImport("shell32.dll")] static extern IntPtr ILCombine(IntPtr pidl1, IntPtr pidl2);
    [DllImport("shell32.dll")] static extern int SHCreateItemWithParent(IntPtr pidlParent, IntPtr psfParent, IntPtr pidlChild, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr pv);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr hFile, byte[] buffer, int count, out int written, IntPtr overlapped);

    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
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

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IServiceProvider
    {
        [PreserveSig]
        int QueryService(ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
    }

    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellBrowser
    {
        [PreserveSig] int GetWindow(out IntPtr phwnd);
        [PreserveSig] int ContextSensitiveHelp(int fEnterMode);
        [PreserveSig] int InsertMenusSB(IntPtr hmenuShared, IntPtr lpMenuWidths);
        [PreserveSig] int SetMenuSB(IntPtr hmenuShared, IntPtr holemenuRes, IntPtr hwndActiveObject);
        [PreserveSig] int RemoveMenusSB(IntPtr hmenuShared);
        [PreserveSig] int SetStatusTextSB(IntPtr pszStatusText);
        [PreserveSig] int EnableModelessSB(int fEnable);
        [PreserveSig] int TranslateAcceleratorSB(IntPtr pmsg, ushort wID);
        [PreserveSig] int BrowseObject(IntPtr pidl, uint wFlags);
        [PreserveSig] int GetViewStateStream(uint grfMode, out IntPtr ppStrm);
        [PreserveSig] int GetControlWindow(uint id, out IntPtr phwnd);
        [PreserveSig] int SendControlMsg(uint id, uint uMsg, IntPtr wParam, IntPtr lParam, out IntPtr pret);
        [PreserveSig] int QueryActiveShellView(out IntPtr ppshv);
        [PreserveSig] int OnViewWindowActive(IntPtr pshv);
        [PreserveSig] int SetToolbarItems(IntPtr lpButtons, uint nButtons, uint uFlags);
    }

    [ComImport, Guid("CDE725B0-CCC9-4519-917E-325D72FAB4CE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFolderView
    {
        [PreserveSig] int GetCurrentViewMode(out uint pViewMode);
        [PreserveSig] int SetCurrentViewMode(uint ViewMode);
        [PreserveSig] int GetFolder(ref Guid riid, out IntPtr ppv);
        [PreserveSig] int Item(int iItemIndex, out IntPtr ppidl);
        [PreserveSig] int ItemCount(uint uFlags, out int pcItems);
        [PreserveSig] int Items(uint uFlags, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetSelectionMarkedItem(out int piItem);
        [PreserveSig] int GetFocusedItem(out int piItem);
        [PreserveSig] int GetItemPosition(IntPtr pidl, out POINT ppt);
        [PreserveSig] int GetSpacing(out POINT ppt);
        [PreserveSig] int GetDefaultSpacing(out POINT ppt);
        [PreserveSig] int GetAutoArrange();
        [PreserveSig] int SelectItem(int iItem, uint dwFlags);
        [PreserveSig] int SelectAndPositionItems(uint cidl, IntPtr apidl, IntPtr apt, uint dwFlags);
    }

    [ComImport, Guid("000214F2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumIDList
    {
        [PreserveSig] int Next(uint celt, out IntPtr rgelt, out uint pceltFetched);
        [PreserveSig] int Skip(uint celt);
        [PreserveSig] int Reset();
        [PreserveSig] int Clone(out IntPtr ppenum);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    // IPersist + IPersistFolder + GetCurFolder. Os PIDLs da view são filhos relativos.
    [ComImport, Guid("1AC3D9F0-175C-11D1-95BE-00609797EA4F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFolder2
    {
        [PreserveSig] int GetClassID(out Guid pClassID);
        [PreserveSig] int Initialize(IntPtr pidl);
        [PreserveSig] int GetCurFolder(out IntPtr ppidl);
    }

    const int GUI_CARETBLINKING = 0x00000001;
    const int GUI_INMOVESIZE = 0x00000002;
    const int GUI_INMENUMODE = 0x00000004;
    const int GUI_SYSTEMMENUMODE = 0x00000008;
    const int GUI_POPUPMENUMODE = 0x00000010;
    const uint KEYEVENTF_KEYUP = 2;
    const uint SVGIO_ALLVIEW = 0x00000002;
    const uint SVGIO_FLAG_VIEWORDER = 0x80000000;
    const uint SVGIO_VIEW = SVGIO_ALLVIEW | SVGIO_FLAG_VIEWORDER;
    const uint SVSI_SELECT = 0x00000001;
    const uint SVSI_DESELECTOTHERS = 0x00000004;
    const uint SVSI_ENSUREVISIBLE = 0x00000008;
    const uint SVSI_FOCUSED = 0x00000010;
    const uint SVSI_NOTAKEFOCUS = 0x40000000;
    const uint SVSI_FLAGS = SVSI_SELECT | SVSI_DESELECTOTHERS | SVSI_ENSUREVISIBLE | SVSI_FOCUSED | SVSI_NOTAKEFOCUS;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    const int STD_OUTPUT_HANDLE = -11;
    static readonly Guid IID_IEnumIDList = new Guid("000214F2-0000-0000-C000-000000000046");
    static readonly Guid IID_IShellItem = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
    static readonly Guid SID_STopLevelBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
    static readonly Guid IID_IShellBrowser = new Guid("000214E2-0000-0000-C000-000000000046");
    static readonly Guid IID_IFolderView = new Guid("CDE725B0-CCC9-4519-917E-325D72FAB4CE");
    static readonly Guid IID_IServiceProvider = new Guid("6D5140C1-7436-11CE-8034-00AA006009FA");
    static readonly Guid IID_IPersistFolder2 = new Guid("1AC3D9F0-175C-11D1-95BE-00609797EA4F");
    static readonly Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
    // Assinatura nas teclas que nós próprios injetamos, para o hook as deixar passar.
    static readonly UIntPtr MAGIC = new UIntPtr(0x53575056);
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

    static readonly object outLock = new object();
    static StreamWriter output;
    static StreamReader input;
    static IntPtr stdoutHandle = IntPtr.Zero;
    static void Emit(string s)
    {
        lock (outLock)
        {
            try
            {
                byte[] bytes = Utf8.GetBytes(s + "\n");
                if (stdoutHandle != IntPtr.Zero)
                {
                    int written;
                    if (WriteFile(stdoutHandle, bytes, bytes.Length, out written, IntPtr.Zero)) return;
                }
                if (output != null) { output.Write(s + "\n"); output.Flush(); }
            }
            catch { }
        }
    }

    static string binding = "";
    static volatile bool armed;
    static volatile bool stayOpen;
    static IntPtr previewHwnd = IntPtr.Zero;
    static IntPtr originHwnd = IntPtr.Zero;
    static IntPtr hook = IntPtr.Zero;
    static HookProc hookProc = HookCallback;
    static readonly HashSet<uint> swallowUp = new HashSet<uint>();
    static readonly HashSet<uint> held = new HashSet<uint>();
    static Form form;
    static int lastKeyAt;

    [STAThread]
    static void Main()
    {
        try { Console.OutputEncoding = Utf8; } catch { }
        try { Console.InputEncoding = Utf8; } catch { }
        stdoutHandle = GetStdHandle(STD_OUTPUT_HANDLE);
        output = new StreamWriter(Console.OpenStandardOutput(), Utf8);
        output.AutoFlush = true;
        input = new StreamReader(Console.OpenStandardInput(), Utf8);
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
                else if (cmd == "select")
                {
                    string p = arg;
                    try { form.BeginInvoke((Action)(() => SelectPath(p))); }
                    catch (Exception ex) { Emit("log select-invoke " + ex.Message); }
                }
                else if (cmd == "selecti")
                {
                    int idx = 0;
                    if (int.TryParse(arg, out idx))
                    {
                        try { form.BeginInvoke((Action)(() => SelectIndex(idx))); }
                        catch (Exception ex) { Emit("log selecti-invoke " + ex.Message); }
                    }
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

    static string PathFromPidl(IntPtr pidl)
    {
        if (pidl == IntPtr.Zero) return null;
        try
        {
            Guid iid = IID_IShellItem;
            IShellItem item;
            int hr = SHCreateItemFromIDList(pidl, ref iid, out item);
            if (hr >= 0 && item != null)
            {
                IntPtr pName = IntPtr.Zero;
                hr = item.GetDisplayName(SIGDN_FILESYSPATH, out pName);
                if (hr >= 0 && pName != IntPtr.Zero)
                {
                    string s = Marshal.PtrToStringUni(pName);
                    CoTaskMemFree(pName);
                    try { Marshal.ReleaseComObject(item); } catch { }
                    if (s != null && s.Length > 0) return s;
                }
                else try { Marshal.ReleaseComObject(item); } catch { }
            }
        }
        catch { }
        StringBuilder sb = new StringBuilder(32768);
        if (SHGetPathFromIDListW(pidl, sb))
        {
            string s = sb.ToString();
            if (s != null && s.Length > 0) return s;
        }
        return null;
    }

    static IntPtr FolderAbsPidl(IFolderView fv)
    {
        if (fv == null) return IntPtr.Zero;
        Guid iid = IID_IPersistFolder2;
        IntPtr p = IntPtr.Zero;
        if (fv.GetFolder(ref iid, out p) < 0 || p == IntPtr.Zero) return IntPtr.Zero;
        try
        {
            IPersistFolder2 persist = (IPersistFolder2)Marshal.GetTypedObjectForIUnknown(p, typeof(IPersistFolder2));
            IntPtr absPidl = IntPtr.Zero;
            int hr = persist.GetCurFolder(out absPidl);
            try { Marshal.ReleaseComObject(persist); } catch { }
            if (hr < 0) return IntPtr.Zero;
            return absPidl;
        }
        catch (Exception ex)
        {
            Emit("log folder-abs " + ex.Message);
            return IntPtr.Zero;
        }
        finally { if (p != IntPtr.Zero) Marshal.Release(p); }
    }

    static IntPtr FolderShellFolderPtr(IFolderView fv)
    {
        if (fv == null) return IntPtr.Zero;
        Guid iid = IID_IShellFolder;
        IntPtr p = IntPtr.Zero;
        if (fv.GetFolder(ref iid, out p) < 0) return IntPtr.Zero;
        return p;
    }

    // IFolderView::Item/Items devolve PIDL relativo ao folder. SHGetPathFromIDList
    // num filho sozinho resolve a partir da Área de Trabalho.
    static string PathFromViewChild(IntPtr folderAbs, IntPtr psf, IntPtr child)
    {
        if (child == IntPtr.Zero) return null;
        if (folderAbs != IntPtr.Zero)
        {
            IntPtr full = ILCombine(folderAbs, child);
            if (full != IntPtr.Zero)
            {
                string combined = PathFromPidl(full);
                CoTaskMemFree(full);
                if (combined != null && combined.Length > 0) return combined;
            }
        }
        try
        {
            if (psf != IntPtr.Zero)
            {
                Guid iid = IID_IShellItem;
                IShellItem item;
                int hr = SHCreateItemWithParent(IntPtr.Zero, psf, child, ref iid, out item);
                if (hr >= 0 && item != null)
                {
                    IntPtr pName = IntPtr.Zero;
                    hr = item.GetDisplayName(SIGDN_FILESYSPATH, out pName);
                    if (hr >= 0 && pName != IntPtr.Zero)
                    {
                        string s = Marshal.PtrToStringUni(pName);
                        CoTaskMemFree(pName);
                        try { Marshal.ReleaseComObject(item); } catch { }
                        if (s != null && s.Length > 0) return s;
                    }
                    else try { Marshal.ReleaseComObject(item); } catch { }
                }
            }
        }
        catch { }
        return PathFromPidl(child);
    }

    static IFolderView FolderViewFromWindow(object w)
    {
        IntPtr unk = IntPtr.Zero;
        IntPtr pSp = IntPtr.Zero;
        IntPtr pBr = IntPtr.Zero;
        IntPtr pView = IntPtr.Zero;
        try
        {
            unk = Marshal.GetIUnknownForObject(w);
            Guid iidSp = IID_IServiceProvider;
            if (Marshal.QueryInterface(unk, ref iidSp, out pSp) != 0 || pSp == IntPtr.Zero) return null;
            IServiceProvider sp = (IServiceProvider)Marshal.GetTypedObjectForIUnknown(pSp, typeof(IServiceProvider));
            Guid sid = SID_STopLevelBrowser;
            Guid iidBr = IID_IShellBrowser;
            if (sp.QueryService(ref sid, ref iidBr, out pBr) != 0 || pBr == IntPtr.Zero)
            {
                try { Marshal.ReleaseComObject(sp); } catch { }
                return null;
            }
            try { Marshal.ReleaseComObject(sp); } catch { }
            IShellBrowser br = (IShellBrowser)Marshal.GetTypedObjectForIUnknown(pBr, typeof(IShellBrowser));
            int hr = br.QueryActiveShellView(out pView);
            try { Marshal.ReleaseComObject(br); } catch { }
            if (hr != 0 || pView == IntPtr.Zero) return null;
            Guid iidFv = IID_IFolderView;
            IntPtr pFv;
            if (Marshal.QueryInterface(pView, ref iidFv, out pFv) != 0 || pFv == IntPtr.Zero) return null;
            IFolderView fv = (IFolderView)Marshal.GetTypedObjectForIUnknown(pFv, typeof(IFolderView));
            Marshal.Release(pFv);
            return fv;
        }
        catch (Exception ex)
        {
            Emit("log folderview " + ex.Message);
            return null;
        }
        finally
        {
            if (pView != IntPtr.Zero) Marshal.Release(pView);
            if (pBr != IntPtr.Zero) Marshal.Release(pBr);
            if (pSp != IntPtr.Zero) Marshal.Release(pSp);
            if (unk != IntPtr.Zero) Marshal.Release(unk);
        }
    }

    static IFolderView GetFolderView(IntPtr preferHwnd)
    {
        Type t = Type.GetTypeFromProgID("Shell.Application");
        if (t == null) return null;
        object shell = Activator.CreateInstance(t);
        if (shell == null) return null;
        object windows = Call(shell, "Windows");
        if (windows == null) return null;
        int count = Convert.ToInt32(Prop(windows, "Count"));
        IFolderView desktop = null;
        IntPtr fg = preferHwnd != IntPtr.Zero ? preferHwnd : GetForegroundWindow();
        bool desktopFg = IsDesktopHwnd(fg) || (preferHwnd != IntPtr.Zero && IsDesktopHwnd(preferHwnd));
        for (int i = 0; i < count; i++)
        {
            object w = null;
            try { w = Call(windows, "Item", i); } catch { continue; }
            if (w == null) continue;
            IntPtr hwnd = IntPtr.Zero;
            try { hwnd = new IntPtr(Convert.ToInt64(Prop(w, "HWND"))); } catch { continue; }
            bool match = Related(fg, hwnd) || Related(Root(fg), hwnd);
            if (!match && preferHwnd != IntPtr.Zero)
                match = Related(preferHwnd, hwnd) || Related(Root(preferHwnd), hwnd);
            bool looksDesk = false;
            try { looksDesk = WindowLooksDesktop(w) || hwnd == GetShellWindow(); } catch { }
            if (!match && desktopFg && looksDesk) match = true;
            if (!match) continue;
            IFolderView fv = FolderViewFromWindow(w);
            if (fv == null) continue;
            if (looksDesk && !IsExplorerFrame(ClassName(hwnd)))
            {
                if (desktop != null && !object.ReferenceEquals(desktop, fv))
                {
                    try { Marshal.ReleaseComObject(desktop); } catch { }
                }
                desktop = fv;
                continue;
            }
            if (desktop != null && !object.ReferenceEquals(desktop, fv))
            {
                try { Marshal.ReleaseComObject(desktop); } catch { }
            }
            originHwnd = hwnd;
            return fv;
        }
        if (desktop != null)
        {
            originHwnd = GetShellWindow();
            return desktop;
        }
        return null;
    }

    static List<string> ViewPaths(IFolderView fv)
    {
        List<string> paths = new List<string>();
        if (fv == null) return paths;
        IntPtr folderAbs = FolderAbsPidl(fv);
        IntPtr psf = FolderShellFolderPtr(fv);
        try
        {
            Guid iidEnum = IID_IEnumIDList;
            IntPtr pEnum = IntPtr.Zero;
            int hr = fv.Items(SVGIO_VIEW, ref iidEnum, out pEnum);
            if (hr >= 0 && pEnum != IntPtr.Zero)
            {
                try
                {
                    IEnumIDList enumer = (IEnumIDList)Marshal.GetTypedObjectForIUnknown(pEnum, typeof(IEnumIDList));
                    while (true)
                    {
                        IntPtr pidl;
                        uint fetched;
                        hr = enumer.Next(1, out pidl, out fetched);
                        if (hr != 0 || fetched == 0 || pidl == IntPtr.Zero) break;
                        string p = PathFromViewChild(folderAbs, psf, pidl);
                        CoTaskMemFree(pidl);
                        if (p != null && p.Length > 0) paths.Add(p);
                    }
                    try { Marshal.ReleaseComObject(enumer); } catch { }
                }
                catch (Exception ex) { Emit("log view-enum " + ex.Message); }
                Marshal.Release(pEnum);
                if (paths.Count > 0) return paths;
            }
            int count;
            hr = fv.ItemCount(SVGIO_VIEW, out count);
            if (hr < 0 || count <= 0) return paths;
            for (int i = 0; i < count; i++)
            {
                IntPtr pidl;
                if (fv.Item(i, out pidl) < 0 || pidl == IntPtr.Zero) continue;
                string p = PathFromViewChild(folderAbs, psf, pidl);
                CoTaskMemFree(pidl);
                if (p != null && p.Length > 0) paths.Add(p);
            }
            return paths;
        }
        finally
        {
            if (folderAbs != IntPtr.Zero) CoTaskMemFree(folderAbs);
            if (psf != IntPtr.Zero) Marshal.Release(psf);
        }
    }

    static int IndexOfPath(List<string> paths, string filePath)
    {
        if (paths == null || filePath == null) return -1;
        for (int i = 0; i < paths.Count; i++)
        {
            if (SameFile(paths[i], filePath)) return i;
        }
        return -1;
    }

    static void EmitView(IFolderView fv, string currentPath)
    {
        List<string> paths = ViewPaths(fv);
        int index = IndexOfPath(paths, currentPath);
        if (index < 0) index = 0;
        Emit("view " + index + " " + paths.Count);
        for (int i = 0; i < paths.Count; i++) Emit("viewitem " + paths[i]);
    }

    static void EmitViewAndOpen(string path)
    {
        IFolderView fv = GetFolderView(originHwnd);
        if (fv != null)
        {
            try { EmitView(fv, path); }
            finally { try { Marshal.ReleaseComObject(fv); } catch { } }
        }
        Emit("open " + path);
    }

    static bool SameFile(string a, string b)
    {
        if (a == null || b == null) return false;
        if (string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return true;
        try
        {
            return string.Equals(Path.GetFileName(a), Path.GetFileName(b), StringComparison.OrdinalIgnoreCase)
                && string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    static void SelectIndex(int index)
    {
        IFolderView fv = GetFolderView(originHwnd);
        if (fv == null) return;
        try
        {
            int count;
            if (fv.ItemCount(SVGIO_VIEW, out count) < 0) return;
            if (index < 0 || index >= count) return;
            fv.SelectItem(index, SVSI_FLAGS);
        }
        catch (Exception ex) { Emit("log selecti " + ex.Message); }
        finally { try { Marshal.ReleaseComObject(fv); } catch { } }
    }

    static void SelectPath(string filePath)
    {
        if (filePath == null || filePath.Length == 0) return;
        IFolderView fv = GetFolderView(originHwnd);
        if (fv == null) return;
        IntPtr folderAbs = FolderAbsPidl(fv);
        IntPtr psf = FolderShellFolderPtr(fv);
        try
        {
            int count;
            if (fv.ItemCount(SVGIO_VIEW, out count) < 0) return;
            for (int i = 0; i < count; i++)
            {
                IntPtr pidl;
                if (fv.Item(i, out pidl) < 0 || pidl == IntPtr.Zero) continue;
                string p = PathFromViewChild(folderAbs, psf, pidl);
                CoTaskMemFree(pidl);
                if (p != null && SameFile(p, filePath))
                {
                    fv.SelectItem(i, SVSI_FLAGS);
                    return;
                }
            }
        }
        catch (Exception ex) { Emit("log select " + ex.Message); }
        finally
        {
            if (folderAbs != IntPtr.Zero) CoTaskMemFree(folderAbs);
            if (psf != IntPtr.Zero) Marshal.Release(psf);
            try { Marshal.ReleaseComObject(fv); } catch { }
        }
    }

    // O preview é a fonte da verdade: só pedimos next/prev. O Electron mostra e
    // depois manda select/selecti. SelectItem aqui adiantava o Explorer e o
    // open seguinte era descartado como sessão «stale».
    static void NavInView(int delta)
    {
        Emit(delta > 0 ? "next" : "prev");
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
        IntPtr desktopHwnd = IntPtr.Zero;
        for (int i = 0; i < count; i++)
        {
            object w = null;
            try { w = Call(windows, "Item", i); } catch { continue; }
            if (w == null) continue;
            IntPtr hwnd = IntPtr.Zero;
            try { hwnd = new IntPtr(Convert.ToInt64(Prop(w, "HWND"))); } catch { continue; }
            bool match = Related(fg, hwnd) || Related(Root(fg), hwnd);
            if (!match && desktop && (hwnd == GetShellWindow() || WindowLooksDesktop(w))) match = true;
            if (!match) continue;
            string path = null;
            try { path = PathFromDocument(Prop(w, "Document")); } catch { }
            if (path != null && path.Length > 0)
            {
                if (desktop && WindowLooksDesktop(w))
                {
                    desktopPath = path;
                    desktopHwnd = hwnd;
                }
                else
                {
                    originHwnd = hwnd;
                    return path;
                }
            }
        }
        if (desktopPath != null)
        {
            originHwnd = desktopHwnd != IntPtr.Zero ? desktopHwnd : GetShellWindow();
            return desktopPath;
        }
        return null;
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
            if (path != null && path.Length > 0) EmitViewAndOpen(path);
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
                            if (nav == "next" || nav == "prev")
                            {
                                int d = nav == "next" ? 1 : -1;
                                form.BeginInvoke((Action)(() => NavInView(d)));
                            }
                            else
                            {
                                string emit = nav;
                                form.BeginInvoke((Action)(() => Emit(emit)));
                            }
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

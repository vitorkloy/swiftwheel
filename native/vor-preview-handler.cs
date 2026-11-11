// Preview Handlers nativos (IPreviewHandler) — código original, não derivado do QuickLook.
// Janela owned pelo HWND Electron, posicionada sobre a área de conteúdo. STA própria
// para o COM; watchdog aborta a thread se DoPreview/Initialize travar.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static partial class VorPreview
{
    const string PreviewHandlerShellex = "shellex\\{8895b1c6-b41f-4c1c-a562-0d564250836f}";
    static readonly Guid IID_IPreviewHandler = new Guid("8895b1c6-b41f-4c1c-a562-0d564250836f");
    static readonly Guid IID_IUnknown = new Guid("00000000-0000-0000-C000-000000000046");
    const uint CLSCTX_INPROC_SERVER = 1;
    const uint CLSCTX_INPROC_HANDLER = 2;
    const uint CLSCTX_LOCAL_SERVER = 4;
    const uint STGM_READ = 0;
    const uint STGM_SHARE_DENY_NONE = 0x00000040;
    const int GWL_HWNDPARENT = -8;
    const int SW_SHOWNOACTIVATE = 4;
    const int SW_HIDE = 0;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_HIDEWINDOW = 0x0080;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const int PREVIEW_TIMEOUT_MS = 8000;

    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr ppv);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateStreamOnFileEx(string pszFile, uint grfMode, uint dwAttributes, int fCreate, IntPtr pstmTemplate, out IntPtr ppstm);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")]
    static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
    static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left; public int top; public int right; public int bottom; }

    [ComImport, Guid("8895b1c6-b41f-4c1c-a562-0d564250836f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPreviewHandler
    {
        [PreserveSig] int SetWindow(IntPtr hwnd, ref RECT prc);
        [PreserveSig] int SetRect(ref RECT prc);
        [PreserveSig] int DoPreview();
        [PreserveSig] int Unload();
        [PreserveSig] int SetFocus();
        [PreserveSig] int QueryFocus(out IntPtr phwnd);
        [PreserveSig] int TranslateAccelerator(ref MSG pmsg);
    }

    [ComImport, Guid("b7d14566-0509-4cce-a71f-0a554233bd9b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IInitializeWithFile
    {
        [PreserveSig] int Initialize([MarshalAs(UnmanagedType.LPWStr)] string pszFilePath, uint grfMode);
    }

    [ComImport, Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IInitializeWithStream
    {
        [PreserveSig] int Initialize(IntPtr pstream, uint grfMode);
    }

    [ComImport, Guid("7F73BE3F-34C8-49EB-B4DE-0418F2A0B052"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IInitializeWithItem
    {
        [PreserveSig] int Initialize(IShellItem psi, uint grfMode);
    }

    [ComImport, Guid("196bf9a5-b346-4ef0-aa1e-5dcdb76768b1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPreviewHandlerVisuals
    {
        [PreserveSig] int SetBackgroundColor(uint color);
        [PreserveSig] int SetFont(IntPtr plf);
        [PreserveSig] int SetTextColor(uint color);
    }

    static Form hostForm;
    static Thread hostThread;
    static ManualResetEvent hostReady;
    static IPreviewHandler handler;
    static IntPtr handlerStream = IntPtr.Zero;
    static volatile bool handlerUp;
    static volatile bool hostClosingApp;
    static volatile bool hostShutdown;
    static volatile bool hostHadFocus;
    static volatile bool dpiOnce;
    static volatile int loadGen;
    static int hostLeft, hostTop, hostWidth, hostHeight;
    static bool hostRectSet;
    static System.Windows.Forms.Timer hostTimer;

    static IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr value)
    {
        if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, nIndex, value);
        return new IntPtr(SetWindowLong32(hWnd, nIndex, value.ToInt32()));
    }

    static void EnsureDpi()
    {
        if (dpiOnce) return;
        dpiOnce = true;
        try { SetProcessDpiAwareness(2); }
        catch
        {
            try { SetProcessDPIAware(); } catch { }
        }
    }

    static string ReadHkcrDefault(string subkey)
    {
        RegistryKey k = null;
        try
        {
            k = Registry.ClassesRoot.OpenSubKey(subkey);
            if (k == null) return null;
            object v = k.GetValue(null);
            if (v == null) return null;
            string s = Convert.ToString(v);
            if (s == null || s.Length == 0) return null;
            return s.Trim();
        }
        catch { return null; }
        finally { if (k != null) try { k.Close(); } catch { } }
    }

    static bool FindPreviewHandler(string ext, out Guid clsid)
    {
        clsid = Guid.Empty;
        if (ext == null || ext.Length == 0) return false;
        if (ext[0] != '.') ext = "." + ext;
        string[] keys = new string[] {
            ext + "\\" + PreviewHandlerShellex,
            "SystemFileAssociations\\" + ext + "\\" + PreviewHandlerShellex
        };
        string value = null;
        for (int i = 0; i < keys.Length; i++)
        {
            value = ReadHkcrDefault(keys[i]);
            if (value != null && value.Length > 0) break;
        }
        if (value == null || value.Length == 0)
        {
            string progId = ReadHkcrDefault(ext);
            if (progId != null && progId.Length > 0)
                value = ReadHkcrDefault(progId + "\\" + PreviewHandlerShellex);
        }
        if (value == null || value.Length == 0) return false;
        try { clsid = new Guid(value); return true; }
        catch { return false; }
    }

    static void ApplyHostRect(string arg)
    {
        string[] p = (arg ?? "").Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        int l = 0, t = 0, w = 0, h = 0;
        if (p.Length < 4) return;
        if (!int.TryParse(p[0], out l) || !int.TryParse(p[1], out t) || !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h)) return;
        hostLeft = l;
        hostTop = t;
        hostWidth = w;
        hostHeight = h;
        hostRectSet = w > 8 && h > 8;
        try { if (hostForm != null && !hostForm.IsDisposed) hostForm.BeginInvoke((Action)(() => PositionHost())); }
        catch { }
    }

    static RECT HostClientRect()
    {
        RECT r = new RECT();
        r.left = 0;
        r.top = 0;
        r.right = hostWidth > 0 ? hostWidth : 100;
        r.bottom = hostHeight > 0 ? hostHeight : 100;
        return r;
    }

    static bool IsHostForeground()
    {
        if (!handlerUp || hostForm == null || hostForm.IsDisposed) return false;
        IntPtr host = IntPtr.Zero;
        try { host = hostForm.Handle; } catch { return false; }
        if (host == IntPtr.Zero) return false;
        IntPtr fg = GetForegroundWindow();
        if (fg == host || Related(fg, host)) return true;
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(0, ref info))
        {
            if (Related(info.hwndFocus, host) || Related(info.hwndActive, host)) return true;
        }
        return false;
    }

    static void EnsureHostThread()
    {
        if (hostThread != null && hostThread.IsAlive && hostForm != null && !hostForm.IsDisposed) return;
        hostReady = new ManualResetEvent(false);
        hostThread = new Thread(HostLoop);
        hostThread.SetApartmentState(ApartmentState.STA);
        hostThread.IsBackground = true;
        hostThread.Name = "preview-host";
        hostThread.Start();
        hostReady.WaitOne(3000);
    }

    static void HostLoop()
    {
        try
        {
            try { CoInitializeEx(IntPtr.Zero, 2); } catch { }
            hostForm = new Form();
            hostForm.FormBorderStyle = FormBorderStyle.None;
            hostForm.ShowInTaskbar = false;
            hostForm.StartPosition = FormStartPosition.Manual;
            hostForm.TopMost = true;
            hostForm.ControlBox = false;
            hostForm.MinimizeBox = false;
            hostForm.MaximizeBox = false;
            hostForm.Text = "";
            hostForm.BackColor = Color.FromArgb(21, 21, 21);
            hostForm.Width = 120;
            hostForm.Height = 120;
            hostForm.FormClosing += HostFormClosing;
            hostForm.Activated += HostFormActivated;
            hostForm.Deactivate += HostFormDeactivated;
            IntPtr unused = hostForm.Handle;
            hostTimer = new System.Windows.Forms.Timer();
            hostTimer.Interval = 250;
            hostTimer.Tick += HostTimerTick;
            hostTimer.Start();
            hostReady.Set();
            Application.Run(hostForm);
        }
        catch (ThreadAbortException)
        {
            try { Thread.ResetAbort(); } catch { }
        }
        catch (Exception ex)
        {
            try { Emit("log host-loop " + ex.Message); } catch { }
            try { if (hostReady != null) hostReady.Set(); } catch { }
        }
        finally
        {
            handlerUp = false;
            handler = null;
            hostForm = null;
        }
    }

    static void HostTimerTick(object sender, EventArgs e)
    {
        if (handlerUp) PositionHost();
    }

    static void HostFormClosing(object sender, FormClosingEventArgs e)
    {
        if (!hostShutdown && !hostClosingApp) e.Cancel = true;
    }

    static void HostFormActivated(object sender, EventArgs e)
    {
        hostHadFocus = true;
    }

    static void HostFormDeactivated(object sender, EventArgs e)
    {
        try { form.BeginInvoke((Action)CheckLeaveHost); }
        catch { }
    }

    static void CheckLeaveHost()
    {
        if (!handlerUp || stayOpen) return;
        IntPtr fg = GetForegroundWindow();
        if (IsHostForeground() || IsPreviewForeground()) return;
        if (IsTargetForeground() && !hostHadFocus) return;
        Emit("close");
    }

    static void PositionHost()
    {
        if (hostForm == null || hostForm.IsDisposed) return;
        if (previewHwnd == IntPtr.Zero || !hostRectSet || hostWidth < 16 || hostHeight < 16)
        {
            if (!handlerUp) return;
        }
        try { SetWindowLongPtr(hostForm.Handle, GWL_HWNDPARENT, previewHwnd); } catch { }
        POINT tl = new POINT();
        tl.x = hostLeft;
        tl.y = hostTop;
        if (previewHwnd != IntPtr.Zero) ClientToScreen(previewHwnd, ref tl);
        uint flags = SWP_NOACTIVATE | (handlerUp ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
        try { SetWindowPos(hostForm.Handle, HWND_TOPMOST, tl.x, tl.y, hostWidth, hostHeight, flags); } catch { }
        if (handler != null)
        {
            RECT r = HostClientRect();
            try { handler.SetRect(ref r); } catch { }
        }
    }

    static void EnsureHostVisible()
    {
        if (hostForm == null || hostForm.IsDisposed) return;
        PositionHost();
        try { ShowWindow(hostForm.Handle, SW_SHOWNOACTIVATE); } catch { }
    }

    static void UnloadHandlerCore(bool hide)
    {
        handlerUp = false;
        IPreviewHandler ph = handler;
        handler = null;
        if (ph != null)
        {
            try { ph.Unload(); } catch { }
            try { Marshal.FinalReleaseComObject(ph); } catch { }
        }
        if (handlerStream != IntPtr.Zero)
        {
            try { Marshal.Release(handlerStream); } catch { }
            handlerStream = IntPtr.Zero;
        }
        if (hide && hostForm != null && !hostForm.IsDisposed)
        {
            try { ShowWindow(hostForm.Handle, SW_HIDE); } catch { }
            try { hostForm.Hide(); } catch { }
        }
    }

    static void ClearNativePreview()
    {
        Interlocked.Increment(ref loadGen);
        hostHadFocus = false;
        if (hostForm != null && !hostForm.IsDisposed)
        {
            try
            {
                hostForm.BeginInvoke((Action)(() => UnloadHandlerCore(true)));
                return;
            }
            catch { }
        }
        UnloadHandlerCore(true);
    }

    static void AbortHostThread()
    {
        handlerUp = false;
        handler = null;
        hostShutdown = true;
        Thread t = hostThread;
        Form f = hostForm;
        try
        {
            if (f != null && !f.IsDisposed)
            {
                try { f.BeginInvoke((Action)(() => { try { Application.ExitThread(); } catch { } })); } catch { }
            }
        }
        catch { }
        try
        {
            if (t != null && t.IsAlive)
            {
                if (!t.Join(400))
                {
                    try { t.Abort(); } catch { }
                }
            }
        }
        catch { }
        hostThread = null;
        hostForm = null;
        hostShutdown = false;
    }

    static void AbortHostAndRestart()
    {
        AbortHostThread();
        if (!hostClosingApp) EnsureHostThread();
    }

    static void StartNativePreview(string path)
    {
        EnsureDpi();
        string ext = "";
        try { ext = Path.GetExtension(path); } catch { }
        Guid clsid;
        if (!FindPreviewHandler(ext, out clsid))
        {
            Emit("preview-fail nohandler");
            return;
        }
        EnsureHostThread();
        if (hostForm == null || hostForm.IsDisposed)
        {
            Emit("preview-fail error");
            return;
        }
        int gen = Interlocked.Increment(ref loadGen);
        handlerUp = false;
        try { hostForm.BeginInvoke((Action)(() => LoadHandler(path, gen, clsid))); }
        catch (Exception ex)
        {
            Emit("log preview-invoke " + ex.Message);
            Emit("preview-fail error");
            return;
        }
        Thread watchdog = new Thread(() =>
        {
            Thread.Sleep(PREVIEW_TIMEOUT_MS);
            if (loadGen != gen) return;
            if (handlerUp) return;
            Emit("log preview-timeout");
            AbortHostAndRestart();
            if (loadGen == gen) Emit("preview-fail timeout");
        });
        watchdog.IsBackground = true;
        watchdog.Name = "preview-wd";
        watchdog.Start();
    }

    static IntPtr CreateHandler(Guid clsid)
    {
        uint ctx = CLSCTX_INPROC_SERVER | CLSCTX_INPROC_HANDLER | CLSCTX_LOCAL_SERVER;
        Guid iidPh = IID_IPreviewHandler;
        IntPtr pv;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, ctx, ref iidPh, out pv);
        if (hr >= 0 && pv != IntPtr.Zero) return pv;
        Guid iidUnk = IID_IUnknown;
        IntPtr unk;
        hr = CoCreateInstance(ref clsid, IntPtr.Zero, ctx, ref iidUnk, out unk);
        if (hr < 0 || unk == IntPtr.Zero) return IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iidPh, out pv);
        Marshal.Release(unk);
        if (hr < 0) return IntPtr.Zero;
        return pv;
    }

    static bool InitHandler(IPreviewHandler ph, string path)
    {
        try
        {
            IInitializeWithFile initFile = ph as IInitializeWithFile;
            if (initFile != null)
            {
                int hr = initFile.Initialize(path, STGM_READ);
                if (hr >= 0) return true;
                Emit("log preview-initfile " + hr);
            }
        }
        catch (Exception ex) { Emit("log preview-initfile " + ex.Message); }
        try
        {
            IInitializeWithStream initStream = ph as IInitializeWithStream;
            if (initStream != null)
            {
                IntPtr stm;
                int hr = SHCreateStreamOnFileEx(path, STGM_READ | STGM_SHARE_DENY_NONE, 0, 0, IntPtr.Zero, out stm);
                if (hr >= 0 && stm != IntPtr.Zero)
                {
                    handlerStream = stm;
                    hr = initStream.Initialize(stm, STGM_READ);
                    if (hr >= 0) return true;
                    Emit("log preview-initstream " + hr);
                    Marshal.Release(stm);
                    handlerStream = IntPtr.Zero;
                }
            }
        }
        catch (Exception ex) { Emit("log preview-initstream " + ex.Message); }
        try
        {
            IInitializeWithItem initItem = ph as IInitializeWithItem;
            if (initItem != null)
            {
                Guid iid = IID_IShellItem;
                IShellItem item;
                int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
                if (hr >= 0 && item != null)
                {
                    hr = initItem.Initialize(item, STGM_READ);
                    try { Marshal.ReleaseComObject(item); } catch { }
                    if (hr >= 0) return true;
                    Emit("log preview-inititem " + hr);
                }
            }
        }
        catch (Exception ex) { Emit("log preview-inititem " + ex.Message); }
        return false;
    }

    static void TrySetVisuals(IPreviewHandler ph)
    {
        try
        {
            IPreviewHandlerVisuals vis = ph as IPreviewHandlerVisuals;
            if (vis == null) return;
            vis.SetBackgroundColor(0x00151515);
            vis.SetTextColor(0x00EEEEEE);
        }
        catch { }
    }

    static void LoadHandler(string path, int gen, Guid clsid)
    {
        if (gen != loadGen) return;
        UnloadHandlerCore(false);
        if (path == null || path.Length == 0 || !File.Exists(path))
        {
            Emit("preview-fail missing");
            return;
        }
        IntPtr pv = CreateHandler(clsid);
        if (pv == IntPtr.Zero)
        {
            Emit("preview-fail error");
            return;
        }
        IPreviewHandler ph = null;
        try { ph = (IPreviewHandler)Marshal.GetTypedObjectForIUnknown(pv, typeof(IPreviewHandler)); }
        catch (Exception ex)
        {
            Emit("preview-fail error " + ex.Message);
            Marshal.Release(pv);
            return;
        }
        Marshal.Release(pv);
        if (!InitHandler(ph, path))
        {
            try { ph.Unload(); } catch { }
            try { Marshal.ReleaseComObject(ph); } catch { }
            Emit("preview-fail init");
            return;
        }
        if (gen != loadGen)
        {
            try { ph.Unload(); } catch { }
            try { Marshal.ReleaseComObject(ph); } catch { }
            return;
        }
        EnsureHostVisible();
        RECT r = HostClientRect();
        try { ph.SetWindow(hostForm.Handle, ref r); } catch { }
        int hr = -1;
        try { hr = ph.DoPreview(); }
        catch (Exception ex)
        {
            Emit("log preview-dopreview " + ex.Message);
            try { ph.Unload(); } catch { }
            try { Marshal.ReleaseComObject(ph); } catch { }
            Emit("preview-fail error");
            return;
        }
        if (gen != loadGen)
        {
            try { ph.Unload(); } catch { }
            try { Marshal.ReleaseComObject(ph); } catch { }
            return;
        }
        if (hr < 0)
        {
            try { ph.Unload(); } catch { }
            try { Marshal.ReleaseComObject(ph); } catch { }
            Emit("preview-fail error " + hr);
            return;
        }
        handler = ph;
        handlerUp = true;
        hostHadFocus = false;
        TrySetVisuals(ph);
        PositionHost();
        Emit("preview-ok");
        Emit("log preview-handler " + Path.GetExtension(path));
    }
}

// IVirtualDesktopManager no processo do helper: move HWND para a área de trabalho
// virtual atual e devolve o foco à janela que o utilizador tinha antes da captura.
// Sem isto, um overlay Electron reaproveitado (criado na desktop 2) ao receber
// SetForegroundWindow troca o Windows para essa desktop — o "print, copiar, colar
// e eu estou na área de trabalho 2".
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class VirtualDesktop
{
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
    interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out int onCurrent);
        [PreserveSig] int GetWindowDesktopId(IntPtr hwnd, out Guid desktopId);
        [PreserveSig] int MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }

    [ComImport]
    [Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    class VirtualDesktopManagerClass { }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool connect);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);

    const int ASFW_ANY = -1;

    static IVirtualDesktopManager manager;
    static IntPtr savedForeground;
    static Guid savedDesktop;

    static IVirtualDesktopManager Manager()
    {
        if (manager == null) manager = (IVirtualDesktopManager)new VirtualDesktopManagerClass();
        return manager;
    }

    static bool TryDesktopId(IntPtr hwnd, out Guid id)
    {
        id = Guid.Empty;
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        try { return Manager().GetWindowDesktopId(hwnd, out id) == 0 && id != Guid.Empty; }
        catch { return false; }
    }

    /// Janela 1×1 sem ativação: o HWND nasce na desktop em que o utilizador está agora.
    class ProbeForm : Form
    {
        public ProbeForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(1, 1);
            Opacity = 0;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00000080 | 0x08000000; // TOOLWINDOW | NOACTIVATE
                return cp;
            }
        }
    }

    static Guid ProbeCurrentDesktop()
    {
        try
        {
            using (var probe = new ProbeForm())
            {
                probe.Show();
                Guid id;
                TryDesktopId(probe.Handle, out id);
                probe.Hide();
                return id;
            }
        }
        catch { return Guid.Empty; }
    }

    public static void RememberForeground()
    {
        savedForeground = GetForegroundWindow();
        savedDesktop = Guid.Empty;
        if (!TryDesktopId(savedForeground, out savedDesktop) || savedDesktop == Guid.Empty)
            savedDesktop = ProbeCurrentDesktop();
    }

    public static Guid CurrentDesktopId()
    {
        if (savedDesktop != Guid.Empty) return savedDesktop;
        RememberForeground();
        return savedDesktop;
    }

    public static bool MoveToCurrent(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        Guid id = CurrentDesktopId();
        if (id == Guid.Empty) id = ProbeCurrentDesktop();
        if (id == Guid.Empty) return false;
        try
        {
            Guid desktop = id;
            int hr = Manager().MoveWindowToDesktop(hwnd, ref desktop);
            if (hr != 0)
            {
                // Segunda tentativa com um probe fresco: o GUID gravado no Grab pode ter envelhecido
                // se o utilizador mudou de desktop entre o freeze e o overlay Electron.
                desktop = ProbeCurrentDesktop();
                if (desktop == Guid.Empty) return false;
                savedDesktop = desktop;
                hr = Manager().MoveWindowToDesktop(hwnd, ref desktop);
            }
            return hr == 0;
        }
        catch { return false; }
    }

    public static bool IsOnCurrent(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        try
        {
            int on;
            return Manager().IsWindowOnCurrentVirtualDesktop(hwnd, out on) == 0 && on != 0;
        }
        catch { return false; }
    }

    public static void RestoreForeground()
    {
        if (savedForeground == IntPtr.Zero || !IsWindow(savedForeground)) return;
        try { AllowSetForegroundWindow(ASFW_ANY); } catch { }
        try
        {
            uint unused;
            uint self = GetCurrentThreadId();
            uint fgTid = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
            uint targetTid = GetWindowThreadProcessId(savedForeground, out unused);
            AttachThreadInput(self, fgTid, true);
            AttachThreadInput(self, targetTid, true);
            SetForegroundWindow(savedForeground);
            AttachThreadInput(self, fgTid, false);
            AttachThreadInput(self, targetTid, false);
        }
        catch
        {
            try { SetForegroundWindow(savedForeground); } catch { }
        }
    }
}

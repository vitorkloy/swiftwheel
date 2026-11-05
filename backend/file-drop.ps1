# Alvo de drop invisível. Lê o caminho no DragEnter (CF_HDROP), antes do botão soltar.
# A janela fica com alpha 1: o Windows acerta o arrasto, mas ela não cobre a roda.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class VorFileDrop : Form {
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")]
    static extern bool WriteFile(IntPtr handle, byte[] bytes, int count, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll")]
    static extern bool ReadFile(IntPtr handle, byte[] buffer, int count, out int read, IntPtr overlapped);

    static readonly IntPtr Topmost = new IntPtr(-1);
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const int SW_HIDE = 0;
    const int SW_SHOWNOACTIVATE = 4;

    static IntPtr stdout;
    static IntPtr stdin;
    string leftover = "";

    public static void Main() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        stdout = GetStdHandle(-11);
        stdin = GetStdHandle(-10);
        var form = new VorFileDrop();
        form.CreateControl();
        // Força o HWND agora: BeginInvoke da thread de leitura precisa dele (CreateControl não cria em janela oculta).
        var hwnd = form.Handle;
        // Leitura bloqueante numa thread: sem timer, o helper fica a 0% de CPU enquanto ninguém arrasta nada.
        var reader = new System.Threading.Thread(delegate () { form.ReadLoop(); });
        reader.IsBackground = true;
        reader.Start();
        Emit("ready");
        Application.Run();
    }

    void ReadLoop() {
        var buf = new byte[4096];
        while (true) {
            int got;
            if (!ReadFile(stdin, buf, buf.Length, out got, IntPtr.Zero) || got <= 0) {
                try { BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); }); } catch { }
                return;
            }
            var text = Encoding.UTF8.GetString(buf, 0, got);
            try { BeginInvoke((MethodInvoker)delegate { Feed(text); }); } catch { return; }
        }
    }

    void Feed(string text) {
        leftover += text;
        int nl;
        while ((nl = leftover.IndexOf('\n')) >= 0) {
            var line = leftover.Substring(0, nl).Trim();
            leftover = leftover.Substring(nl + 1);
            Apply(line);
        }
    }

    void Apply(string line) {
        var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return;
        if (parts[0] == "quit") {
            Application.ExitThread();
            return;
        }
        if (parts[0] == "hide") {
            HideCatcher();
            return;
        }
        if (parts[0] == "show" && parts.Length >= 5) {
            int x, y, w, h;
            if (!int.TryParse(parts[1], out x) || !int.TryParse(parts[2], out y) || !int.TryParse(parts[3], out w) || !int.TryParse(parts[4], out h)) return;
            Place(x, y, w, h);
        }
    }

    public VorFileDrop() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AllowTransparency = true;
        Opacity = 1.0 / 255.0;
        AllowDrop = true;
        TopMost = true;
        Bounds = new System.Drawing.Rectangle(-32000, -32000, 8, 8);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000;
            cp.ExStyle |= 0x00000080;
            cp.ExStyle |= 0x00000008;
            return cp;
        }
    }

    public void Place(int x, int y, int w, int h) {
        if (!IsHandleCreated) CreateControl();
        ShowWindow(Handle, SW_SHOWNOACTIVATE);
        SetWindowPos(Handle, Topmost, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    public void HideCatcher() {
        if (IsHandleCreated) ShowWindow(Handle, SW_HIDE);
    }

    static void Emit(string line) {
        var bytes = Encoding.UTF8.GetBytes(line + "\n");
        int written;
        WriteFile(stdout, bytes, bytes.Length, out written, IntPtr.Zero);
    }

    /** Todos os itens arrastados (arquivos e pastas), separados por "|" — caractere proibido em caminhos do Windows. */
    static string AllFiles(DragEventArgs e) {
        if (e.Data == null || !e.Data.GetDataPresent(DataFormats.FileDrop)) return null;
        var files = e.Data.GetData(DataFormats.FileDrop) as string[];
        if (files == null || files.Length == 0) return null;
        var list = new System.Collections.Generic.List<string>();
        foreach (var f in files) if (!string.IsNullOrEmpty(f)) list.Add(f);
        return list.Count > 0 ? string.Join("|", list.ToArray()) : null;
    }

    protected override void OnDragEnter(DragEventArgs e) {
        base.OnDragEnter(e);
        var files = AllFiles(e);
        if (files != null) {
            Emit("files " + files);
            e.Effect = DragDropEffects.Copy;
        } else {
            e.Effect = DragDropEffects.None;
        }
    }

    protected override void OnDragOver(DragEventArgs e) {
        base.OnDragOver(e);
        e.Effect = DragDropEffects.Copy;
    }

    protected override void OnDragDrop(DragEventArgs e) {
        base.OnDragDrop(e);
        e.Effect = DragDropEffects.Copy;
        Emit("drop");
    }
}
'@

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $src -Language CSharp
[VorFileDrop]::Main()
exit 0

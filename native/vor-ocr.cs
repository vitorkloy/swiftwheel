// vor-ocr: OCR a pedido com Windows.Media.Ocr (WinRT), sem pacote extra.
// Só corre quando o Node pede — custo zero em repouso.
// Uso: vor-ocr.exe [--lang pt-BR,en] <ficheiro>
// stdout UTF-8 = texto; exit 0 com texto, 2 se vazio, 1 se erro.
using System;
using System.IO;
using System.Threading;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;
using Windows.Foundation;

static class VorOcr
{
    static T AwaitOp<T>(IAsyncOperation<T> op)
    {
        var done = new ManualResetEvent(false);
        Exception error = null;
        T result = default(T);
        AsyncOperationCompletedHandler<T> finish = (info, status) =>
        {
            try
            {
                if (status == AsyncStatus.Completed) result = info.GetResults();
                else if (status == AsyncStatus.Error) error = info.ErrorCode;
                else error = new Exception("OCR cancelado");
            }
            catch (Exception e) { error = e; }
            done.Set();
        };
        op.Completed = finish;
        // Já concluído antes de ligar o Completed: sem isto o WaitOne ficava para sempre.
        if (op.Status != AsyncStatus.Started) finish(op, op.Status);
        done.WaitOne();
        if (error != null) throw error;
        return result;
    }

    static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            string langs = "pt-BR,en";
            string file = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--lang" && i + 1 < args.Length) { langs = args[++i]; continue; }
                file = string.IsNullOrEmpty(file) ? args[i] : file + " " + args[i];
            }
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
            {
                Console.Error.WriteLine("ficheiro OCR ausente");
                return 1;
            }
            file = Path.GetFullPath(file);
            var storage = AwaitOp(StorageFile.GetFileFromPathAsync(file));
            var stream = AwaitOp(storage.OpenAsync(FileAccessMode.Read));
            try
            {
                var decoder = AwaitOp(BitmapDecoder.CreateAsync(stream));
                var bitmap = AwaitOp(decoder.GetSoftwareBitmapAsync());
                if (bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8
                    && bitmap.BitmapPixelFormat != BitmapPixelFormat.Gray8
                    && bitmap.BitmapPixelFormat != BitmapPixelFormat.Nv12)
                {
                    bitmap = SoftwareBitmap.Convert(bitmap, BitmapPixelFormat.Bgra8);
                }
                OcrEngine engine = null;
                foreach (var tag in langs.Split(','))
                {
                    var name = tag.Trim();
                    if (name.Length == 0) continue;
                    try
                    {
                        var lang = new Language(name);
                        if (!OcrEngine.IsLanguageSupported(lang)) continue;
                        engine = OcrEngine.TryCreateFromLanguage(lang);
                        if (engine != null) break;
                    }
                    catch { }
                }
                if (engine == null) engine = OcrEngine.TryCreateFromUserProfileLanguages();
                if (engine == null)
                {
                    Console.Error.WriteLine("motor OCR indisponível");
                    return 1;
                }
                var result = AwaitOp(engine.RecognizeAsync(bitmap));
                string text = result != null ? (result.Text ?? "") : "";
                text = text.Trim();
                if (text.Length == 0) return 2;
                Console.Out.Write(text);
                return 0;
            }
            finally { stream.Dispose(); }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message.Replace('\n', ' '));
            return 1;
        }
    }
}

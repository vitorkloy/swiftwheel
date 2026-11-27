<div align="center">

# SwiftWheel

**Um gesto. Qualquer destino.**

Launcher radial para Windows. Segure o botão do meio em qualquer lugar, aponte, solte.

Fork do [Rovyl](https://github.com/HenryCauan/rovyl), de **HenryCauan** (HenryCa).

</div>

---

https://github.com/user-attachments/assets/16e57138-9344-42d8-a33e-cd66cb92dadc

## O que é

O SwiftWheel (antes VOR) abre **debaixo do cursor**, por cima de qualquer janela — inclusive tela cheia. Uma roda de apps, pastas, sites e comandos; workspaces (trabalho, jogos, streaming) mudam com a tecla numérica ou com a própria roda.

Tudo **offline**: sem conta, sem telemetria, sem anúncio. Nada sai da máquina.

## Módulos

Cada um liga e desliga nas Definições → Geral → Módulos. Desligado, some o atalho, o listener e o processo em segundo plano.

| Módulo | O que faz |
| --- | --- |
| **Roda de apps** | Botão do meio (clique ou segurar) ou atalho global (padrão `Alt+Z`). |
| **Roda de arquivos (ShiftDrop)** | Arraste um arquivo no Explorer e segure Shift (converter), Ctrl (ferramentas) ou Alt (ações). |
| **Captura** | Print Screen no estilo Lightshot: congela a tela, recorta, anota, copia/salva, OCR. |
| **Pré-visualização** | Espaço no Explorer ou na área de trabalho abre uma prévia (estilo QuickLook, sem copiar código GPL). |
| **Dock** | Pílula estilo macOS (tema VOR, hover-lift de 6 px, auto-hide 150 ms). Esconde a barra do Windows enquanto está ligada. **Desligada por padrão.** |

## Dock

Definições → **Dock**. Ligada, a barra de tarefas do Windows (`Shell_TrayWnd`) some e a pílula assume os ícones fixados e os apps abertos. Clique foca ou abre; botão direito fixa, desafixa ou fecha a janela. O relógio e um mini tray (volume, rede, notificações) ficam na própria Dock.

Auto-hide: a Dock aparece ao encostar o ponteiro na borda e some no delay configurado (padrão 150 ms). **Não reserva área de trabalho** — janelas maximizadas usam a tela inteira. Atalhos **Win+número** continuam com o Explorer.

A barra do Windows volta ao desligar o módulo, ao sair do app, ao bloquear a sessão e se o processo morrer. Sem Windhawk e sem injeção no `explorer.exe`.

## Captura de tela

- Atalhos (configuráveis): **Print Screen** seleção, **Shift+Print Screen** tela do monitor, **Alt+Print Screen** janela ativa.
- Overlay nativo: a tela só escurece; **Esc** cancela a qualquer momento, mesmo antes de selecionar.
- Multi-monitor, alças de redimensionamento, caneta, seta, formas, marcador, texto, pixelizar.
- Copiar (`Ctrl+C`), salvar (`Ctrl+S`), fixar na tela, enviar para o ShiftDrop, **Copiar texto** (OCR nativo do Windows, offline).
- Pasta padrão: `Imagens/Capturas de Tela` (ou a que você escolher).

## ShiftDrop

Arrastar arquivo(s) + tecla abre a roda no cursor. Soltar numa fatia converte ou abre a ferramenta. **Não instale nada na mão**: LibreOffice, ffmpeg, ImageMagick, Pandoc e MuPDF (`mutool`) são baixados automaticamente na primeira necessidade e só rodam durante o trabalho.

Exemplos: PDF ↔ DOCX/PPTX/XLSX/imagens, comprimir/dividir/metadados de PDF, imagens (WEBP, AVIF, JPG…), vídeo/áudio, ZIP/TAR, certificados, OCR de imagem, Float (prateleira), Compartilhar do Windows.

Ferramentas com tela (cortar, anotar, organizar PDF…) usam uma janela de estúdio reaproveitada. Erros só pela **notificação do sistema**, em português. Cancelar senha não avisa nada.

## Pré-visualização

Com um arquivo selecionado no Explorer, **Espaço** abre a janela. Espaço ou Esc fecha; setas passam para o vizinho; Enter abre no app padrão. Imagens, vídeo/áudio, PDF, texto/código, Markdown, pastas, ZIP e Office (handlers do Windows, com fallback). A janela **não é transparente**.

## Notificações e sons

Definições → **Notificações**:

- Interruptor mestre
- Captura copiada / salva
- Conversão iniciada (desligada por padrão), concluída, erro
- Atualizações e demais eventos
- Sons curtos embutidos: clique ao abrir a roda, obturador na captura, plim ao terminar conversão

## Instalação e atualização

- Instalador NSIS nas [Releases](https://github.com/vitorkloy/swiftwheel/releases) (`SwiftWheel_*_x64-setup.exe`).
- Atualização automática pelo próprio repositório `vitorkloy/swiftwheel`. Na bandeja: **Verificar atualização**.
- Configuração e logs: `%APPDATA%\SwiftWheel` (macOS: `~/Library/Application Support/SwiftWheel`, Linux: `~/.config/SwiftWheel`). Na primeira abertura, um perfil VOR/Zenith antigo é copiado para essa pasta e o original permanece.

## Desenvolvimento

Windows 10/11 e **Node 20+**. O gatilho, os ícones e as janelas dependem do Win32; Linux/macOS têm suporte parcial.

```bash
git clone https://github.com/vitorkloy/swiftwheel
cd swiftwheel
npm install
npm start
```

`npm start` sobe o Vite e, em seguida, o Electron. Metades separadas: `npm run dev` e `npm run electron`.

Login Google (opcional) usa credenciais **suas**: copie `.env.example` para `.env.local`. Não há client ID padrão.

> Dev e pacote compartilham a mesma pasta de perfil. Use `--user-data-dir` ou `SWIFTWHEEL_USER_DATA` para um perfil limpo.

<details>
<summary><b>Scripts</b></summary>

| Comando | Função |
| --- | --- |
| `npm start` | Dev server + Electron |
| `npm run dev` | Só Vite |
| `npm run electron` | Só Electron, espera a porta 5173 |
| `npm run build` | `tsc` → helpers nativos → Vite → verificação da roda → ícones |
| `npm run dist` | `build` + electron-builder, instalador em `build-out/` |
| `npm run dist:store` | Pacote MSIX |
| `npm run verify:radial-windowing` | Invariantes do handshake da janela radial |
| `npm run test:prefs` | Módulos, notificações e sons |
| `npm run test:capture` | Modos de captura e OCR |
| `npm run test:file-wheel` | Geometria da roda de arquivos |
| `npm run test:preview` | Prévia e Office |
| `npm run test:dock` | Dock: defaults, geometria, helper nativo |
| `npm run test:win32-launch` | Parsing/quoting de comandos |
| `npm run test:user-data-migrate` | Migração VOR → SwiftWheel |
| `npm run test:persistence-shape` | Normalização do blob persistido |

</details>

Estrutura: `src/` (React/Vite/Tailwind — roda, Definições, captura, prévia), `backend/` (processo principal Electron e helpers), `docs/ARCHITECTURE.md` (o *porquê* das decisões).

## Contribuir

Issues e PRs são bem-vindos. Antes de mudar o que parece arbitrário, leia **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

Comentários no código estão em português e explicam *por que*, não *o quê*. `npm run build` roda a verificação do handshake da janela; se falhar, o handshake quebrou, não o teste.

## Links

- **Releases** — [github.com/vitorkloy/swiftwheel/releases](https://github.com/vitorkloy/swiftwheel/releases)
- **Upstream Rovyl** — [github.com/HenryCauan/rovyl](https://github.com/HenryCauan/rovyl)
- **Microsoft Store (Rovyl)** — [Rovyl](https://apps.microsoft.com/detail/9N03SVPMXSV1)
- **Site e docs do upstream** — [rovyl-red.vercel.app](https://rovyl-red.vercel.app)
- **Política de privacidade do upstream** — [rovyl-red.vercel.app/privacy](https://rovyl-red.vercel.app/privacy)

## Licença

Copyright © 2026 Henry Cauan.

O SwiftWheel é um fork do Rovyl, software livre sob a **GNU General Public License v3.0** — ver [LICENSE](LICENSE). Você pode usar, estudar, modificar e compartilhar. Se distribuir uma versão modificada, o código-fonte precisa sair sob a mesma licença.

O titular dos direitos não está preso a essa licença de saída, então o build da Microsoft Store segue os termos padrão da Microsoft. Os dois são o mesmo código.

## Fork

Este repositório é um fork de [HenryCauan/rovyl](https://github.com/HenryCauan/rovyl), criado e mantido por **HenryCauan** (HenryCa). Todo o crédito pelo projeto original é do autor. O código continua sob **GNU GPL-3.0**; as alterações deste fork seguem a mesma licença.

O produto chama-se **SwiftWheel** (antes VOR). O GitHub redireciona `vitorkloy/vor` para `vitorkloy/swiftwheel`.

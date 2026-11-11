import { AppItem, PreviewSettings, ScreenshotSettings, UIConfig, Workspace } from "./types";

export const DEFAULT_SCREENSHOT: ScreenshotSettings = {
  enabled: true,
  shortcutRegion: "PrintScreen",
  shortcutFull: "Shift+PrintScreen",
  shortcutWindow: "Alt+PrintScreen",
  format: "png",
  quality: 92,
  copyOnSelect: false,
  showToasts: true,
  rememberRegion: false,
  includeCursor: false,
  saveDirectory: "",
  lastRegion: null,
  wheelSeeded: false,
};

export const DEFAULT_PREVIEW: PreviewSettings = {
  enabled: true,
  shortcut: "Space",
};

export const SCREENSHOT_WHEEL_APP: AppItem = {
  id: "vor-screenshot",
  type: "app",
  label: "Captura",
  iconName: "Camera",
  iconSource: "lucide",
  command: "vor:screenshot",
  commandType: "app",
  description: "Captura de tela",
};

export const DEFAULT_APPS: AppItem[] = [
  {
    id: "1a7a5818-4c99-4e4f-8a4d-3e28d4d7f5d7",
    type: "app",
    label: "Browser",
    direction: "N",
    iconName: "Globe",
    iconSource: "native",
    command: "msedge",
    description: "Web Browser",
  },
  {
    id: "2b8b6818-5d99-4e4f-8a4d-3e28d4d7f5d8",
    type: "folder",
    label: "Media Hub",
    direction: "NE",
    iconName: "Folder",
    iconSource: "lucide",
    command: "",
    description: "Entertainment",
    children: [
      {
        id: "3c9c7818-6e99-4e4f-8a4d-3e28d4d7f5d9",
        type: "app",
        label: "Spotify",
        iconName: "Music",
        iconSource: "native",
        command: "spotify",
        description: "Music Player",
      },
      {
        id: "4da08818-7f99-4e4f-8a4d-3e28d4d7f5da",
        type: "app",
        label: "YouTube",
        iconName: "Youtube",
        iconSource: "lucide",
        command: "https://www.youtube.com/",
        commandType: "url",
        description: "Web Video",
      },
      {
        id: "5eb19818-8099-4e4f-8a4d-3e28d4d7f5db",
        type: "app",
        label: "Netflix",
        iconName: "Clapperboard",
        iconSource: "lucide",
        command: "https://www.netflix.com/",
        commandType: "url",
        description: "Streaming",
      },
    ],
  },
  {
    id: "6fc2a818-9199-4e4f-8a4d-3e28d4d7f5dc",
    type: "app",
    label: "Games",
    direction: "SE",
    iconName: "Gamepad2",
    iconSource: "native",
    command: "steam",
    description: "Steam",
  },
  {
    id: "70d3b818-a299-4e4f-8a4d-3e28d4d7f5dd",
    type: "app",
    label: "Chat",
    direction: "S",
    iconName: "MessageSquare",
    iconSource: "native",
    command: "discord",
    description: "Discord",
  },
  {
    id: "81e4c818-b399-4e4f-8a4d-3e28d4d7f5de",
    type: "app",
    label: "Files",
    direction: "SW",
    iconName: "FolderOpen",
    iconSource: "native",
    command: "explorer",
    description: "File Manager",
  },
  {
    id: "a306e818-d599-4e4f-8a4d-3e28d4d7f5e0",
    type: "app",
    label: "Calculator",
    direction: "NW",
    iconName: "Calculator",
    iconSource: "native",
    command: "calc",
    description: "Calculator",
  },
  {
    id: "antigravity-default",
    type: "app",
    label: "Antigravity",
    iconName: "Binary",
    iconSource: "lucide",
    command: "antigravity",
    description: "Next-gen AI IDE",
    hasRecents: true,
  },
  {
    id: "cursor-default",
    type: "app",
    label: "Cursor",
    iconName: "Code2",
    iconSource: "lucide",
    command: "cursor",
    description: "AI Code Editor",
    hasRecents: true,
  },
];

/**
 * IDs from the bundled demo radial (Browser, Media Hub, Steam, etc.) — not real Start Menu picks.
 * If Main still contains any of these after a previous bug, we re-run Start Menu discovery to replace them.
 */
export const BUNDLED_DEMO_APP_IDS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  const walk = (items: AppItem[]) => {
    for (const a of items) {
      if (a.id) s.add(a.id);
      if (a.children?.length) walk(a.children);
    }
  };
  walk(DEFAULT_APPS);
  return s;
})();

export function workspaceContainsBundledDemoApp(workspace: Workspace): boolean {
  const scan = (items: AppItem[]): boolean => {
    for (const a of items) {
      if (a.id && BUNDLED_DEMO_APP_IDS.has(a.id)) return true;
      if (a.children?.length && scan(a.children)) return true;
    }
    return false;
  };
  return scan(workspace.apps);
}

/**
 * Main workspace before Start Menu discovery: só a captura, nunca a roda de demonstração.
 */
export const MINIMAL_MAIN_WORKSPACE_APPS: AppItem[] = [SCREENSHOT_WHEEL_APP];

// Default Workspaces
export const DEFAULT_WORKSPACES: Workspace[] = [
  {
    id: "workspace-1",
    name: "Main",
    hotkey: 1,
    enabled: true,
    apps: MINIMAL_MAIN_WORKSPACE_APPS,
    color: "#3B82F6", // Blue
    /** Sem isto todos os workspaces entram na roda com o mesmo `Layers` e só se distinguem pelo nome. */
    pickerIconName: "Home",
  },
  {
    id: "workspace-2",
    name: "Streaming",
    hotkey: 2,
    enabled: true,
    pickerIconName: "MonitorPlay",
    apps: [
      {
        id: "stream-1",
        type: "app",
        label: "YouTube",
        iconName: "Youtube",
        iconSource: "lucide",
        command: "https://www.youtube.com/",
        commandType: "url",
        description: "Watch videos",
      },
      {
        id: "stream-2",
        type: "app",
        label: "Twitch",
        iconName: "Tv",
        iconSource: "lucide",
        command: "https://www.twitch.tv/",
        commandType: "url",
        description: "Live streaming",
      },
      {
        id: "stream-3",
        type: "app",
        label: "Prime Video",
        iconName: "MonitorPlay",
        iconSource: "lucide",
        command: "https://www.primevideo.com/",
        commandType: "url",
        description: "Amazon Streaming",
      },
      {
        id: "stream-4",
        type: "app",
        label: "Netflix",
        iconName: "Clapperboard",
        iconSource: "lucide",
        command: "https://www.netflix.com/br/",
        commandType: "url",
        description: "Netflix Brasil",
      },
    ],
    color: "#EF4444", // Red
  },
];

export const DEFAULT_UI_CONFIG: UIConfig = {
  accentColor: "#FFFFFF",
  radialHoverColor: "#FFFFFF",
  menuRadius: 140,
  iconSize: 55,
  fixedPosition: true,
  backdropOpacity: 1,
  menuOpacity: 0.8,
  glassEffect: true,
  menuBackgroundStyle: "circle",
  appSpacing: 10, // Default spacing between apps
  activationThreshold: 60,
  centerButton: {
    type: "none",
    target: "",
    label: "",
    iconName: "Circle",
  },
  showLabels: true,
  alwaysShowAppLabels: false,
  showBattery: false,
  showWeather: false,
  clockPosition: "top-center",
  gameMode: {
    enabled: false,
    mode: "list",
    blockedApps: "",
    autoDetectGames: false,
  },
  globalShortcut: "Alt+Z",
  workspaces: DEFAULT_WORKSPACES,
  activeWorkspaceIndex: 0,
  workspaceSwitchMode: 'picker',
  appearanceTheme: 'black',
  radialSelectionMode: 'angle',
  openAtLogin: true,
  enableMouseTrigger: true,
  mouseTriggerMode: 'hold',
  mouseTriggerButton: 'middle',
  language: "en",
  uiLanguage: "system",
  fileWheelKeys: { convert: "shift", tools: "ctrl", actions: "alt" },
  fileWheelScale: 1,
  fileWheelRadius: 140,
  fileWheelIconSize: 55,
  fileWheelSpacing: 10,
  performanceMode: false,
  mainStartMenuDiscoveryDone: false,
  screenshot: DEFAULT_SCREENSHOT,
  preview: DEFAULT_PREVIEW,
};

function workspaceHasScreenshot(items: AppItem[]): boolean {
  for (const item of items) {
    if (item.command === "vor:screenshot") return true;
    if (item.children?.length && workspaceHasScreenshot(item.children)) return true;
  }
  return false;
}

function sameShortcut(a: string, b: string) {
  return a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
}

/** Seleção e ecrã inteiro gravados iguais voltam aos três padrões. */
function repairScreenshotShortcuts(screenshot: ScreenshotSettings): ScreenshotSettings {
  if (!sameShortcut(screenshot.shortcutRegion, screenshot.shortcutFull)) return screenshot;
  return {
    ...screenshot,
    shortcutRegion: DEFAULT_SCREENSHOT.shortcutRegion,
    shortcutFull: DEFAULT_SCREENSHOT.shortcutFull,
    shortcutWindow: DEFAULT_SCREENSHOT.shortcutWindow,
  };
}

/** A primeira leitura depois desta versão coloca a captura na roda principal, uma vez. */
export function withScreenshotWheel(config: UIConfig): UIConfig {
  const screenshot = repairScreenshotShortcuts({ ...DEFAULT_SCREENSHOT, ...(config.screenshot ?? {}) });
  const present = (config.workspaces ?? []).some((workspace) => workspaceHasScreenshot(workspace.apps ?? []));
  if (present || screenshot.wheelSeeded) {
    return { ...config, screenshot: { ...screenshot, wheelSeeded: true } };
  }
  const workspaces = (config.workspaces ?? []).map((workspace, index) =>
    index === 0 ? { ...workspace, apps: [...(workspace.apps ?? []), SCREENSHOT_WHEEL_APP] } : workspace,
  );
  return { ...config, workspaces, screenshot: { ...screenshot, wheelSeeded: true } };
}

/**
 * Configs antigos guardaram atalhos `internal:*` (Notas / Alarme / Cronómetro / Pomodoro).
 * Esses widgets já não existem: sem esta limpeza na hidratação o radial mostraria ícones mortos.
 */
export function stripInternalWidgetApps(items: AppItem[]): AppItem[] {
  const out: AppItem[] = [];
  for (const a of items) {
    if (typeof a.command === "string" && a.command.startsWith("internal:")) continue;
    out.push(a.children?.length ? { ...a, children: stripInternalWidgetApps(a.children) } : a);
  }
  return out;
}

/** Aplica `stripInternalWidgetApps` a todos os workspaces e ao botão central. */
export function stripInternalWidgetsFromConfig(config: UIConfig): UIConfig {
  const workspaces = config.workspaces?.map((ws) => ({
    ...ws,
    apps: stripInternalWidgetApps(ws.apps ?? []),
  }));
  const center = config.centerButton;
  const centerIsInternal =
    typeof center?.target === "string" && center.target.startsWith("internal:");
  return {
    ...config,
    workspaces: workspaces ?? config.workspaces,
    centerButton: centerIsInternal
      ? { type: "none", target: "", label: "", iconName: "Circle" }
      : center,
  };
}

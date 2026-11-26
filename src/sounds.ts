/** Sons curtos embutidos em `public/sounds`. Sem custo se o interruptor estiver off. */

export type UiSound = "click" | "shutter" | "done";

const cache = new Map<UiSound, HTMLAudioElement>();

function srcFor(name: UiSound): string {
  return new URL(`./sounds/${name}.wav`, document.baseURI).href;
}

export function playUiSound(name: UiSound): void {
  try {
    let audio = cache.get(name);
    if (!audio) {
      audio = new Audio(srcFor(name));
      audio.preload = "auto";
      audio.volume = 0.45;
      cache.set(name, audio);
    }
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  } catch {
    /* autoplay / ficheiro ausente — silêncio */
  }
}

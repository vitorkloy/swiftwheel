"use strict";

/**
 * Definições / Welcome partilham o HWND principal com a roda e a captura.
 * Esconder esse HWND sem o devolver, ou mandar keepPanel=false, fecha as Definições.
 */

function shouldKeepSettingsPanel({ panelVisible, overlayActive } = {}) {
  return !!(panelVisible || overlayActive);
}

function createMainWindowVisibilityGuard(getMainWindow) {
  let hidden = false;

  const hideForCapture = () => {
    const main = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!main || (typeof main.isDestroyed === "function" && main.isDestroyed())) return false;
    let visible = false;
    try {
      visible = typeof main.isVisible === "function" && main.isVisible();
    } catch {
      return false;
    }
    if (!visible) return false;
    try {
      main.hide();
      hidden = true;
      return true;
    } catch {
      return false;
    }
  };

  const restoreAfterCapture = () => {
    if (!hidden) return false;
    hidden = false;
    const main = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!main || (typeof main.isDestroyed === "function" && main.isDestroyed())) return false;
    try {
      if (typeof main.showInactive === "function") main.showInactive();
      else if (typeof main.show === "function") main.show();
      return true;
    } catch {
      return false;
    }
  };

  return {
    hideForCapture,
    restoreAfterCapture,
    wasHidden: () => hidden,
  };
}

module.exports = {
  shouldKeepSettingsPanel,
  createMainWindowVisibilityGuard,
};

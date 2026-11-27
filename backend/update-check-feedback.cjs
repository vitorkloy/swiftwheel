"use strict";

/**
 * Textos e estado do toast da verificação MANUAL de atualizações.
 * A verificação automática em segundo plano não usa isto — continua silenciosa.
 */

const RESULT_HIDE_MS = 2800;

function formatVersionLabel(version) {
  const raw = String(version || "").trim();
  if (!raw) return "";
  return raw.charAt(0).toLowerCase() === "v" ? raw : `v${raw}`;
}

function isOfflineError(error) {
  const msg = String(error || "").toLowerCase();
  if (!msg) return false;
  return /enotfound|eai_again|enetunreach|econnrefused|econnreset|etimedout|enetdown|ehostunreach|socket hang up|getaddrinfo|offline|not connected|internet_disconnected|name_not_resolved|network_changed|err_network|err_connection|err_address|err_internet|err_name_not|err_timed_out/.test(msg);
}

function searchingToast() {
  return { text: "Procurando atualizações…", pct: -1, hideMs: 0 };
}

function resultToast(result) {
  const payload = result && typeof result === "object" ? result : {};
  if (!payload.ok) {
    if (payload.code === "UNSUPPORTED") {
      return { text: "Atualizações só na versão instalada.", pct: 1, hideMs: RESULT_HIDE_MS };
    }
    if (payload.code === "STORE_BUILD") {
      return { text: "Esta versão é atualizada pela Microsoft Store.", pct: 1, hideMs: RESULT_HIDE_MS };
    }
    if (isOfflineError(payload.error)) {
      return { text: "Sem conexão. Tente de novo.", pct: 1, hideMs: RESULT_HIDE_MS };
    }
    return { text: "Não foi possível verificar atualizações.", pct: 1, hideMs: RESULT_HIDE_MS };
  }

  if (payload.state === "current") {
    const label = formatVersionLabel(payload.version);
    return {
      text: label ? `Você está na versão mais recente (${label})` : "Você está na versão mais recente.",
      pct: 1,
      hideMs: RESULT_HIDE_MS,
    };
  }

  const found = formatVersionLabel(payload.version);
  return {
    text: found ? `Atualização encontrada (${found})` : "Atualização encontrada.",
    pct: 1,
    hideMs: RESULT_HIDE_MS,
  };
}

/** Códigos resolvidos sem rede: o toast de procura não aparece. */
function skipSearching(result) {
  const code = result && result.code;
  return code === "UNSUPPORTED" || code === "STORE_BUILD";
}

module.exports = {
  RESULT_HIDE_MS,
  formatVersionLabel,
  isOfflineError,
  searchingToast,
  resultToast,
  skipSearching,
};

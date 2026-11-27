"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  RESULT_HIDE_MS,
  formatVersionLabel,
  isOfflineError,
  searchingToast,
  resultToast,
  skipSearching,
} = require("./update-check-feedback.cjs");

describe("update-check-feedback", () => {
  it("formata a versão com prefixo v", () => {
    assert.equal(formatVersionLabel("0.2.17"), "v0.2.17");
    assert.equal(formatVersionLabel("v0.2.17"), "v0.2.17");
    assert.equal(formatVersionLabel(""), "");
    assert.equal(formatVersionLabel(undefined), "");
  });

  it("procura com barra indeterminada e sem auto-esconder", () => {
    const view = searchingToast();
    assert.equal(view.text, "Procurando atualizações…");
    assert.equal(view.pct, -1);
    assert.equal(view.hideMs, 0);
  });

  it("diz a versão atual quando não há update", () => {
    const view = resultToast({ ok: true, state: "current", version: "0.2.17" });
    assert.equal(view.text, "Você está na versão mais recente (v0.2.17)");
    assert.equal(view.pct, 1);
    assert.equal(view.hideMs, RESULT_HIDE_MS);
    assert.ok(view.hideMs >= 2000 && view.hideMs <= 4000);
  });

  it("anuncia a versão encontrada no download e no ready", () => {
    const downloading = resultToast({ ok: true, state: "downloading", version: "0.3.0" });
    assert.equal(downloading.text, "Atualização encontrada (v0.3.0)");
    assert.equal(downloading.pct, 1);
    const ready = resultToast({ ok: true, state: "ready", version: "v0.3.1" });
    assert.equal(ready.text, "Atualização encontrada (v0.3.1)");
  });

  it("explica app não empacotada, Store, offline e erro genérico", () => {
    assert.equal(
      resultToast({ ok: false, code: "UNSUPPORTED" }).text,
      "Atualizações só na versão instalada.",
    );
    assert.equal(
      resultToast({ ok: false, code: "STORE_BUILD" }).text,
      "Esta versão é atualizada pela Microsoft Store.",
    );
    assert.equal(
      resultToast({ ok: false, code: "CHECK_FAILED", error: "net::ERR_INTERNET_DISCONNECTED" }).text,
      "Sem conexão. Tente de novo.",
    );
    assert.equal(
      resultToast({ ok: false, code: "CHECK_FAILED", error: "getaddrinfo ENOTFOUND github.com" }).text,
      "Sem conexão. Tente de novo.",
    );
    assert.equal(
      resultToast({ ok: false, code: "CHECK_FAILED", error: "Cannot parse latest.yml" }).text,
      "Não foi possível verificar atualizações.",
    );
  });

  it("não mostra a procura nos atalhos sem rede (dev / Store)", () => {
    assert.equal(skipSearching({ ok: false, code: "UNSUPPORTED" }), true);
    assert.equal(skipSearching({ ok: false, code: "STORE_BUILD" }), true);
    assert.equal(skipSearching({ ok: false, code: "CHECK_FAILED" }), false);
    assert.equal(skipSearching({ ok: true, state: "current" }), false);
  });

  it("reconhece falhas de rede do electron-updater", () => {
    assert.equal(isOfflineError("net::ERR_NAME_NOT_RESOLVED"), true);
    assert.equal(isOfflineError("ETIMEDOUT"), true);
    assert.equal(isOfflineError("Cannot find channel latest.yml"), false);
  });
});

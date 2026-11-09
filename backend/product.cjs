"use strict";

/** Nome visível do produto (janelas, bandeja, instalador, artefatos). */
const PRODUCT_NAME = "SwiftWheel";

/**
 * Identidade de upgrade no Windows. Manter iguais ao VOR 0.2.16:
 * o NSIS trata o mesmo `guid` como o mesmo produto (substitui, não instala ao lado),
 * e o `appId` mantém o AppUserModelId (bandeja, toasts, agrupamento na barra).
 */
const APP_ID = "com.vitorkloy.vor";
const NSIS_GUID = "7c2a9e14-6b21-4d0a-9f33-000000000200";

const USER_DATA_DIRNAME = "SwiftWheel";
const LEGACY_USER_DATA_DIRNAMES = ["VOR", "Zenith OS", "zenith-radial-menu"];

module.exports = {
  PRODUCT_NAME,
  APP_ID,
  NSIS_GUID,
  USER_DATA_DIRNAME,
  LEGACY_USER_DATA_DIRNAMES,
};

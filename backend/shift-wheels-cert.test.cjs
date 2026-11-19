"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const w = require("./shift-wheels.cjs");

function wrapPem(der) {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

describe("cert conversion targets", () => {
  it("classifies pfx/p12/cer/crt/der/pem as cert", () => {
    for (const ext of ["pfx", "p12", "cer", "crt", "der", "pem"]) {
      assert.equal(w.kindOf(ext), "cert", ext);
    }
  });

  it("offers PEM/CER/DER from PFX and DER↔PEM from CER", () => {
    const pfx = w.targets("cert", "pfx");
    assert.deepEqual(pfx.sort(), ["cer", "crt", "der", "pem"]);
    const pem = w.targets("cert", "pem");
    assert.ok(pem.includes("der") && pem.includes("cer") && pem.includes("crt"));
    assert.ok(!pem.includes("pem"));
    const der = w.targets("cert", "der");
    assert.ok(der.includes("pem"));
    assert.ok(!der.includes("der"));
  });
});

describe("PEM ↔ DER roundtrip", () => {
  it("writes DER and PEM beside the source without extra tools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vor-cert-"));
    try {
      const derBytes = Buffer.from("swiftwheel-cert-encoding-test-payload");
      const src = path.join(dir, "sample.pem");
      fs.writeFileSync(src, wrapPem(derBytes));
      const derPath = await w.run("conv:der", src);
      assert.match(derPath, /\.der$/);
      assert.equal(fs.readFileSync(derPath).equals(derBytes), true);
      const pemPath = await w.run("conv:pem", derPath);
      assert.match(pemPath, /\.pem$/);
      const out = fs.readFileSync(pemPath, "utf8");
      assert.match(out, /BEGIN CERTIFICATE/);
      assert.match(out, /END CERTIFICATE/);
      const cerPath = await w.run("conv:cer", src);
      assert.match(cerPath, /\.cer$/);
      assert.equal(fs.readFileSync(cerPath).equals(derBytes), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

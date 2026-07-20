import { describe, expect, it } from "vitest";
import { ingressBasePath, serverUrl } from "./serverUrl";

describe("Home Assistant Ingress-paden", () => {
  it("laat normale serverpaden ongewijzigd", () => {
    expect(serverUrl("/api/catalog", "/")).toBe("/api/catalog");
  });

  it("plaatst API-verzoeken onder het Ingress-token", () => {
    expect(serverUrl("/api/catalog", "/api/hassio_ingress/abc123/")).toBe(
      "/api/hassio_ingress/abc123/api/catalog",
    );
  });

  it("behoudt de Ingress-basis vanaf een dieper pad", () => {
    expect(ingressBasePath("/api/hassio_ingress/abc123/assets/index.js")).toBe(
      "/api/hassio_ingress/abc123/",
    );
  });
});

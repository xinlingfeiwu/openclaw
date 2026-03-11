import { describe, expect, it } from "vitest";
import {
  isMiniMaxModelNotFoundErrorMessage,
  isModelNotFoundErrorMessage,
} from "./live-model-errors.js";

describe("live model error helpers", () => {
  it("detects generic model-not-found messages", () => {
    expect(isModelNotFoundErrorMessage('{"code":404,"message":"model not found"}')).toBe(true);
    expect(isModelNotFoundErrorMessage("model: MiniMax-M2.5-highspeed not found")).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        '400 {"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}',
      ),
    ).toBe(true);
    expect(isModelNotFoundErrorMessage("400 The requested model is not supported.")).toBe(true);
    expect(isModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(false);
  });

  it("detects bare minimax 404 page-not-found responses", () => {
    expect(isMiniMaxModelNotFoundErrorMessage("404 page not found")).toBe(true);
    expect(isMiniMaxModelNotFoundErrorMessage("Error: 404 404 page not found")).toBe(true);
    expect(isMiniMaxModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(
      false,
    );
  });
});
